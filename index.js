require('dotenv').config();
const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid'); // ✅ импорт uuid
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const bodyParser = require("body-parser");
const path = require('path');

const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

admin.initializeApp({
  credential: admin.credential.cert(require("./serviceAccountKey.json")),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

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
const s3 = new S3Client({
  region: "ru-central1",
  endpoint: "https://storage.yandexcloud.net",
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY_ID,
    secretAccessKey: process.env.YC_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = 'teremok';
const upload = multer({ dest: 'uploads/' });

// ✅ Функция загрузки base64-изображения
async function uploadToS3(buffer, fileName, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read'
  }));
  return `https://storage.yandexcloud.net/${BUCKET_NAME}/${fileName}`;
}

async function deleteFromS3(urls) {
  const keys = urls
    .map(url => {
      const key = url.split(`${BUCKET_NAME}/`)[1];
      return key ? { Key: key } : null;
    })
    .filter(Boolean);

  if (keys.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: keys }
    }));
  }
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


// ===== Добавление новости =====
app.post('/addNews', upload.fields([
  { name: 'images', maxCount: 5 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, description, groupId, authorId } = req.body;
    const images = req.files['images'] || [];
    const video = req.files['video']?.[0];

    if (!title || !description || !groupId || !authorId) {
      return res.status(400).json({ error: 'Обязательные поля отсутствуют' });
    }

    if (images.length === 0 || images.length > 5) {
      return res.status(400).json({ error: 'Разрешено от 1 до 5 изображений' });
    }

    const newsId = uuidv4();
    const timestamp = Date.now();

    const imageUrls = await Promise.all(images.map((file, index) => {
      const ext = path.extname(file.originalname);
      const fileName = `${newsId}_${index}${ext}`;
      return uploadToS3(file.buffer, fileName, file.mimetype);
    }));

    let videoUrl = null;
    if (video) {
      const ext = path.extname(video.originalname);
      const fileName = `${newsId}_video${ext}`;
      videoUrl = await uploadToS3(video.buffer, fileName, video.mimetype);
    }

    const newsData = {
      title,
      description,
      imageUrls,
      timestamp,
      authorId
    };
    if (videoUrl) newsData.videoUrl = videoUrl;

    await db.ref(`news/${groupId}/${newsId}`).set(newsData);

    res.status(200).json({ success: true, newsId, imageUrls, videoUrl });
  } catch (error) {
    console.error('Ошибка при добавлении новости:', error);
    res.status(500).json({ error: error.message });
  }
});


// ===== Редактирование новости =====
app.post('/editNews', upload.fields([
  { name: 'newImages', maxCount: 5 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  try {
    const { groupId, newsId, authorId, title, description } = req.body;
    const imagesToKeep = JSON.parse(req.body.imagesToKeep || '[]');

    const newImages = req.files['newImages'] || [];
    const videoFile = req.files['video']?.[0];

    if (!groupId || !newsId || !authorId) {
      return res.status(400).json({ error: 'groupId, newsId и authorId обязательны' });
    }

    const ref = db.ref(`news/${groupId}/${newsId}`);
    const snapshot = await ref.once('value');
    const existing = snapshot.val();

    if (!existing) return res.status(404).json({ error: 'Новость не найдена' });
    if (existing.authorId !== authorId) return res.status(403).json({ error: 'Нет прав на редактирование' });

    const deletedImages = (existing.imageUrls || []).filter(url => !imagesToKeep.includes(url));
    await deleteFromS3(deletedImages);

    const newImageUrls = await Promise.all(newImages.map((file, index) => {
      const ext = path.extname(file.originalname);
      const fileName = `${newsId}_new_${index}${ext}`;
      return uploadToS3(file.buffer, fileName, file.mimetype);
    }));

    let videoUrl = existing.videoUrl || null;
    if (videoFile) {
      if (videoUrl) await deleteFromS3([videoUrl]);
      const ext = path.extname(videoFile.originalname);
      const fileName = `${newsId}_video${ext}`;
      videoUrl = await uploadToS3(videoFile.buffer, fileName, videoFile.mimetype);
    } else if (!req.body.video && videoUrl) {
      await deleteFromS3([videoUrl]);
      videoUrl = null;
    }

    const updated = {
      title: title || existing.title,
      description: description || existing.description,
      imageUrls: [...imagesToKeep, ...newImageUrls],
      timestamp: Date.now(),
      authorId
    };
    if (videoUrl) updated.videoUrl = videoUrl;

    await ref.update(updated);
    res.status(200).json({ success: true, newsId, imageUrls: updated.imageUrls, videoUrl });

  } catch (error) {
    console.error('Ошибка при редактировании:', error);
    res.status(500).json({ error: error.message });
  }
});



// ===== Удаление новости =====
app.post('/deleteNews', express.json(), async (req, res) => {
  try {
    const { groupId, newsId, authorId } = req.body;

    const ref = db.ref(`news/${groupId}/${newsId}`);
    const snapshot = await ref.once('value');
    const data = snapshot.val();

    if (!data) return res.status(404).json({ error: 'Новость не найдена' });
    if (data.authorId !== authorId) return res.status(403).json({ error: 'Нет прав на удаление' });

    const urls = [...(data.imageUrls || []), data.videoUrl].filter(Boolean);
    await deleteFromS3(urls);
    await ref.remove();

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении новости:', error);
    res.status(500).json({ error: error.message });
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
