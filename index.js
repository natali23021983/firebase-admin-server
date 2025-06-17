require('dotenv').config();
const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const bodyParser = require("body-parser");
const path = require('path');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");


const app = express();
app.use(cors());
app.use(bodyParser.json());

// Multer для загрузки в память
const upload = multer({ storage: multer.memoryStorage() });

// === Firebase Admin SDK ===
try{
    const base64 = process.env.FIREBASE_CONFIG;
    if (!base64) throw new Error("FIREBASE_CONFIG переменная не найдена в .env");
    const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL
    });
    console.log("✅ Firebase инициализирован");

} catch (err) {
  console.error("🔥 Ошибка инициализации Firebase:", err);
}


const db = admin.database();
const auth = admin.auth();

// === Яндекс S3 ===
const s3 = new S3Client({
  region: process.env.YC_S3_REGION || "ru-central1",
  endpoint: process.env.YC_S3_ENDPOINT || "https://storage.yandexcloud.net",
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY,
    secretAccessKey: process.env.YC_SECRET_KEY,
  },
});
const BUCKET_NAME = process.env.YC_S3_BUCKET;
console.log("BUCKET_NAME:", process.env.YC_S3_BUCKET);



// === Middleware проверки Firebase-токена ===
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

  if (!token) {
    console.warn("🚫 verifyToken: отсутствует заголовок Authorization");
    return res.status(401).send("Нет токена");
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    console.log("✅ verifyToken: токен валиден, uid:", decoded.uid);
    next();
  } catch (err) {
    console.error("❌ verifyToken: токен недействителен или истёк", err);
    res.status(403).send("Неверный токен");
  }
}


// === Утилиты S3-загрузки/удаления ===
async function uploadToS3(buffer, fileName, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read'
  }));
  return `https://${BUCKET_NAME}.storage.yandexcloud.net/${fileName}`;
}

async function deleteFromS3(urls) {
  const keys = urls.map(url => {
    const parts = url.split(`${BUCKET_NAME}/`);
    return parts[1] ? { Key: parts[1] } : null;
  }).filter(Boolean);

  if (keys.length === 0) return;
  await s3.send(new DeleteObjectsCommand({
    Bucket: BUCKET_NAME,
    Delete: { Objects: keys }
  }));
}

