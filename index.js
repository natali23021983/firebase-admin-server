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

// === Конфигурация CORS ===
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// === Multer с лимитами ===
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 5
  }
});

// === MIME types mapping ===
const mimeTypeMapping = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'text/plain': '.txt',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav'
};

// === Firebase Admin SDK инициализация с проверками ===
let firebaseInitialized = false;
let db = null;
let auth = null;

try {
  const base64 = process.env.FIREBASE_CONFIG;
  if (!base64) {
    console.error("❌ FIREBASE_CONFIG переменная не найдена в .env");
    process.exit(1);
  }

  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
  });

  db = admin.database();
  auth = admin.auth();
  firebaseInitialized = true;
  console.log("✅ Firebase инициализирован");

} catch (err) {
  console.error("🔥 Критическая ошибка инициализации Firebase:", err);
  process.exit(1);
}

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

if (!BUCKET_NAME) {
  console.error("❌ YC_S3_BUCKET не настроен");
  process.exit(1);
}

console.log("✅ S3 клиент инициализирован, bucket:", BUCKET_NAME);


// === Middleware логирования ===
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`📥 ${req.method} ${req.path} - ${new Date().toISOString()}`);

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`📤 ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });

  next();
});


// === Middleware проверки Firebase-токена ===
async function verifyToken(req, res, next) {
  if (!firebaseInitialized) {
    return res.status(503).json({ error: "Сервис временно недоступен" });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

  if (!token) {
    console.warn("🚫 verifyToken: отсутствует заголовок Authorization");
    return res.status(401).json({ error: "Токен не предоставлен" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    console.log("✅ verifyToken: токен валиден, uid:", decoded.uid);
    next();
  } catch (err) {
    console.error("❌ verifyToken: токен недействителен или истёк", err);
    res.status(403).json({ error: "Неверный или просроченный токен" });
  }
}


// === Утилиты S3-загрузки/удаления с обработкой ошибок ===
async function uploadToS3(buffer, fileName, contentType) {
  try {
    console.log(`📤 Загрузка файла в S3: ${fileName}`);

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read'
    }));

    const fileUrl = `https://${BUCKET_NAME}.storage.yandexcloud.net/${fileName}`;
    console.log(`✅ Файл загружен: ${fileUrl}`);

    return fileUrl;
  } catch (error) {
    console.error(`❌ Ошибка загрузки в S3: ${fileName}`, error);
    throw new Error(`Ошибка загрузки файла: ${error.message}`);
  }
}

async function deleteFromS3(urls) {
  if (!urls || urls.length === 0) return;

  try {
    const keys = urls.map(url => {
      const parts = url.split(`${BUCKET_NAME}/`);
      return parts[1] ? { Key: parts[1] } : null;
    }).filter(Boolean);

    if (keys.length === 0) {
      console.log("⚠️ Нет валидных URL для удаления");
      return;
    }

    console.log(`🗑️ Удаление файлов из S3: ${keys.length} файлов`);

    await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: keys }
    }));

    console.log(`✅ Файлы удалены из S3`);
  } catch (error) {
    console.error("❌ Ошибка удаления из S3:", error);
    throw new Error(`Ошибка удаления файлов: ${error.message}`);
  }
}

