require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const AWS = require('aws-sdk');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid'); // ✅ импорт uuid
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' })); // для base64 изображений
app.use(express.urlencoded({ extended: true }));

// ===== Firebase Admin SDK =====
const base64 = process.env.FIREBASE_CONFIG;
if (!base64) {
  throw new Error("FIREBASE_CONFIG переменная не найдена в .env");
}
const decoded = Buffer.from(base64, 'base64').toString('utf8');
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://teremok-1a3ff-default-rtdb.firebaseio.com"
});

const db = admin.database();
const auth = admin.auth();

// ===== S3 (Yandex Cloud) =====
const s3 = new AWS.S3({
  endpoint: 'https://storage.yandexcloud.net',
  accessKeyId: process.env.YC_ACCESS_KEY,
  secretAccessKey: process.env.YC_SECRET_KEY,
  region: 'ru-central1'
});

const BUCKET_NAME = 'teremok';
const upload = multer({ dest: 'uploads/' });

// ✅ Функция загрузки base64-изображения
async function uploadImage(base64Data, fileName) {
  const buffer = Buffer.from(base64Data, 'base64');

  const params = {
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ContentEncoding: 'base64',
    ContentType: 'image/jpeg',
    ACL: 'public-read'
  };

  const data = await s3.upload(params).promise();
  return data.Location;
}

// ===== Удаление пользователя/ребёнка =====
app.post('/deleteUserByName', async (req, res) => {
  const fullName = req.body.fullName;
  if (!fullName) return res.status(400).send("fullName обязателен");

  try {
    const usersSnapshot = await db.ref('users').once('value');
    const users = usersSnapshot.val();

    let found = false;

    for (const userId in users) {
      const user = users[userId];

      // === Родитель ===
      if (
        user.name?.trim().toLowerCase() === fullName.trim().toLowerCase() &&
        user.role?.trim().toLowerCase() === 'родитель'
      ) {
        found = true;

        if (user.children) {
          for (const childId in user.children) {
            const child = user.children[childId];
            const groupId = child.group;
            if (groupId) {
              const groupChildrenRef = db.ref(`groups/${groupId}/children`);
              const groupChildrenSnap = await groupChildrenRef.once('value');
              const groupChildren = groupChildrenSnap.val();

              for (const gcId in groupChildren) {
                if (groupChildren[gcId] === child.fullName) {
                  await groupChildrenRef.child(gcId).remove();
                  break;
                }
              }
            }
          }
        }

        await db.ref(`users/${userId}`).remove();
        await auth.deleteUser(userId);
        return res.send("Родитель и его дети удалены.");
      }

      // === Педагог ===
      if (
        user.name?.trim().toLowerCase() === fullName.trim().toLowerCase() &&
        user.role?.trim().toLowerCase() === 'педагог'
      ) {
        found = true;

        const groupsSnapshot = await db.ref('groups').once('value');
        const groups = groupsSnapshot.val();

        for (const groupId in groups) {
          if (groups[groupId].teachers?.[userId]) {
            await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
          }
        }

        await db.ref(`users/${userId}`).remove();
        await auth.deleteUser(userId);
        return res.send("Педагог удалён.");
      }

      // === Ребёнок ===
      if (user.children) {
        for (const childId in user.children) {
          const child = user.children[childId];
          if (child.fullName?.trim().toLowerCase() === fullName.trim().toLowerCase()) {
            found = true;

            if (child.group) {
              const groupChildrenRef = db.ref(`groups/${child.group}/children`);
              const groupChildrenSnap = await groupChildrenRef.once('value');
              const groupChildren = groupChildrenSnap.val();

              for (const gcId in groupChildren) {
                if (groupChildren[gcId] === child.fullName) {
                  await groupChildrenRef.child(gcId).remove();
                  break;
                }
              }
            }

            await db.ref(`users/${userId}/children/${childId}`).remove();
            return res.send("Ребёнок удалён.");
          }
        }
      }
    }

    if (!found) {
      return res.status(404).send("Пользователь не найден.");
    }

  } catch (error) {
    console.error("Ошибка при удалении пользователя:", error);
    return res.status(500).send("Ошибка при удалении.");
  }
});

// ===== Обновление Email =====
app.post("/update-user", async (req, res) => {
  try {
    const { fullName, newEmail } = req.body;

    if (!fullName || !newEmail) {
      return res.status(400).json({ error: "fullName и newEmail обязательны" });
    }

    const snapshot = await db.ref("users").orderByChild("name").equalTo(fullName).once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const users = snapshot.val();
    const keys = Object.keys(users);

    if (keys.length > 1) {
      return res.status(400).json({ error: "Найдено несколько пользователей с таким именем" });
    }

    const userKey = keys[0];
    const userData = users[userKey];
    const userId = userData.userId;

    if (!userId) {
      return res.status(400).json({ error: "userId не найден в базе" });
    }

    await auth.updateUser(userId, { email: newEmail });
    await db.ref(`users/${userKey}`).update({ email: newEmail });

    return res.json({
      message: "Email обновлен в базе и авторизации",
      userId,
      updatedUser: { name: fullName, email: newEmail }
    });

  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: "Такой email уже используется другим аккаунтом" });
    }
    return res.status(500).json({ error: "Ошибка сервера: " + error.message });
  }
});

// ===== Загрузка файла (через multipart/form-data) =====
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('Файл не загружен');

  const fileContent = fs.readFileSync(req.file.path);
  const fileName = Date.now() + '-' + path.basename(req.file.originalname);

  const params = {
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: fileContent,
    ContentType: req.file.mimetype,
    ACL: 'public-read'
  };

  s3.upload(params, (err, data) => {
    fs.unlinkSync(req.file.path);
    if (err) return res.status(500).send('Ошибка загрузки файла');
    res.json({ url: data.Location });
  });
});

// ===== Добавление новости =====
app.post('/addNews', async (req, res) => {
  try {
    const { title, description, groupId, authorId, imageBase64 } = req.body;

    const newsId = uuidv4();
    const fileName = `${newsId}.jpg`;
    const imageUrl = await uploadImage(imageBase64, fileName);
    const timestamp = Date.now();

    await db.ref(`news/${groupId}/${newsId}`).set({
      title,
      description,
      imageUrl,
      timestamp,
      authorId
    });

    res.status(200).json({ success: true, newsId });
  } catch (error) {
    console.error('Ошибка при добавлении новости:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Удаление новости =====
app.post('/deleteNews', async (req, res) => {
  try {
    const { groupId, newsId, authorId } = req.body;
    const newsRef = db.ref(`news/${groupId}/${newsId}`);
    const snapshot = await newsRef.once('value');
    const news = snapshot.val();

    if (!news) return res.status(404).json({ error: 'Новость не найдена' });
    if (news.authorId !== authorId) return res.status(403).json({ error: 'Нет прав на удаление' });

    await newsRef.remove();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении новости:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Проверка сервера =====
app.get("/", (req, res) => {
  res.send("Сервер работает");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
