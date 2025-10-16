require('dotenv').config();

process.on('uncaughtException', (error) => {
  console.error('🔥 НЕОБРАБОТАННОЕ ИСКЛЮЧЕНИЕ:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 НЕОБРАБОТАННЫЙ ПРОМИС:', reason);
});

const quickCache = new Map();

// 🔥 ИЗМЕНЕНО: Увеличена частота мониторинга памяти с 2 до 4 минут и оптимизирована очистка кэша
setInterval(() => {
  const memory = process.memoryUsage();
  console.log('📊 Memory:',
    `RSS: ${Math.round(memory.rss / 1024 / 1024)}MB,`,
    `Heap: ${Math.round(memory.heapUsed / 1024 / 1024)}MB`
  );

  // 🔥 ИЗМЕНЕНО: Добавлена проверка утечек памяти и оптимизирована очистка кэша
  if (memory.heapUsed > 500 * 1024 * 1024) { // 500MB
    console.warn('🚨 ВЫСОКОЕ ПОТРЕБЛЕНИЕ ПАМЯТИ:', {
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
    });

    // Принудительный сбор мусора в продакшене
    if (global.gc) {
      global.gc();
    }
  }

  // Очистка старых кэшей
  if (quickCache.size > 100) { // 🔥 ИЗМЕНЕНО: было 50, стало 100
    const now = Date.now();
    let deletedCount = 0;
    for (let [key, value] of quickCache.entries()) {
      if (now - value.timestamp > 300000) { // 🔥 ИЗМЕНЕНО: 5 минут вместо 1
        quickCache.delete(key);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`🧹 Очищено ${deletedCount} устаревших записей кэша`);
    }
  }
}, 240000); // 🔥 ИЗМЕНЕНО: 4 минуты вместо 2

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
app.use(express.json());

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 3
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

const getFileExtension = (mimeType) => {
  return mimeTypeMapping[mimeType] || '.bin';
};

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