// === Удаление пользователя/ребёнка ===
app.post('/deleteUserByName', async (req, res) => {
  try {
    const fullName = req.body.fullName?.trim().toLowerCase();
    if (!fullName) {
      return res.status(400).json({ error: "fullName обязателен" });
    }

    console.log(`🗑️ Запрос на удаление пользователя: ${fullName}`);

    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};
    let found = false;

    for (const [userId, user] of Object.entries(users)) {
      const name = user.name?.trim().toLowerCase();
      const role = user.role?.trim().toLowerCase();

      // Родитель
      if (name === fullName && role === 'родитель') {
        found = true;
        console.log(`👨‍👩‍👧‍👦 Найден родитель для удаления: ${userId}`);

        // 1. Удаляем детей из групп и S3
        if (user.children) {
          const filesToDelete = [];

          for (const [childId, child] of Object.entries(user.children)) {
            // Удаляем из группы по childId
            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
              console.log(`✅ Ребенок удален из группы: ${child.group}`);
            }

            // Собираем файлы для удаления из S3
            if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
          }

          // Удаляем файлы из S3
          if (filesToDelete.length > 0) {
            await deleteFromS3(filesToDelete);
          }
        }

        // 2. Удаляем пользователя из базы
        await db.ref(`users/${userId}`).remove();

        // 3. Удаляем из Firebase Auth (с проверкой)
        try {
          await auth.getUser(userId);
          await auth.deleteUser(userId);
          console.log(`✅ Пользователь удален из Auth: ${userId}`);
        } catch (authError) {
          console.log("ℹ️ Пользователь не найден в Auth, пропускаем:", authError.message);
        }

        return res.json({ success: true, message: "Родитель и его дети удалены." });
      }

      // Педагог
      if (name === fullName && role === 'педагог') {
        found = true;
        console.log(`👨‍🏫 Найден педагог для удаления: ${userId}`);

        // Удаляем из всех групп
        const groupsSnap = await db.ref('groups').once('value');
        const groups = groupsSnap.val() || {};

        for (const [groupId, group] of Object.entries(groups)) {
          if (group.teachers?.[userId]) {
            await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
            console.log(`✅ Педагог удален из группы: ${groupId}`);
          }
        }

        // Удаляем пользователя
        await db.ref(`users/${userId}`).remove();

        try {
          await auth.getUser(userId);
          await auth.deleteUser(userId);
          console.log(`✅ Педагог удален из Auth: ${userId}`);
        } catch (authError) {
          console.log("ℹ️ Педагог не найден в Auth:", authError.message);
        }

        return res.json({ success: true, message: "Педагог удалён." });
      }

      // Отдельный ребенок (поиск ребенка по имени)
      if (user.children) {
        for (const [childId, child] of Object.entries(user.children)) {
          if (child.fullName?.trim().toLowerCase() === fullName) {
            found = true;
            console.log(`👶 Найден ребенок для удаления: ${childId}`);

            // Удаляем из группы
            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
              console.log(`✅ Ребенок удален из группы: ${child.group}`);
            }

            // Удаляем файлы ребенка из S3
            const filesToDelete = [];
            if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
            if (filesToDelete.length > 0) {
              await deleteFromS3(filesToDelete);
            }

            // Удаляем ребенка из пользователя
            await db.ref(`users/${userId}/children/${childId}`).remove();

            return res.json({ success: true, message: "Ребёнок удалён." });
          }
        }
      }
    }

    if (!found) {
      console.log("❌ Пользователь не найден:", fullName);
      return res.status(404).json({ error: "Пользователь не найден." });
    }
  } catch (err) {
    console.error("❌ Ошибка при deleteUserByName:", err);
    res.status(500).json({ error: "Ошибка при удалении: " + err.message });
  }
});


// === endpoint для удаления только ребенка ===
app.post('/deleteChild', async (req, res) => {
  try {
    const { userId, childId } = req.body;

    if (!userId || !childId) {
      return res.status(400).json({ error: "userId и childId обязательны" });
    }

    console.log('🗑️ Запрос на удаление ребенка:', { userId, childId });

    // 1. Получаем данные ребенка
    const childRef = db.ref(`users/${userId}/children/${childId}`);
    const childSnap = await childRef.once('value');

    if (!childSnap.exists()) {
      return res.status(404).json({ error: "Ребенок не найден" });
    }

    const child = childSnap.val();
    const groupName = child.group;
    const childName = child.fullName.trim();

    console.log('👶 Удаление ребенка:', childName, 'Группа:', groupName);

    // 2. Находим ID группы по названию
    let groupId = null;
    if (groupName) {
      console.log('🔍 Ищем ID группы по названию:', groupName);

      const groupsRef = db.ref('groups');
      const groupsSnap = await groupsRef.once('value');
      const groups = groupsSnap.val() || {};

      console.log('Все группы:', JSON.stringify(groups, null, 2));

      for (const [id, groupData] of Object.entries(groups)) {
             if (groupData.name === groupName) {
               groupId = id;
               console.log('✅ Найдена группа ID:', groupId);
               break;
             }
      }


      if (!groupId) {
        console.log('❌ Группа не найдена по названию:', groupName);
        return res.status(404).json({ error: "Группа не найдена" });
      }
    }

    // 3. Удаляем ребенка из группы
    console.log('🔍 Ищем ребенка в группе ID:', groupId);

    if (groupId) {
       const groupChildrenRef = db.ref(`groups/${groupId}/children`);
       const groupChildrenSnap = await groupChildrenRef.once('value');
       const groupChildren = groupChildrenSnap.val() || {};

       // Ищем ребенка по имени в группе
       let foundGroupChildId = null;
       for (const [groupChildId, groupChildName] of Object.entries(groupChildren)) {
          if (groupChildName.trim() === childName) {
              foundGroupChildId = groupChildId;
              break;
          }
       }

        console.log('👥 Дети в группе:', JSON.stringify(groupChildren, null, 2));

        if (foundGroupChildId) {
            console.log('🗑️ Удаляем ребенка из группы');
            await groupChildrenRef.child(foundGroupChildId).remove();
            console.log('✅ Ребенок удален из группы');
        } else {
            console.log('❌ Ребенок не найден в группе');
            return res.status(404).json({ error: "Ребенок не найден в группе" });
        }
    }

    // 4. Удаляем файлы из S3
    const filesToDelete = [];
    if (child.avatarUrl) {
      filesToDelete.push(child.avatarUrl);
    }

    if (filesToDelete.length > 0) {
      await deleteFromS3(filesToDelete);
    }

    // 5. Удаляем ребенка из базы родителя
    console.log('🗑️ Удаляем ребенка из базы пользователя');
    await childRef.remove();

    console.log('✅ Ребенок полностью удален');

    res.json({
      success: true,
      message: `Ребенок ${childName} успешно удален`
    });

  } catch (err) {
    console.error('❌ Ошибка при deleteChild:', err);
    res.status(500).json({ error: "Ошибка при удалении ребенка: " + err.message });
  }
});