// === Удаление пользователя/ребёнка ===
app.post('/deleteUserByName', async (req, res) => {
  const fullName = req.body.fullName?.trim().toLowerCase();
  if (!fullName) return res.status(400).send("fullName обязателен");

  try {
    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};

    for (const [userId, user] of Object.entries(users)) {
      const name = user.name?.trim().toLowerCase();
      const role = user.role?.trim().toLowerCase();

      // Родитель
      if (name === fullName && role === 'родитель') {
        if (user.children) {
          for (const child of Object.values(user.children)) {
            const groupId = child.group;
            if (groupId) {
              const gcRef = db.ref(`groups/${groupId}/children`);
              const gcSnap = await gcRef.once('value');
              const gc = gcSnap.val() || {};
              for (const [gcId, full] of Object.entries(gc)) {
                if (full === child.fullName) {
                  await gcRef.child(gcId).remove();
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

      // Педагог
      if (name === fullName && role === 'педагог') {
        const groupsSnap = await db.ref('groups').once('value');
        const groups = groupsSnap.val() || {};
        for (const [groupId, group] of Object.entries(groups)) {
          if (group.teachers?.[userId]) {
            await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
          }
        }
        await db.ref(`users/${userId}`).remove();
        await auth.deleteUser(userId);
        return res.send("Педагог удалён.");
      }

      // Ребёнок
      if (user.children) {
        for (const [childId, child] of Object.entries(user.children)) {
          if (child.fullName?.trim().toLowerCase() === fullName) {
            const groupId = child.group;
            if (groupId) {
              const gcRef = db.ref(`groups/${groupId}/children`);
              const gcSnap = await gcRef.once('value');
              const gc = gcSnap.val() || {};
              for (const [gcId, full] of Object.entries(gc)) {
                if (full === child.fullName) {
                  await gcRef.child(gcId).remove();
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

    res.status(404).send("Пользователь не найден.");
  } catch (err) {
    console.error("Ошибка при deleteUserByName:", err);
    res.status(500).send("Ошибка при удалении.");
  }
});

// === Обновление email ===
app.post("/update-user", async (req, res) => {
  try {
    const { fullName, newEmail } = req.body;
    if (!fullName || !newEmail) return res.status(400).json({ error: "fullName и newEmail обязательны" });

    const snap = await db.ref("users").orderByChild("name").equalTo(fullName).once("value");
    if (!snap.exists()) return res.status(404).json({ error: "Пользователь не найден" });

    const users = snap.val();
    const keys = Object.keys(users);
    if (keys.length > 1) return res.status(400).json({ error: "Найдено несколько пользователей с таким именем" });

    const userKey = keys[0];
    const user = users[userKey];
    const userId = user.userId;
    if (!userId) return res.status(400).json({ error: "userId не найден в базе" });

    await auth.updateUser(userId, { email: newEmail });
    await db.ref(`users/${userKey}`).update({ email: newEmail });

    res.json({ message: "Email обновлен", userId, updatedUser: { name: fullName, email: newEmail } });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: "Email уже используется" });
    }
    console.error("Ошибка update-user:", err);
    res.status(500).json({ error: "Ошибка сервера: " + err.message });
  }
});



app.post("/news", verifyToken, async (req, res) => {
  console.log("📩 /news endpoint hit");

  try {
    const { groupId, newsId, title, description, authorId, images, video } = req.body;
    console.log("🧾 Body:", req.body);
    console.log("👤 Author ID:", authorId);

    if (!groupId || !title || !description || !authorId) {
      return res.status(400).json({ error: "Обязательные поля: groupId, title, description, authorId" });
    }

    const isEdit = Boolean(newsId);
    const targetNewsId = isEdit ? newsId : uuidv4();
    const timestamp = Date.now();

    let existing = null;
    if (isEdit) {
      const snap = await db.ref(`news/${groupId}/${targetNewsId}`).once("value");
      existing = snap.val();

      if (!existing) {
        return res.status(404).json({ error: "Новость не найдена" });
      }
      if (existing.authorId !== authorId) {
        return res.status(403).json({ error: "Нет прав на редактирование" });
      }

      // Удаляем старые медиа, которых нет в новых
      const oldMedia = [...(existing.imageUrls || []), existing.videoUrl].filter(Boolean);
      const keepMedia = [...(images || []), video].filter(Boolean);
      const toDelete = oldMedia.filter(url => !keepMedia.includes(url));
      if (toDelete.length) {
        console.log("🗑 Удаление из S3:", toDelete);
        await deleteFromS3(toDelete);
      }
    }

    // Финальный объект
    const newsData = {
      title,
      description,
      authorId,
      timestamp,
      imageUrls: images || [],
    };

    if (video) {
      newsData.videoUrl = video;
    }

    await db.ref(`news/${groupId}/${targetNewsId}`).set(newsData);

    console.log("✅ Новость успешно сохранена");

    res.status(isEdit ? 200 : 201).json({
      success: true,
      newsId: targetNewsId,
      imageUrls: newsData.imageUrls,
      videoUrl: newsData.videoUrl || null
    });

  } catch (err) {
    console.error("❌ Ошибка /news:", err);
    res.status(500).json({ error: err.message });
  }
});



// === Удаление новости ===
app.post("/deleteNews", verifyToken, async (req, res) => {
  try {
    const { groupId, newsId } = req.body;
    const authorId = req.user.uid;

    if (!groupId || !newsId) {
      return res.status(400).json({ error: "groupId и newsId обязательны" });
    }

    const snap = await db.ref(`news/${groupId}/${newsId}`).once('value');
    const data = snap.val();
    if (!data) return res.status(404).json({ error: "Новость не найдена" });
    if (data.authorId !== authorId) return res.status(403).json({ error: "Нет прав" });

    const urls = [...(data.imageUrls || []), data.videoUrl].filter(Boolean);
    await deleteFromS3(urls);
    await db.ref(`news/${groupId}/${newsId}`).remove();

    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка deleteNews:", err);
    res.status(500).json({ error: err.message });
  }
});


// === Генерация signed URL для прямой загрузки в S3 ===
app.post('/generate-upload-url', verifyToken, async (req, res) => {
  console.log('=== /generate-upload-url: запрос получен');
  try {
    const { fileName, fileType, groupId } = req.body;
    console.log('Тело запроса:', req.body);

    if (!fileName || !fileType || !groupId) {
      console.log('Ошибка: отсутствуют обязательные поля');
      return res.status(400).json({ error: "fileName, fileType и groupId обязательны" });
    }

    const key = `news/${groupId}/${Date.now()}_${fileName}`;
    console.log('Генерируем ключ для файла:', key);

    const contentType = String(fileType); // Принудительно строкой

    const signedUrlParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType
    };

    console.log('ContentType, который будет передан:', contentType);

    const command = new PutObjectCommand(signedUrlParams);

    console.log('Вызов getSignedUrl...');

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    console.log('Signed URL получен:', uploadUrl);

    const fileUrl = `https://${BUCKET_NAME}.storage.yandexcloud.net/${key}`;

    res.json({ uploadUrl, fileUrl });
    console.log('Ответ отправлен');
  } catch (err) {
    console.error("Ошибка генерации upload URL:", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});


// === Проверка сервера ===
app.get("/", (req, res) => res.send("Server is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