// 🔥 ДОБАВЛЕНО: Функция с retry логикой для S3
async function uploadToS3WithRetry(buffer, fileName, contentType, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await uploadToS3(buffer, fileName, contentType);
    } catch (error) {
      if (attempt === retries) throw error;

      console.log(`🔄 Повторная попытка загрузки в S3 (${attempt}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
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

// 🔥 ДОБАВЛЕНО: Функция кэширования для Firebase
async function getGroupWithCache(groupId) {
  const cacheKey = `group_${groupId}`;
  const cached = quickCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < 60000)) {
    return cached.data;
  }

  const groupSnap = await db.ref(`groups/${groupId}`).once('value');
  const groupData = groupSnap.val();

  if (groupData) {
    quickCache.set(cacheKey, {
      data: groupData,
      timestamp: Date.now()
    });
  }

  return groupData;
}

// 🔥 ДОБАВЛЕНО: Метрики производительности
const performanceMetrics = {
  requests: 0,
  errors: 0,
  slowRequests: 0,
  startTime: Date.now()
};

// 🔥 ИЗМЕНЕНО: Оптимизированное middleware логирования
app.use((req, res, next) => {
  // Пропускать health-check запросы из логов
  if (req.url === '/health' || req.url === '/ping') {
    return next();
  }

  performanceMetrics.requests++; // 🔥 ДОБАВЛЕНО: подсчет запросов

  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);

  if (process.env.NODE_ENV === 'development') {
    console.log(`📨 [${requestId}] ${req.method} ${req.url} - Started`);
  }

  res.on('finish', () => {
    const duration = Date.now() - start;
    const isSlow = duration > 1000; // 🔥 ИЗМЕНЕНО: 1 секунда вместо 500ms

    if (isSlow) {
      performanceMetrics.slowRequests++; // 🔥 ДОБАВЛЕНО: подсчет медленных запросов
      console.warn(`🐌 [${requestId}] SLOW: ${req.method} ${req.url} - ${duration}ms`);
    }

    // Логировать все запросы только в development
    if (process.env.NODE_ENV === 'development') {
      console.log(`✅ [${requestId}] ${req.method} ${req.url} - ${duration}ms`);
    }
  });

  next();
});

// === Все существующие эндпоинты остаются без изменений ===

// === Удаление пользователя/ребёнка ===
app.post('/deleteUserByName', async (req, res) => {
  const fullName = req.body.fullName?.trim().toLowerCase();
  if (!fullName) return res.status(400).send("fullName обязателен");

  try {
    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};
    let found = false;

    for (const [userId, user] of Object.entries(users)) {
      const name = user.name?.trim().toLowerCase();
      const role = user.role?.trim().toLowerCase();

      // Родитель
      if (name === fullName && role === 'родитель') {
        found = true;

        // 1. Удаляем детей из групп и S3
        if (user.children) {
          const filesToDelete = [];

          for (const [childId, child] of Object.entries(user.children)) {
            // Удаляем из группы по childId (а не по имени!)
            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
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
        } catch (authError) {
          console.log("Пользователь не найден в Auth, пропускаем:", authError.message);
        }

        return res.send("Родитель и его дети удалены.");
      }

      // Педагог
      if (name === fullName && role === 'педагог') {
        found = true;

        // Удаляем из всех групп
        const groupsSnap = await db.ref('groups').once('value');
        const groups = groupsSnap.val() || {};

        for (const [groupId, group] of Object.entries(groups)) {
          if (group.teachers?.[userId]) {
            await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
          }
        }

        // Удаляем пользователя
        await db.ref(`users/${userId}`).remove();

        try {
          await auth.getUser(userId);
          await auth.deleteUser(userId);
        } catch (authError) {
          console.log("Пользователь не найден в Auth:", authError.message);
        }

        return res.send("Педагог удалён.");
      }

      // Отдельный ребенок (поиск ребенка по имени)
      if (user.children) {
        for (const [childId, child] of Object.entries(user.children)) {
          if (child.fullName?.trim().toLowerCase() === fullName) {
            found = true;

            // Удаляем из группы
            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
            }

            // Удаляем файлы ребенка из S3
            const filesToDelete = [];
            if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
            if (filesToDelete.length > 0) {
              await deleteFromS3(filesToDelete);
            }

            // Удаляем ребенка из пользователя
            await db.ref(`users/${userId}/children/${childId}`).remove();

            return res.send("Ребёнок удалён.");
          }
        }
      }
    }

    if (!found) {
      res.status(404).send("Пользователь не найден.");
    }
  } catch (err) {
    performanceMetrics.errors++; // 🔥 ДОБАВЛЕНО: подсчет ошибок
    console.error("Ошибка при deleteUserByName:", err);
    res.status(500).send("Ошибка при удалении: " + err.message);
  }
});

// === Новый endpoint для удаления только ребенка ===
app.post('/deleteChild', async (req, res) => {
  const { userId, childId } = req.body;

  if (!userId || !childId) {
    return res.status(400).json({ error: "userId и childId обязательны" });
  }

  try {
    console.log('=== DELETE CHILD DEBUG START ===');

    // 1. Получаем данные ребенка
    const childRef = db.ref(`users/${userId}/children/${childId}`);
    const childSnap = await childRef.once('value');

    if (!childSnap.exists()) {
      return res.status(404).json({ error: "Ребенок не найден" });
    }

    const child = childSnap.val();
    const groupName = child.group;
    const childName = child.fullName.trim();

    console.log('👶 Имя ребенка:', `"${childName}"`);
    console.log('🏷️ Название группы:', groupName);

    // 2. Находим ID группы по названию
    let groupId = null;
    if (groupName) {
      console.log('🔍 Ищем ID группы по названию:', groupName);

      const groupsRef = db.ref('groups');
      const groupsSnap = await groupsRef.once('value');
      const groups = groupsSnap.val() || {};

      console.log('Все группы:', JSON.stringify(groups, null, 2));

      for (const [id, groupData] of Object.entries(groups)) {
        console.log(`Проверяем группу: ${id} -> ${groupData.name}`);
        if (groupData.name === groupName) {
          groupId = id;
          console.log('✅ Найдена группа! ID:', groupId);
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

    const groupChildrenRef = db.ref(`groups/${groupId}/children`);
    const groupChildrenSnap = await groupChildrenRef.once('value');
    const groupChildren = groupChildrenSnap.val() || {};

    console.log('👥 Дети в группе:', JSON.stringify(groupChildren, null, 2));

    let foundGroupChildId = null;
    for (const [groupChildId, groupChildName] of Object.entries(groupChildren)) {
      const trimmedGroupName = groupChildName.trim();
      console.log(`🔎 Сравниваем: "${trimmedGroupName}" vs "${childName}"`);

      if (trimmedGroupName === childName) {
        foundGroupChildId = groupChildId;
        console.log('✅ Найдено совпадение! Key:', foundGroupChildId);
        break;
      }
    }

    if (foundGroupChildId) {
      console.log('🗑️ Удаляем ребенка из группы');
      await groupChildrenRef.child(foundGroupChildId).remove();
      console.log('✅ Ребенок удален из группы');
    } else {
      console.log('❌ Ребенок не найден в группе');
      return res.status(404).json({ error: "Ребенок не найден в группе" });
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

    console.log('=== DELETE CHILD DEBUG END ===');

    res.json({
      success: true,
      message: `Ребенок ${childName} успешно удален`
    });

  } catch (err) {
    performanceMetrics.errors++;
    console.error('❌ Ошибка при deleteChild:', err);
    res.status(500).json({ error: "Ошибка при удалении ребенка" });
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
    performanceMetrics.errors++;
    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: "Email уже используется" });
    }
    console.error("Ошибка update-user:", err);
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

    if (newsId) {
      // === Редактирование ===
      const ref = db.ref(`news/${groupId}/${newsId}`);
      const snap = await ref.once("value");
      const oldNews = snap.val();
      if (!oldNews) return res.status(404).json({ error: "Новость не найдена" });
      if (oldNews.authorId !== authorId) return res.status(403).json({ error: "Нет прав" });

      // Удаляем из S3 те, которых больше нет
      const oldUrls = oldNews.mediaUrls || [];
      const keepSet = new Set(mediaUrls);
      const toDelete = oldUrls.filter(url => !keepSet.has(url));
      await deleteFromS3(toDelete);

      const newData = {
        title,
        description,
        mediaUrls,
        authorId,
        timestamp: Date.now(),
      };

      await ref.update(newData);
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
    return res.json({ success: true, id });

  } catch (err) {
    performanceMetrics.errors++;
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

    res.json(newsList);
  } catch (err) {
    performanceMetrics.errors++;
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

    const snap = await db.ref(`news/${groupId}/${newsId}`).once('value');
    const data = snap.val();
    if (!data) return res.status(404).json({ error: "Новость не найдена" });

    if (data.authorId !== authorId) return res.status(403).json({ error: "Нет прав" });

    const urls = data.mediaUrls || [];
    await deleteFromS3(urls);
    await db.ref(`news/${groupId}/${newsId}`).remove();

    res.json({ success: true });
  } catch (err) {
    performanceMetrics.errors++;
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

    if (!fileName || !fileType) {
      console.log('Ошибка: отсутствуют обязательные поля fileName или fileType');
      return res.status(400).json({ error: "fileName и fileType обязательны" });
    }

    const fileExtension = getFileExtension(fileType);
    let finalFileName = fileName;

    if (!finalFileName.includes('.') || !finalFileName.toLowerCase().endsWith(fileExtension.toLowerCase())) {
      const baseName = finalFileName.includes('.')
        ? finalFileName.substring(0, finalFileName.lastIndexOf('.'))
        : finalFileName;

      finalFileName = baseName + fileExtension;
      console.log('Скорректированное имя файла:', finalFileName);
    }

    let folder;
    let finalGroupId = groupId;

    if (context === 'news') {
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

    if (finalGroupId && folder !== 'news/') {
      const hasAccess = await checkChatAccess(req.user.uid, finalGroupId, folder === 'private-chats/');
      if (!hasAccess) {
        console.log('Ошибка: пользователь', req.user.uid, 'не имеет доступа к чату', finalGroupId);
        return res.status(403).json({ error: "Нет доступа к этому чату" });
      }
      console.log('Доступ к чату подтвержден для пользователя:', req.user.uid);
    }

    const timestamp = Date.now();
    const uniqueId = uuidv4().substring(0, 8);
    const safeFileName = finalFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `${folder}${finalGroupId ? finalGroupId + '/' : ''}${timestamp}_${uniqueId}_${safeFileName}`;

    console.log('Финальный ключ для файла:', key);
    console.log('ContentType:', fileType);

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
    performanceMetrics.errors++;
    console.error("❌ Ошибка генерации upload URL:", err);

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

// Функция проверки доступа к чату
async function checkChatAccess(userId, chatId, isPrivate) {
  try {
    console.log(
      'Проверка доступа для пользователя:',
      userId,
      'к чату:',
      chatId,
      'тип:',
      isPrivate ? 'private' : 'group'
    );

    if (isPrivate) {
      const parts = chatId.split('_');
      const hasAccess = parts.includes(userId);
      console.log('Приватный чат доступ:', hasAccess, 'участники:', parts);
      return hasAccess;
    } else {
      // 🔥 ИЗМЕНЕНО: Используем кэшированную версию
      const groupData = await getGroupWithCache(chatId);

      if (!groupData) {
        console.log('Групповой чат не найден:', chatId);
        return false;
      }

      console.log('✅ Групповой чат существует, доступ разрешен');
      return true;
    }
  } catch (error) {
    console.error('Ошибка проверки доступа к чату:', error);
    return false;
  }
}

// ✅ Функция для определения типа чата по chatId
async function isPrivateChatId(chatId) {
  try {
    if (chatId.includes('_')) {
      console.log("🔍 ChatId содержит '_' - проверяем приватный чат");

      const privateChatRef = db.ref(`chats/private/${chatId}`);
      const privateSnap = await privateChatRef.once('value');

      if (privateSnap.exists()) {
        console.log("✅ Найден приватный чат с ID:", chatId);
        return true;
      }

      const groupChatRef = db.ref(`chats/groups/${chatId}`);
      const groupSnap = await groupChatRef.once('value');

      if (groupSnap.exists()) {
        console.log("✅ Найден групповой чат с ID (содержит '_'):", chatId);
        return false;
      }

      console.log("⚠️ Чат не найден, но ID содержит '_' - считаем приватным");
      return true;
    }

    const groupChatRef = db.ref(`chats/groups/${chatId}`);
    const groupSnap = await groupChatRef.once('value');

    if (groupSnap.exists()) {
      console.log("✅ Найден групповой чат с ID:", chatId);
      return false;
    }

    console.log("❌ Чат не найден ни в приватных, ни в групповых:", chatId);
    return false;

  } catch (error) {
    console.error("❌ Ошибка определения типа чата:", error);
    return chatId.includes('_');
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
      // 🔥 ИЗМЕНЕНО: Используем кэшированную версию
      const group = await getGroupWithCache(chatId);

      if (group) {
        chatTitle = group.name || "Групповой чат";

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

// === Отправка сообщения с автоматическим push-уведомлением ===
app.post("/send-message", verifyToken, async (req, res) => {
  try {
    const { chatId, message, messageType = "text", fileUrl, fileName } = req.body;
    const senderId = req.user.uid;

    console.log("=== 📨 НОВОЕ СООБЩЕНИЕ ===");
    console.log("👤 От:", senderId);
    console.log("💬 Текст:", message);
    console.log("🆔 ChatId:", chatId);
    console.log("📁 Тип:", messageType);
    console.log("🌐 File:", fileUrl);

    if (!chatId || !message) {
      return res.status(400).json({ error: "chatId и message обязательны" });
    }

    const senderSnap = await db.ref(`users/${senderId}`).once('value');
    const sender = senderSnap.val();
    const senderName = sender?.name || "Неизвестный";

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

    const isPrivateChat = await isPrivateChatId(chatId);
    console.log("🔍 Тип чата:", isPrivateChat ? "PRIVATE" : "GROUP");

    let chatRef;
    if (isPrivateChat) {
      chatRef = db.ref(`chats/private/${chatId}/messages/${messageId}`);
      console.log("📁 Путь: chats/private/");
    } else {
      chatRef = db.ref(`chats/groups/${chatId}/messages/${messageId}`);
      console.log("📁 Путь: chats/groups/");
    }

    await chatRef.set(messageData);
    console.log("✅ Сообщение сохранено в Firebase");

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
    performanceMetrics.errors++;
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
    performanceMetrics.errors++;
    console.error("❌ Ошибка сохранения FCM токена:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Удаление невалидного FCM токена ===
async function removeInvalidToken(invalidToken) {
  try {
    console.log("🗑️ Удаление невалидного FCM токена:", invalidToken.substring(0, 15) + "...");

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
    // 🔥 ИЗМЕНЕНО: Используем кэшированную версию
    const groupData = await getGroupWithCache(groupId);
    const groupName = groupData?.name || `Группа ${groupId}`;
    console.log("🏷️ Название группы получено:", groupName);
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

    // 🔥 ИЗМЕНЕНО: Используем кэшированную версию
    const groupData = await getGroupWithCache(groupId);
    const childrenInGroup = groupData?.children || {};
    const childIds = Object.keys(childrenInGroup);

    console.log("👶 Дети в группе:", childIds.length, childIds);

    if (childIds.length === 0) return [];

    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};
    const parents = [];
    const foundParentIds = new Set();

    for (const [userId, user] of Object.entries(users)) {
      if (user.role === "Родитель" && user.children) {

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
                console.log(`   ✅ СОВПАДЕНИЕ: ${user.name} -> ${parentChildData.fullName}`);
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

// === Отправка FCM уведомлений о событии ===
async function sendEventNotifications({
  parents,
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
        console.log(`➡️ Отправка уведомления для ${parent.name}, токен:`, parent.fcmToken.substring(0, 15) + "...");

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

            childId: parent.childId || "",
            userId: parent.userId || "",
            childFullName: parent.childName || "",
            childGroup: String(groupName || ""),
            childBirthDate: parent.childBirthDate || ""
          }
        };

        console.log("📨 Отправляю FCM payload для", parent.name);

        const response = await admin.messaging().send(messagePayload);

        successful++;
        console.log("✅ Пуш отправлен для", parent.name, "| response:", response);

      } catch (tokenError) {
        failed++;
        console.error("❌ Ошибка отправки для", parent.name, tokenError.message);

        errors.push({
          parent: parent.name,
          error: tokenError.message,
          code: tokenError.code
        });

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
  console.log("🟢🟢🟢 ПОЛУЧЕН ЗАПРОС НА /send-event-notification 🟢🟢🟢");
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

    if (!groupId || !eventId || !title) {
      console.log("❌ Недостаточно данных для отправки уведомления");
      return res.status(400).json({
        error: "groupId, eventId, title обязательны"
      });
    }

    console.log("🔔 Запрос на отправку уведомления о событии:");
    console.log("   - Группа:", groupId, groupName);
    console.log("   - Событие:", title, time);
    console.log("   - Дата:", date);

    const actualGroupName = await getGroupName(groupId);
    console.log("   - Название группы:", actualGroupName);

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

    parents.forEach(parent => {
      if (parent.fcmToken && parent.fcmToken.trim() !== "") {
        console.log("✅ Токен родителя:", parent.userId, parent.name, "- ребенок:", parent.childName);
      } else {
        console.log("❌ Нет токена у родителя:", parent.name);
      }
    });

    console.log(`📱 Найдены активные токены: ${parentsWithTokens.length} из ${parents.length} родителей`);

    const notificationBody = formatEventNotification(title, time, place, actualGroupName);
    console.log("📝 Текст уведомления:", notificationBody);

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
      statistics: sendResults,
      parentDetails: parents.map(p => ({
        name: p.name,
        child: p.childName,
        hasToken: !!(p.fcmToken && p.fcmToken.trim() !== "")
      }))
    });

  } catch (err) {
    performanceMetrics.errors++;
    console.error("❌ Ошибка отправки уведомления о событии:", err);
    res.status(500).json({
      error: "Внутренняя ошибка сервера: " + err.message
    });
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

// 🔥 ДОБАВЛЕНО: Новый эндпоинт для метрик
app.get("/metrics", (req, res) => {
  const uptime = Date.now() - performanceMetrics.startTime;
  const requestsPerMinute = (performanceMetrics.requests / (uptime / 60000)).toFixed(2);
  const errorRate = performanceMetrics.requests > 0
    ? ((performanceMetrics.errors / performanceMetrics.requests) * 100).toFixed(2)
    : 0;

  res.json({
    uptime: Math.round(uptime / 1000) + 's',
    total_requests: performanceMetrics.requests,
    requests_per_minute: requestsPerMinute,
    error_rate: errorRate + '%',
    slow_requests: performanceMetrics.slowRequests,
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    },
    cache: {
      quick_cache_size: quickCache.size
    }
  });
});

// 🔥 ИЗМЕНЕНО: Оптимизированный keep-alive
const keepAlive = () => {
  setInterval(async () => {
    try {
      const https = require('https');
      const options = {
        hostname: process.env.RENDER_EXTERNAL_HOSTNAME || `firebase-admin-server-6e6o.onrender.com`,
        port: 443,
        path: '/ping', // 🔥 ИЗМЕНЕНО: используем /ping вместо /health
        method: 'GET',
        timeout: 5000 // 🔥 ИЗМЕНЕНО: уменьшен таймаут
      };

      const req = https.request(options, (res) => {
        console.log('💓 Keep-alive статус:', res.statusCode);
      });

      req.on('error', (err) => {
        console.log('💓 Keep-alive ошибка (нормально):', err.message);
      });

      req.on('timeout', () => {
        console.log('💓 Keep-alive таймаут (нормально)');
        req.destroy();
      });

      req.end();
    } catch (error) {
      console.log('💓 Keep-alive цикл завершен');
    }
  }, 4 * 60 * 1000); // 4 минуты
};

app.get("/health", (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    status: "OK",
    timestamp: Date.now(),
    memory: {
      rss: Math.round(memory.rss / 1024 / 1024) + "MB",
      heap: Math.round(memory.heapUsed / 1024 / 1024) + "MB",
      external: Math.round(memory.external / 1024 / 1024) + "MB"
    },
    uptime: Math.round(process.uptime()) + "s",
    quickCacheSize: quickCache.size
  });
});

// === Информация о сервере ===
app.get("/info", (req, res) => {
  console.log("ℹ️ Запрос информации о сервере");
  res.json({
    service: "Firebase Admin Notification Server",
    version: "1.0.0",
    endpoints: {
      "POST /send-event-notification": "Отправка уведомлений о новых событиях",
      "GET /health": "Проверка работоспособности сервера",
      "GET /info": "Информация о сервере",
      "GET /ping": "Пинг с диагностикой",
      "GET /stress-test": "Тест нагрузки",
      "GET /metrics": "Метрики производительности" // 🔥 ДОБАВЛЕНО
    },
    features: [
      "Отправка FCM уведомлений о событиях ВСЕМ родителям группы",
      "Автоматическое удаление невалидных токенов",
      "Поиск родителей по группе",
      "Расширенное логирование",
      "Мониторинг производительности",
      "Кэширование Firebase запросов" // 🔥 ДОБАВЛЕНО
    ]
  });
});

app.get("/ping", async (req, res) => {
  const start = Date.now();
  const diagnostics = {};

  try {
    const fbStart = Date.now();
    await db.ref('.info/connected').once('value');
    diagnostics.firebase = `${Date.now() - fbStart}ms`;

    const s3Start = Date.now();
    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: 'ping-test',
        Body: Buffer.from('test'),
        ContentType: 'text/plain'
      })).catch(() => {});
      diagnostics.s3 = `${Date.now() - s3Start}ms`;
    } catch (s3Error) {
      diagnostics.s3 = `error: ${s3Error.message}`;
    }

    const cacheStart = Date.now();
    const cacheSize = quickCache.size;
    diagnostics.cache = `${Date.now() - cacheStart}ms (size: ${cacheSize})`;

    diagnostics.total = `${Date.now() - start}ms`;

    res.json({
      pong: Date.now(),
      simple: true,
      diagnostics
    });

  } catch (error) {
    res.status(500).json({
      error: "Diagnostics failed",
      message: error.message
    });
  }
});

// Улучшенный stress-test
app.get("/stress-test", async (req, res) => {
  const start = Date.now();

  const tests = [];
  tests.push({ name: "simple_response", time: "0ms" });

  const fbStart = Date.now();
  try {
    await db.ref('.info/connected').once('value');
    tests.push({ name: "firebase_connect", time: `${Date.now() - fbStart}ms` });
  } catch (error) {
    tests.push({ name: "firebase_connect", time: `error: ${error.message}` });
  }

  const memory = process.memoryUsage();

  const eventLoopStart = Date.now();
  await new Promise(resolve => setImmediate(resolve));
  const eventLoopLag = Date.now() - eventLoopStart;

  res.json({
    status: "OK",
    timestamp: Date.now(),
    total_time: `${Date.now() - start}ms`,
    memory: {
      rss: Math.round(memory.rss / 1024 / 1024) + "MB",
      heap: Math.round(memory.heapUsed / 1024 / 1024) + "MB",
      heap_total: Math.round(memory.heapTotal / 1024 / 1024) + "MB"
    },
    performance: {
      uptime: Math.round(process.uptime()) + "s",
      event_loop_lag: `${eventLoopLag}ms`,
      quick_cache_size: quickCache.size
    },
    tests
  });
});

// Новый эндпоинт для статистики производительности
app.get("/performance", (req, res) => {
  const memory = process.memoryUsage();
  const stats = {
    server: {
      uptime: Math.round(process.uptime()) + "s",
      node_version: process.version,
      platform: process.platform
    },
    memory: {
      rss_mb: Math.round(memory.rss / 1024 / 1024),
      heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(memory.heapTotal / 1024 / 1024),
      external_mb: Math.round(memory.external / 1024 / 1024)
    },
    cache: {
      quick_cache_size: quickCache.size
    },
    environment: {
      port: process.env.PORT || 3000,
      node_env: process.env.NODE_ENV || 'development'
    }
  };

  res.json(stats);
});

// === Проверка сервера ===
app.get("/", (req, res) => {
  res.json({
    message: "Firebase Admin Server is running",
    timestamp: Date.now(),
    endpoints: [
      "/health - Health check",
      "/info - Server information",
      "/ping - Ping with diagnostics",
      "/stress-test - Load test",
      "/performance - Performance stats",
      "/metrics - Performance metrics" // 🔥 ДОБАВЛЕНО
    ]
  });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server started on port ${PORT}`);
  console.log(`✅ Keep-alive started`);
  console.log(`✅ Performance monitoring enabled`);
  console.log(`✅ Firebase caching enabled`); // 🔥 ДОБАВЛЕНО
  keepAlive();
});

// Graceful shutdown для Render
server.keepAliveTimeout = 60000;
server.headersTimeout = 65000;

process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('⚠️ Forcing shutdown');
    process.exit(1);
  }, 10000);
});