// === Обновление email ===
app.post("/update-user", async (req, res) => {
  try {
    const { fullName, newEmail } = req.body;
    if (!fullName || !newEmail) {
        return res.status(400).json({ error: "fullName и newEmail обязательны" });
    }

    console.log(`✏️ Запрос на обновление email: ${fullName} -> ${newEmail}`);

    const snap = await db.ref("users").orderByChild("name").equalTo(fullName).once("value");
    if (!snap.exists()) {
        return res.status(404).json({ error: "Пользователь не найден" });
    }

    const users = snap.val();
    const keys = Object.keys(users);
    if (keys.length > 1) {
        return res.status(400).json({ error: "Найдено несколько пользователей с таким именем" });
    }

    const userKey = keys[0];
    const user = users[userKey];
    const userId = user.userId;

    if (!userId) {
        return res.status(400).json({ error: "userId не найден в базе" });
    }

    await auth.updateUser(userId, { email: newEmail });
    await db.ref(`users/${userKey}`).update({ email: newEmail });

    console.log(`✅ Email обновлен для пользователя: ${userId}`);

    res.json({
          success: true,
          message: "Email обновлен",
          userId,
          updatedUser: { name: fullName, email: newEmail }
        });
      } catch (err) {
        console.error("❌ Ошибка update-user:", err);

        if (err.code === 'auth/email-already-exists') {
          return res.status(400).json({ error: "Email уже используется" });
        }

        res.status(500).json({ error: "Ошибка сервера: " + err.message });
      }
    });

// === Добавление и редактирование новости (через ссылки) ===

app.post("/news", verifyToken, async (req, res) => {
  try {
    const { newsId, groupId, title, description, mediaUrls = [] } = req.body;
    const authorId = req.user.uid;

    if (!groupId || !title || !description) {
      return res.status(400).json({ error: "groupId, title и description обязательны" });
    }

    console.log(`📰 ${newsId ? 'Редактирование' : 'Создание'} новости для группы: ${groupId}`);

    if (newsId) {
      // === Редактирование ===
      const ref = db.ref(`news/${groupId}/${newsId}`);
      const snap = await ref.once("value");
      const oldNews = snap.val();
      if (!oldNews) {
        return res.status(404).json({ error: "Новость не найдена" });
      }

      if (oldNews.authorId !== authorId) {
        return res.status(403).json({ error: "Нет прав на редактирование" });
      }

      // Удаляем из S3 те, которых больше нет
      const oldUrls = oldNews.mediaUrls || [];
      const keepSet = new Set(mediaUrls);
      const toDelete = oldUrls.filter(url => !keepSet.has(url));

      if (toDelete.length > 0) {
        await deleteFromS3(toDelete);
      }

      const newData = {
        title,
        description,
        mediaUrls,
        authorId,
        timestamp: Date.now(),
      };

      await ref.update(newData);
      console.log(`✅ Новость отредактирована: ${newsId}`);

      return res.json({ success: true, updated: true });
    }

    // === Добавление новости ===
    const id = uuidv4();
    const ref = db.ref(`news/${groupId}/${id}`);

    const data = {
      title,
      description,
      mediaUrls,
      timestamp: Date.now(),
      authorId
    };

    await ref.set(data);
    console.log(`✅ Новость создана: ${id}`);

    return res.json({ success: true, id });

  } catch (err) {
    console.error("Ошибка POST /news:", err);
    res.status(500).json({ error: err.message });
  }
});


// === Получение списка новостей по groupId ===
app.get("/news", verifyToken, async (req, res) => {
  try {
    const groupId = req.query.groupId;
    if (!groupId) {
      return res.status(400).json({ error: "groupId обязателен" });
    }

    console.log(`📖 Получение новостей для группы: ${groupId}`);

    const snap = await db.ref(`news/${groupId}`).once("value");
    const newsData = snap.val() || {};

    const newsList = Object.entries(newsData).map(([id, news]) => ({
      id,
      title: news.title,
      description: news.description,
      groupId: groupId,
      authorId: news.authorId,
      mediaUrls: news.mediaUrls || [],
      timestamp: news.timestamp || 0
    }));

    newsList.sort((a, b) => b.timestamp - a.timestamp);

    console.log(`✅ Получено новостей: ${newsList.length}`);

    res.json(newsList);
  } catch (err) {
    console.error("Ошибка GET /news:", err);
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

    console.log(`🗑️ Удаление новости: ${newsId} из группы: ${groupId}`);

    const snap = await db.ref(`news/${groupId}/${newsId}`).once('value');
    const data = snap.val();

    if (!data) {
        return res.status(404).json({ error: "Новость не найдена" });
    }

    if (data.authorId !== authorId) {
        return res.status(403).json({ error: "Нет прав" });
    }

    const urls = data.mediaUrls || [];
    if (urls.length > 0) {
      await deleteFromS3(urls);
    }

    await db.ref(`news/${groupId}/${newsId}`).remove();

    console.log(`✅ Новость удалена: ${newsId}`);

    res.json({ success: true });
  } catch (err) {
    console.error("Ошибка deleteNews:", err);
    res.status(500).json({ error: err.message });
  }
});



// === Генерация signed URL для прямой загрузки в S3 ===
app.post('/generate-upload-url', verifyToken, async (req, res) => {
  console.log('=== /generate-upload-url: запрос получен');
  console.log('Тело запроса:', JSON.stringify(req.body, null, 2));

  try {
    const { fileName, fileType, groupId, isPrivateChat, context } = req.body;

    // Валидация обязательных полей
    if (!fileName || !fileType) {
      console.log('Ошибка: отсутствуют обязательные поля fileName или fileType');
      return res.status(400).json({ error: "fileName и fileType обязательны" });
    }

    // Определяем правильное расширение файла
    const fileExtension = getFileExtension(fileType);
    let finalFileName = fileName;

    // Если у файла нет расширения или оно неправильное - добавляем правильное
    if (!finalFileName.includes('.') || !finalFileName.toLowerCase().endsWith(fileExtension.toLowerCase())) {
      // Убираем существующее расширение если есть
      const baseName = finalFileName.includes('.')
        ? finalFileName.substring(0, finalFileName.lastIndexOf('.'))
        : finalFileName;

      finalFileName = baseName + fileExtension;
      console.log('Скорректированное имя файла:', finalFileName);
    }


    // Определяем тип контента и папку для сохранения
    let folder;
    let finalGroupId = groupId;

    if (context === 'news') {
      // Для новостей
      folder = 'news/';
      console.log('Тип: новость');
    } else if (isPrivateChat === true) {
      folder = 'private-chats/';
      console.log('Тип: приватный чат (по флагу isPrivateChat)');
    } else if (groupId && groupId.startsWith('private_')) {
      folder = 'private-chats/';
      finalGroupId = groupId.replace('private_', '');
      console.log('Тип: приватный чат (legacy format)');
    } else if (groupId) {
      folder = 'group-chats/';
      console.log('Тип: групповой чат');
    } else {
      folder = 'misc/';
      console.log('Тип: прочее (без контекста)');
    }


    // Проверяем доступ пользователя к группе (если это групповой/приватный чат)
    if (finalGroupId && folder !== 'news/') {
      const hasAccess = await checkChatAccess(req.user.uid, finalGroupId, folder === 'private-chats/');
      if (!hasAccess) {
        console.log('Ошибка: пользователь', req.user.uid, 'не имеет доступа к чату', finalGroupId);
        return res.status(403).json({ error: "Нет доступа к этому чату" });
      }
      console.log('Доступ к чату подтвержден для пользователя');
    }

    // Генерируем уникальный ключ для файла
    const timestamp = Date.now();
    const uniqueId = uuidv4().substring(0, 8);
    const safeFileName = finalFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `${folder}${finalGroupId ? finalGroupId + '/' : ''}${timestamp}_${uniqueId}_${safeFileName}`;

    console.log('Финальный ключ для файла:', key);

    const signedUrlParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: String(fileType),
      ACL: "public-read"
    };

    const command = new PutObjectCommand(signedUrlParams);
    console.log('Генерация signed URL...');

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    const fileUrl = `https://${BUCKET_NAME}.storage.yandexcloud.net/${key}`;

    console.log('✅ Signed URL успешно сгенерирован');
    console.log('📁 File URL:', fileUrl);

    res.json({
      success: true,
      uploadUrl,
      fileUrl,
      fileName: finalFileName,
      key,
      expiresIn: 300,
      expiresAt: Date.now() + 300000
    });

  } catch (err) {
    console.error("❌ Ошибка генерации upload URL:", err);

    // Более детальные ошибки
    if (err.name === 'CredentialsProviderError') {
      return res.status(500).json({
        success: false,
        error: "Ошибка конфигурации S3: проверьте credentials"
      });
    }
    if (err.name === 'NoSuchBucket') {
      return res.status(500).json({
        success: false,
        error: `S3 bucket не найден: ${BUCKET_NAME}`
      });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: "Неверные параметры запроса: " + err.message
      });
    }

    res.status(500).json({
      success: false,
      error: "Внутренняя ошибка сервера: " + err.message
    });
  }
});

/// Функция проверки доступа к чату
async function checkChatAccess(userId, chatId, isPrivate) {
    try {
        console.log('🔐 Проверка доступа:', { userId, chatId, isPrivate });

        if (isPrivate) {
            // Для приватных чатов: проверяем участников по chatId
            const parts = chatId.split('_');
            const hasAccess = parts.includes(userId);
            console.log('🔒 Приватный чат доступ:', hasAccess);
            return hasAccess;
        } else {
            // Для групповых чатов - проверяем существование группы
            const groupRef = db.ref(`chats/groups/${chatId}`);
            const groupSnap = await groupRef.once('value');
            const exists = groupSnap.exists();
            console.log('👥 Групповой чат доступ:', exists);
            return exists;
        }
    } catch (error) {
      console.error('❌ Ошибка проверки доступа к чату:', error);
      return false;
    }
}

 // ✅ Функция для определения типа чата по chatId
 async function isPrivateChatId(chatId) {
   try {
     // 1. Если chatId содержит '_' - скорее всего приватный
     if (chatId.includes('_')) {
       console.log("🔍 ChatId содержит '_' - проверяем приватный чат");

       // Проверяем существует ли такой приватный чат
       const privateChatRef = db.ref(`chats/private/${chatId}`);
       const privateSnap = await privateChatRef.once('value');

       if (privateSnap.exists()) {
         console.log("✅ Найден приватный чат с ID:", chatId);
         return true;
       }

       // Если не нашли приватный, проверяем может это групповой с '_' в ID
       const groupChatRef = db.ref(`chats/groups/${chatId}`);
       const groupSnap = await groupChatRef.once('value');

       if (groupSnap.exists()) {
         console.log("✅ Найден групповой чат с ID (содержит '_'):", chatId);
         return false;
       }

       // Если не нашли ни там ни там - считаем приватным по формату
       console.log("⚠️ Чат не найден, но ID содержит '_' - считаем приватным");
       return true;
     }

     // 2. Если нет '_' - проверяем групповой чат
     const groupChatRef = db.ref(`chats/groups/${chatId}`);
     const groupSnap = await groupChatRef.once('value');

     if (groupSnap.exists()) {
       console.log("✅ Найден групповой чат с ID:", chatId);
       return false;
     }

     // 3. Если ничего не нашли - ошибка
     console.log("❌ Чат не найден ни в приватных, ни в групповых:", chatId);
     return false;

   } catch (error) {
     console.error("❌ Ошибка определения типа чата:", error);
     // В случае ошибки используем эвристику: если есть '_' - приватный
     return chatId.includes('_');
   }
 }


// === Вспомогательная функция для текста типа файла ===
function getFileTypeText(messageType) {
  switch (messageType) {
    case 'image': return 'Изображение';
    case 'video': return 'Видео';
    case 'audio': return 'Аудио';
    case 'file': return 'Файл';
    default: return 'Файл';
  }
}

// === Удаление невалидного FCM токена ===
async function removeInvalidToken(invalidToken) {
  try {
    console.log("🗑️ Удаление невалидного FCM токена");

    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};

    for (const [userId, user] of Object.entries(users)) {
      if (user.fcmToken === invalidToken) {
        await db.ref(`users/${userId}`).update({ fcmToken: null });
        console.log("✅ Токен удален у пользователя:", userId);
        return { success: true, userId };
      }
    }

    console.log("⚠️ Токен не найден в базе пользователей");
    return { success: false, message: "Токен не найден" };

  } catch (err) {
    console.error("❌ Ошибка удаления токена:", err);
    return { success: false, error: err.message };
  }
}

// === Получение названия группы ===
async function getGroupName(groupId) {
  try {
    const groupSnap = await db.ref(`groups/${groupId}/name`).once('value');
    const groupName = groupSnap.val() || `Группа ${groupId}`;
    console.log("🏷️ Название группы:", groupName);
    return groupName;
  } catch (error) {
    console.error("❌ Ошибка получения названия группы:", error);
    return `Группа ${groupId}`;
  }
}

// === Поиск родителей по ID группы ===
async function findParentsByGroupId(groupId) {
  try {
    console.log("🔍 Поиск родителей для группы:", groupId);

    // 1. Получаем детей из группы
    const groupSnap = await db.ref(`groups/${groupId}/children`).once('value');
    const childrenInGroup = groupSnap.val() || {};
    const childIds = Object.keys(childrenInGroup);

    console.log("👶 Дети в группе:", childIds.length);

    if (childIds.length === 0) return [];

    // 2. Ищем родителей этих детей
    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};
    const parents = [];
    const foundParentIds = new Set();

    for (const [userId, user] of Object.entries(users)) {
      if (user.role === "Родитель" && user.children) {

        // Получаем актуальные данные пользователя
        const userDataSnap = await db.ref(`users/${userId}`).once('value');
        const userData = userDataSnap.val() || {};

        for (const childId of childIds) {
          const childNameInGroup = childrenInGroup[childId];

          for (const [parentChildId, parentChildData] of Object.entries(user.children)) {
            if (parentChildData && parentChildData.fullName === childNameInGroup) {

              if (!foundParentIds.has(userId)) {
                parents.push({
                  userId: userId,
                  name: user.name || "Родитель",
                  fcmToken: user.fcmToken || null,
                  childId: parentChildId,
                  childName: parentChildData.fullName,
                  childBirthDate: parentChildData.birthDate || "",
                  childGroup: groupId
                });
                foundParentIds.add(userId);
                console.log(`   ✅ Родитель найден: ${user.name} -> ${parentChildData.fullName}`);
                break;
              }
            }
          }
        }
      }
    }

    console.log(`👨‍👩‍👧‍👦 Найдено родителей: ${parents.length}`);
    return parents;

  } catch (error) {
    console.error("❌ Ошибка поиска родителей:", error);
    return [];
  }
}


// === Функция отправки уведомлений о новых сообщениях ===

async function sendChatNotification({
  chatId,
  senderId,
  senderName,
  message,
  messageType,
  fileUrl,
  fileName,
  isPrivate
}) {
  try {
    console.log("🔔 Отправка уведомления для чата:", chatId);

    let recipients = [];
    let chatTitle = "";

    if (isPrivate) {
      // ✅ ПРИВАТНЫЙ ЧАТ: находим второго участника
      const parts = chatId.split('_');
      const otherUserId = parts.find(id => id !== senderId);

      if (otherUserId) {
        const userSnap = await db.ref(`users/${otherUserId}`).once('value');
        const user = userSnap.val();
        if (user && user.fcmToken) {
          recipients.push({
            userId: otherUserId,
            name: user.name || "Пользователь",
            fcmToken: user.fcmToken
          });
          chatTitle = user.name || "Приватный чат";
        }
      }
    } else {
      // ✅ ГРУППОВОЙ ЧАТ: находим всех участников группы
      const groupSnap = await db.ref(`groups/${chatId}`).once('value');
      const group = groupSnap.val();

      if (group) {
        chatTitle = group.name || "Групповой чат";

        // Собираем всех учителей
        if (group.teachers) {
          for (const [teacherId, teacherName] of Object.entries(group.teachers)) {
            if (teacherId !== senderId) {
              const teacherSnap = await db.ref(`users/${teacherId}`).once('value');
              const teacher = teacherSnap.val();
              if (teacher && teacher.fcmToken) {
                recipients.push({
                  userId: teacherId,
                  name: teacherName,
                  fcmToken: teacher.fcmToken
                });
              }
            }
          }
        }

        // Собираем всех родителей через детей
        if (group.children) {
          const usersSnap = await db.ref('users').once('value');
          const users = usersSnap.val() || {};

          for (const [userId, user] of Object.entries(users)) {
            if (user.role === "Родитель" && user.children && userId !== senderId) {
              for (const [childId, child] of Object.entries(user.children)) {
                if (group.children[childId]) {
                  if (user.fcmToken) {
                    recipients.push({
                      userId: userId,
                      name: user.name || "Родитель",
                      fcmToken: user.fcmToken
                    });
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }

    console.log(`📨 Найдено получателей: ${recipients.length}`);

    // Отправляем уведомления
    let successful = 0;
    for (const recipient of recipients) {
      try {
        const messagePayload = {
          token: recipient.fcmToken,
          notification: {
            title: `💬 ${isPrivate ? senderName : chatTitle}`,
            body: messageType === 'text' ? message : `📎 ${getFileTypeText(messageType)}`
          },
          data: {
            type: "chat",
            chatId: chatId,
            senderId: senderId,
            senderName: senderName,
            message: message,
            isGroup: String(!isPrivate),
            timestamp: String(Date.now())
          }
        };

        await admin.messaging().send(messagePayload);
        successful++;
        console.log(`✅ Уведомление отправлено для ${recipient.name}`);
      } catch (tokenError) {
        console.error(`❌ Ошибка отправки для ${recipient.name}:`, tokenError.message);

        // Удаляем невалидные токены
        if (tokenError.code === "messaging/registration-token-not-registered") {
          await removeInvalidToken(recipient.fcmToken);
        }
      }
    }

    console.log(`🎉 Уведомления отправлены: ${successful}/${recipients.length}`);
    return { successful, total: recipients.length };

  } catch (error) {
    console.error("❌ Ошибка в sendChatNotification:", error);
    return { successful: 0, total: 0 };
  }
}

/// === Отправка сообщения с автоматическим push-уведомлением ===
app.post("/send-message", verifyToken, async (req, res) => {
   try {
     const { chatId, message, messageType = "text", fileUrl, fileName } = req.body;
     const senderId = req.user.uid;
     console.log("📨 Новое сообщение:", { senderId, chatId, messageType });


     if (!chatId || !message) {
       return res.status(400).json({ error: "chatId и message обязательны" });
     }

     // 1. Получаем данные отправителя
     const senderSnap = await db.ref(`users/${senderId}`).once('value');
     const sender = senderSnap.val();
     const senderName = sender?.name || "Неизвестный";

     // 2. Сохраняем сообщение в базу
     const messageId = uuidv4();
     const messageData = {
       id: messageId,
       senderId,
       senderName,
       text: message,
       timestamp: Date.now(),
       fileUrl: fileUrl || null,
       fileType: messageType,
       fileName: fileName || null
     };

     // 3. Определяем тип чата
     const isPrivateChat = await isPrivateChatId(chatId);
     console.log("🔍 Тип чата:", isPrivateChat ? "PRIVATE" : "GROUP");

     let chatRef;
     if (isPrivateChat) {
       // Для приватных чатов
       chatRef = db.ref(`chats/private/${chatId}/messages/${messageId}`);
       console.log("📁 Путь: chats/private/");
     } else {
       chatRef = db.ref(`chats/groups/${chatId}/messages/${messageId}`);
       console.log("📁 Путь: chats/groups/");
     }

     await chatRef.set(messageData);
     console.log("✅ Сообщение сохранено в Firebase");

     // 4. Отправляем уведомления
     await sendChatNotification({
       chatId,
       senderId,
       senderName,
       message,
       messageType,
       fileUrl,
       fileName,
       isPrivate: isPrivateChat
     });

     console.log("✅ Уведомления отправлены");

     res.json({
       success: true,
       messageId,
       timestamp: messageData.timestamp
     });

   } catch (err) {
     console.error("❌ Ошибка отправки сообщения:", err);
     res.status(500).json({ error: err.message });
   }
 });

// === Сохранение FCM токена пользователя ===
app.post("/save-fcm-token", verifyToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user.uid;

    if (!fcmToken) {
      return res.status(400).json({ error: "fcmToken обязателен" });
    }

    console.log("💾 Сохранение FCM токена для пользователя:", userId);

    await db.ref(`users/${userId}`).update({
      fcmToken,
      fcmTokenUpdated: Date.now()
    });

    console.log("✅ FCM токен сохранен");
    res.json({ success: true });

  } catch (err) {
    console.error("❌ Ошибка сохранения FCM токена:", err);
    res.status(500).json({ error: err.message });
  }
});


// === Форматирование текста уведомления ===
function formatEventNotification(title, time, place, groupName) {
  let notification = `📅 ${title}`;

  if (time) {
    notification += ` в ${time}`;
  }

  if (place) {
    notification += ` (${place})`;
  }

  if (groupName) {
    notification += ` • ${groupName}`;
  }

  return notification;
}


 /// === Отправка FCM уведомлений о событии ===
async function sendEventNotifications({
    parents, // ✅ ПЕРЕДАЕМ ВСЕХ РОДИТЕЛЕЙ С ИХ ДАННЫМИ
    groupId,
    groupName,
    eventId,
    title,
    time,
    place,
    comments,
    date,
    notificationBody
  }) {
    try {
      const parentsWithTokens = parents.filter(parent => parent.fcmToken && parent.fcmToken.trim() !== "");
      console.log(`📱 Отправка FCM уведомлений для ${parentsWithTokens.length} родителей с токенами`);

      let successful = 0;
      let failed = 0;
      const errors = [];

      for (const parent of parentsWithTokens) {
        try {
          console.log(`➡️ Отправка уведомления для ${parent.name}`);

          // ✅ ДИНАМИЧЕСКИЕ ДАННЫЕ КАЖДОГО РОДИТЕЛЯ
          const messagePayload = {
            token: parent.fcmToken,
            notification: {
              title: "📅 Новое событие",
              body: notificationBody
            },
            data: {
              type: "new_event",
              autoOpenFragment: "events",
              groupId: String(groupId || ""),
              groupName: String(groupName || ""),
              eventId: String(eventId || ""),
              title: String(title || ""),
              time: String(time || ""),
              place: String(place || ""),
              comments: String(comments || ""),
              date: String(date || ""),
              timestamp: String(Date.now()),
              childId: parent.childId || "", //
              userId: parent.userId || "",
              childFullName: parent.childName || "",
              childGroup: String(groupName || ""),
              childBirthDate: parent.childBirthDate || ""
            }
          };

          const response = await admin.messaging().send(messagePayload);
          successful++;
          console.log("✅ Пуш отправлен для", parent.name);

        } catch (tokenError) {
          failed++;
          console.error("❌ Ошибка отправки для", parent.name, tokenError.message);

          errors.push({
            parent: parent.name,
            error: tokenError.message,
            code: tokenError.code
          });

          // Удаляем невалидные токены
          if (tokenError.code === "messaging/registration-token-not-registered") {
            const removeResult = await removeInvalidToken(parent.fcmToken);
            console.log(`🗑️ Результат удаления токена:`, removeResult);
          }
        }
      }

      console.log(`🎉 Уведомления отправлены: Успешно ${successful}, Неудачно ${failed}`);
      return { successful, failed, totalTokens: parentsWithTokens.length, errors };

    } catch (err) {
      console.error("❌ Ошибка в sendEventNotifications:", err);
      return { successful: 0, failed: parents.length, errors: [err.message] };
    }
  }

 // === Отправка уведомления о новом событии ===
app.post("/send-event-notification", verifyToken, async (req, res) => {
   console.log("🟢 Запрос на отправку уведомления о событии");
   console.log("📦 Тело запроса:", JSON.stringify(req.body, null, 2));

   try {
     const {
       groupId,
       groupName,
       eventId,
       title,
       time,
       place,
       comments,
       date
     } = req.body;

     // Валидация обязательных полей
     if (!groupId || !eventId || !title) {
       console.log("❌ Недостаточно данных для отправки уведомления");
       return res.status(400).json({
         error: "groupId, eventId, title обязательны"
       });
     }
     console.log("🔔 Данные события:", { groupId, title, time, date });

     // Получаем настоящее название группы
     const actualGroupName = await getGroupName(groupId);
     console.log("Название группы: ", actualGroupName);

     // 1. Находим родителей группы
     const parents = await findParentsByGroupId(groupId);

     if (parents.length === 0) {
       console.log("⚠️ Не найдены родители для группы:", groupId);
       return res.json({
         success: true,
         message: "Событие создано, но родители не найдены"
       });
     }

     console.log("👨‍👩‍👧‍👦 Найдены родители:", parents.length);
     console.log("📋 Список родителей:");
     parents.forEach((parent, index) => {
       console.log(`   ${index + 1}. ${parent.name} (ребенок: ${parent.childName})`);
     });

     const parentsWithTokens = parents.filter(parent => parent.fcmToken && parent.fcmToken.trim() !== "");
     console.log(`📱 Активные токены: ${parentsWithTokens.length} из ${parents.length}`);

     // 2. Формируем текст уведомления
     const notificationBody = formatEventNotification(title, time, place, actualGroupName);
     console.log("📝 Текст уведомления:", notificationBody);

     // 3. Отправляем уведомления
     const sendResults = await sendEventNotifications({
       parents: parents,
       groupId,
       groupName: actualGroupName,
       eventId,
       title,
       time,
       place,
       comments,
       date,
       notificationBody
     });

     console.log(`🎉 Уведомления о событии отправлены для ${sendResults.successful} родителей`);

     res.json({
       success: true,
       message: `Уведомления отправлены ${sendResults.successful} родителям`,
       recipients: sendResults.successful,
       totalParents: parents.length,
       parentsWithTokens: sendResults.successful,
       statistics: sendResults
     });

   } catch (err) {
     console.error("❌ Ошибка отправки уведомления о событии:", err);
     res.status(500).json({
       error: "Внутренняя ошибка сервера: " + err.message
     });
   }
 });

 // === Health Check для мониторинга ===
 app.get("/health", (req, res) => {
   console.log("✅ Health check выполнен");
   res.json({
     status: "OK",
     timestamp: new Date().toISOString(),
     service: "Firebase Admin Server",
     version: "1.0.0",
     firebase: firebaseInitialized ? "connected" : "disconnected",
     environment: process.env.NODE_ENV || "development"
   });
     console.log("✅ Health check выполнен");
     res.json(healthStatus);
 });


// === Информация о сервере ===
app.get("/info", (req, res) => {
  console.log("ℹ️ Запрос информации о сервере");
  res.json({
    service: "Firebase Admin Notification Server",
    version: "1.0.0",
    endpoints: {
      "POST /send-event-notification": "Отправка уведомлений о новых событиях",
      "POST /send-message": "Отправка сообщений в чат",
      "POST /generate-upload-url": "Генерация URL для загрузки файлов",
      "GET /news": "Получение новостей",
      "POST /news": "Создание/редактирование новостей",
      "GET /health": "Проверка работоспособности сервера",
      "GET /info": "Информация о сервере"
    },
    features: [
      "FCM уведомления о событиях",
      "Чат с файлами",
      "Загрузка файлов в S3",
      "Управление новостями",
      "Автоматическое удаление невалидных токенов"
    ]
  });
});

// === Обработка несуществующих маршрутов ===
app.use((req, res) => {
  console.log(`❌ Маршрут не найден: ${req.method} ${req.path}`);
  res.status(404).json({
    error: "Маршрут не найден",
    path: req.path,
    method: req.method
  });
});

// === Обработка непредвиденных ошибок ===
app.use((err, req, res, next) => {
  console.error("💥 Непредвиденная ошибка:", err);
  res.status(500).json({
    error: "Внутренняя ошибка сервера",
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// === Запуск сервера ===
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Firebase: ${firebaseInitialized ? '✅' : '❌'}`);
  console.log(`🌐 S3 Bucket: ${BUCKET_NAME}`);
  console.log(`⏰ Started at: ${new Date().toISOString()}`);
});


// === Проверка сервера ===
app.get("/", (req, res) => res.send("Server is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
