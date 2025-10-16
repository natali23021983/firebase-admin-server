require('dotenv').config();

process.on('uncaughtException', (error) => {
  console.error('🔥 НЕОБРАБОТАННОЕ ИСКЛЮЧЕНИЕ:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 НЕОБРАБОТАННЫЙ ПРОМИС:', reason);
});

const quickCache = new Map();

// 🔥 ОПТИМИЗИРОВАННЫЙ мониторинг памяти
const MEMORY_LIMIT = 200 * 1024 * 1024; // 200MB
const CACHE_LIMIT = 25; // Уменьшенный кэш
let emergencyMode = false;

setInterval(() => {
  const memory = process.memoryUsage();
  const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);

  if (heapUsedMB > MEMORY_LIMIT / 1024 / 1024) {
    console.warn('🚨 CRITICAL MEMORY:', {
      heapUsed: heapUsedMB + 'MB',
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
    });

    // Агрессивная очистка кэша
    quickCache.clear();

    // Принудительный сбор мусора
    if (global.gc) {
      global.gc();
    }
  }

  // Регулярная очистка кэша
  if (quickCache.size > CACHE_LIMIT) {
    const now = Date.now();
    let deletedCount = 0;

    for (let [key, value] of quickCache.entries()) {
      if (now - value.timestamp > 300000) { // 5 минут
        quickCache.delete(key);
        deletedCount++;
      }
      if (quickCache.size <= CACHE_LIMIT * 0.7) break;
    }

    if (deletedCount > 0 && process.env.NODE_ENV === 'development') {
      console.log(`🧹 Очищено ${deletedCount} устаревших записей кэша`);
    }
  }
}, 300000); // 5 минут

// 🔥 ОПТИМИЗИРОВАННЫЕ таймауты
const FIREBASE_TIMEOUT = 5000; // 5 секунд
const S3_TIMEOUT = 10000; // 10 секунд

const withStrictTimeout = (promise, timeoutMs, operationName = 'Operation') => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        console.warn(`⏰ Timeout exceeded for ${operationName}`);
        reject(new Error(`${operationName} timeout after ${timeoutMs}ms`));
      }, timeoutMs)
    )
  ]);
};

const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 УМЕНЬШЕННЫЕ лимиты для экономии памяти
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
    files: 1
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
try {
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

// === Middleware проверки Firebase-токена ===
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

  if (!token) {
    console.warn("🚫 verifyToken: отсутствует заголовок Authorization");
    return res.status(401).send("Нет токена");
  }

  try {
    const decoded = await withStrictTimeout(
      admin.auth().verifyIdToken(token),
      FIREBASE_TIMEOUT,
      'Firebase token verification'
    );
    req.user = decoded;
    if (process.env.NODE_ENV === 'development') {
      console.log("✅ verifyToken: токен валиден, uid:", decoded.uid);
    }
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

async function uploadToS3WithRetry(buffer, fileName, contentType, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await withStrictTimeout(
        uploadToS3(buffer, fileName, contentType),
        S3_TIMEOUT,
        `S3 upload attempt ${attempt}`
      );
    } catch (error) {
      if (attempt === retries) throw error;
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

  await withStrictTimeout(
    s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: keys }
    })),
    S3_TIMEOUT,
    'S3 delete objects'
  );
}

// 🔥 ОПТИМИЗИРОВАННАЯ функция кэширования
async function getGroupWithCache(groupId) {
  const cacheKey = `group_${groupId}`;
  const cached = quickCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < 60000)) {
    return cached.data;
  }

  try {
    const groupSnap = await withStrictTimeout(
      db.ref(`groups/${groupId}`).once('value'),
      FIREBASE_TIMEOUT,
      `Firebase group fetch for ${groupId}`
    );
    const groupData = groupSnap.val();

    if (groupData) {
      quickCache.set(cacheKey, {
        data: groupData,
        timestamp: Date.now()
      });
    }

    return groupData;
  } catch (error) {
    console.error(`❌ Ошибка получения группы ${groupId}:`, error.message);
    return null;
  }
}

// 🔥 Метрики производительности
const performanceMetrics = {
  requests: 0,
  errors: 0,
  slowRequests: 0,
  startTime: Date.now()
};

// 🔥 ОПТИМИЗИРОВАННОЕ middleware логирования
app.use((req, res, next) => {
  // Пропускать health-check запросы из логов
  if (req.url === '/health' || req.url === '/ping') {
    return next();
  }

  performanceMetrics.requests++;

  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);

  if (process.env.NODE_ENV === 'development') {
    console.log(`📨 [${requestId}] ${req.method} ${req.url} - Started`);
  }

  res.on('finish', () => {
    const duration = Date.now() - start;
    const isSlow = duration > 3000; // 3 секунды

    if (isSlow) {
      performanceMetrics.slowRequests++;
      console.warn(`🐌 [${requestId}] SLOW: ${req.method} ${req.url} - ${duration}ms`);
    }

    // Логировать только в development
    if (process.env.NODE_ENV === 'development') {
      console.log(`✅ [${requestId}] ${req.method} ${req.url} - ${duration}ms`);
    }
  });

  next();
});

// === Удаление пользователя/ребёнка ===
app.post('/deleteUserByName', async (req, res) => {
  const fullName = req.body.fullName?.trim().toLowerCase();
  if (!fullName) return res.status(400).send("fullName обязателен");

  try {
    const usersSnap = await withStrictTimeout(
      db.ref('users').once('value'),
      15000,
      'deleteUserByName users fetch'
    );
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
            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
            }
            if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
          }

          if (filesToDelete.length > 0) {
            await deleteFromS3(filesToDelete);
          }
        }

        // 2. Удаляем пользователя из базы
        await db.ref(`users/${userId}`).remove();

        // 3. Удаляем из Firebase Auth
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
        const groupsSnap = await withStrictTimeout(
          db.ref('groups').once('value'),
          10000,
          'deleteUserByName groups fetch'
        );
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

      // Отдельный ребенок
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
    performanceMetrics.errors++;
    console.error("Ошибка при deleteUserByName:", err);

    if (err.message.includes('timeout')) {
      return res.status(408).send("Операция заняла слишком много времени");
    }

    res.status(500).send("Ошибка при удалении: " + err.message);
  }
});

// === Удаление ребенка ===
app.post('/deleteChild', async (req, res) => {
  const { userId, childId } = req.body;

  if (!userId || !childId) {
    return res.status(400).json({ error: "userId и childId обязательны" });
  }

  try {
    // 1. Получаем данные ребенка
    const childRef = db.ref(`users/${userId}/children/${childId}`);
    const childSnap = await withStrictTimeout(
      childRef.once('value'),
      10000,
      'deleteChild child fetch'
    );

    if (!childSnap.exists()) {
      return res.status(404).json({ error: "Ребенок не найден" });
    }

    const child = childSnap.val();
    const groupName = child.group;
    const childName = child.fullName.trim();

    // 2. Находим ID группы по названию
    let groupId = null;
    if (groupName) {
      const groupsRef = db.ref('groups');
      const groupsSnap = await withStrictTimeout(
        groupsRef.once('value'),
        10000,
        'deleteChild groups fetch'
      );
      const groups = groupsSnap.val() || {};

      for (const [id, groupData] of Object.entries(groups)) {
        if (groupData.name === groupName) {
          groupId = id;
          break;
        }
      }

      if (!groupId) {
        return res.status(404).json({ error: "Группа не найдена" });
      }
    }

    // 3. Удаляем ребенка из группы
    if (groupId) {
      const groupChildrenRef = db.ref(`groups/${groupId}/children`);
      const groupChildrenSnap = await withStrictTimeout(
        groupChildrenRef.once('value'),
        5000,
        'deleteChild group children fetch'
      );
      const groupChildren = groupChildrenSnap.val() || {};

      let foundGroupChildId = null;
      for (const [groupChildId, groupChildName] of Object.entries(groupChildren)) {
        if (groupChildName.trim() === childName) {
          foundGroupChildId = groupChildId;
          break;
        }
      }

      if (foundGroupChildId) {
        await groupChildrenRef.child(foundGroupChildId).remove();
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
    await childRef.remove();

    res.json({
      success: true,
      message: `Ребенок ${childName} успешно удален`
    });

  } catch (err) {
    performanceMetrics.errors++;
    console.error('❌ Ошибка при deleteChild:', err);

    if (err.message.includes('timeout')) {
      return res.status(408).json({ error: "Операция заняла слишком много времени" });
    }

    res.status(500).json({ error: "Ошибка при удалении ребенка" });
  }
});

// === Обновление email ===
app.post("/update-user", async (req, res) => {
  try {
    const { fullName, newEmail } = req.body;
    if (!fullName || !newEmail) return res.status(400).json({ error: "fullName и newEmail обязательны" });

    const snap = await withStrictTimeout(
      db.ref("users").orderByChild("name").equalTo(fullName).once("value"),
      10000,
      'update-user user search'
    );
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

    if (err.message.includes('timeout')) {
      return res.status(408).json({ error: "Операция заняла слишком много времени" });
    }

    console.error("Ошибка update-user:", err);
    res.status(500).json({ error: "Ошибка сервера: " + err.message });
  }
});

// === Новости ===
app.post("/news", verifyToken, async (req, res) => {
  try {
    const { newsId, groupId, title, description, mediaUrls = [] } = req.body;
    const authorId = req.user.uid;

    if (!groupId || !title || !description) {
      return res.status(400).json({ error: "groupId, title и description обязательны" });
    }

    if (newsId) {
      // Редактирование
      const ref = db.ref(`news/${groupId}/${newsId}`);
      const snap = await withStrictTimeout(
        ref.once("value"),
        5000,
        'news edit fetch'
      );
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

    // Добавление новости
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

    if (err.message.includes('timeout')) {
      return res.status(408).json({ error: "Операция заняла слишком много времени" });
    }

    console.error("Ошибка POST /news:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/news", verifyToken, async (req, res) => {
  try {
    const groupId = req.query.groupId;
    if (!groupId) {
      return res.status(400).json({ error: "groupId обязателен" });
    }

    const snap = await withStrictTimeout(
      db.ref(`news/${groupId}`).once("value"),
      10000,
      'news list fetch'
    );
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

    if (err.message.includes('timeout')) {
      return res.status(408).json({ error: "Операция заняла слишком много времени" });
    }

    console.error("Ошибка GET /news:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/deleteNews", verifyToken, async (req, res) => {
  try {
    const { groupId, newsId } = req.body;
    const authorId = req.user.uid;

    if (!groupId || !newsId) {
      return res.status(400).json({ error: "groupId и newsId обязательны" });
    }

    const snap = await withStrictTimeout(
      db.ref(`news/${groupId}/${newsId}`).once('value'),
      5000,
      'deleteNews fetch'
    );
    const data = snap.val();
    if (!data) return res.status(404).json({ error: "Новость не найдена" });

    if (data.authorId !== authorId) return res.status(403).json({ error: "Нет прав" });

    const urls = data.mediaUrls || [];
    await deleteFromS3(urls);
    await db.ref(`news/${groupId}/${newsId}`).remove();

    res.json({ success: true });
  } catch (err) {
    performanceMetrics.errors++;

    if (err.message.includes('timeout')) {
      return res.status(408).json({ error: "Операция заняла слишком много времени" });
    }

    console.error("Ошибка deleteNews:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Генерация signed URL ===
app.post('/generate-upload-url', verifyToken, async (req, res) => {
  try {
    const { fileName, fileType, groupId, isPrivateChat, context } = req.body;

    if (!fileName || !fileType) {
      return res.status(400).json({ error: "fileName и fileType обязательны" });
    }

    const fileExtension = getFileExtension(fileType);
    let finalFileName = fileName;

    if (!finalFileName.includes('.') || !finalFileName.toLowerCase().endsWith(fileExtension.toLowerCase())) {
      const baseName = finalFileName.includes('.')
        ? finalFileName.substring(0, finalFileName.lastIndexOf('.'))
        : finalFileName;
      finalFileName = baseName + fileExtension;
    }

    let folder;
    let finalGroupId = groupId;

    if (context === 'news') {
      folder = 'news/';
    } else if (isPrivateChat === true) {
      folder = 'private-chats/';
    } else if (groupId && groupId.startsWith('private_')) {
      folder = 'private-chats/';
      finalGroupId = groupId.replace('private_', '');
    } else if (groupId) {
      folder = 'group-chats/';
    } else {
      folder = 'misc/';
    }

    if (finalGroupId && folder !== 'news/') {
      const hasAccess = await withStrictTimeout(
        checkChatAccess(req.user.uid, finalGroupId, folder === 'private-chats/'),
        5000,
        'chat access check'
      );
      if (!hasAccess) {
        return res.status(403).json({ error: "Нет доступа к этому чату" });
      }
    }

    const timestamp = Date.now();
    const uniqueId = uuidv4().substring(0, 8);
    const safeFileName = finalFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `${folder}${finalGroupId ? finalGroupId + '/' : ''}${timestamp}_${uniqueId}_${safeFileName}`;

    const signedUrlParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: String(fileType),
      ACL: "public-read"
    };

    const command = new PutObjectCommand(signedUrlParams);
    const uploadUrl = await withStrictTimeout(
      getSignedUrl(s3, command, { expiresIn: 300 }),
      5000,
      'S3 signed URL generation'
    );
    const fileUrl = `https://${BUCKET_NAME}.storage.yandexcloud.net/${key}`;

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

    if (err.message.includes('timeout')) {
      return res.status(408).json({
        success: false,
        error: "Операция генерации URL заняла слишком много времени"
      });
    }

    if (err.name === 'CredentialsProviderError') {
      return res.status(500).json({
        success: false,
        error: "Ошибка конфигурации S3: проверьте credentials"
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
    if (isPrivate) {
      const parts = chatId.split('_');
      return parts.includes(userId);
    } else {
      const groupData = await getGroupWithCache(chatId);
      return !!groupData;
    }
  } catch (error) {
    console.error('Ошибка проверки доступа к чату:', error);
    return false;
  }
}

// Функция для определения типа чата
async function isPrivateChatId(chatId) {
  try {
    if (chatId.includes('_')) {
      const privateChatRef = db.ref(`chats/private/${chatId}`);
      const privateSnap = await withStrictTimeout(
        privateChatRef.once('value'),
        5000,
        'private chat check'
      );

      if (privateSnap.exists()) {
        return true;
      }

      const groupChatRef = db.ref(`chats/groups/${chatId}`);
      const groupSnap = await withStrictTimeout(
        groupChatRef.once('value'),
        5000,
        'group chat check'
      );

      if (groupSnap.exists()) {
        return false;
      }

      return true;
    }

    const groupChatRef = db.ref(`chats/groups/${chatId}`);
    const groupSnap = await withStrictTimeout(
      groupChatRef.once('value'),
      5000,
      'group chat existence check'
    );

    return !groupSnap.exists();
  } catch (error) {
    console.error("❌ Ошибка определения типа чата:", error);
    return chatId.includes('_');
  }
}

// 🔥 ОПТИМИЗИРОВАННЫЙ поиск родителей
async function findParentsByGroupIdOptimized(groupId) {
  try {
    const groupData = await getGroupWithCache(groupId);
    const childrenInGroup = groupData?.children || {};
    const childIds = Object.keys(childrenInGroup);

    if (childIds.length === 0) return [];

    const usersSnap = await withStrictTimeout(
      db.ref('users').once('value'),
      10000,
      'optimized parents search'
    );

    const users = usersSnap.val() || {};
    const parents = [];
    const foundParentIds = new Set();

    // Оптимизированный алгоритм поиска
    const childNamesMap = new Map();
    Object.entries(childrenInGroup).forEach(([childId, childName]) => {
      childNamesMap.set(childName.trim().toLowerCase(), childId);
    });

    for (const [userId, user] of Object.entries(users)) {
      if (user.role === "Родитель" && user.children && !foundParentIds.has(userId)) {

        for (const [parentChildId, parentChildData] of Object.entries(user.children)) {
          if (parentChildData && parentChildData.fullName) {
            const normalizedName = parentChildData.fullName.trim().toLowerCase();

            if (childNamesMap.has(normalizedName)) {
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
              break;
            }
          }
        }
      }
    }

    return parents;

  } catch (error) {
    console.error("❌ Ошибка оптимизированного поиска родителей:", error);
    return [];
  }
}

// === Отправка сообщений ===
app.post("/send-message", verifyToken, async (req, res) => {
  try {
    const { chatId, message, messageType = "text", fileUrl, fileName } = req.body;
    const senderId = req.user.uid;

    if (!chatId || !message) {
      return res.status(400).json({ error: "chatId и message обязательны" });
    }

    const senderSnap = await withStrictTimeout(
      db.ref(`users/${senderId}`).once('value'),
      5000,
      'sender user fetch'
    );
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

    const isPrivateChat = await withStrictTimeout(
      isPrivateChatId(chatId),
      5000,
      'chat type detection'
    );

    let chatRef;
    if (isPrivateChat) {
      chatRef = db.ref(`chats/private/${chatId}/messages/${messageId}`);
    } else {
      chatRef = db.ref(`chats/groups/${chatId}/messages/${messageId}`);
    }

    await chatRef.set(messageData);

    // Уведомления в фоне
    sendChatNotification({
      chatId,
      senderId,
      senderName,
      message,
      messageType,
      fileUrl,
      fileName,
      isPrivate: isPrivateChat
    }).catch(err => console.error("❌ Ошибка отправки уведомления:", err));

    res.json({
      success: true,
      messageId,
      timestamp: messageData.timestamp
    });

  } catch (err) {
    performanceMetrics.errors++;

    if (err.message.includes('timeout')) {
      return res.status(408).json({ error: "Операция заняла слишком много времени" });
    }

    console.error("❌ Ошибка отправки сообщения:", err);
    res.status(500).json({ error: err.message });
  }
});

// === FCM токены ===
app.post("/save-fcm-token", verifyToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user.uid;

    if (!fcmToken) {
      return res.status(400).json({ error: "fcmToken обязателен" });
    }

    await db.ref(`users/${userId}`).update({
      fcmToken,
      fcmTokenUpdated: Date.now()
    });

    res.json({ success: true });

  } catch (err) {
    performanceMetrics.errors++;
    console.error("❌ Ошибка сохранения FCM токена:", err);
    res.status(500).json({ error: err.message });
  }
});

async function removeInvalidToken(invalidToken) {
  try {
    const usersSnap = await withStrictTimeout(
      db.ref('users').once('value'),
      10000,
      'users fetch for token removal'
    );
    const users = usersSnap.val() || {};

    for (const [userId, user] of Object.entries(users)) {
      if (user.fcmToken === invalidToken) {
        await db.ref(`users/${userId}`).update({ fcmToken: null });
        return { success: true, userId };
      }
    }

    return { success: false, message: "Токен не найден" };

  } catch (err) {
    console.error("❌ Ошибка удаления токена:", err);
    return { success: false, error: err.message };
  }
}

// === Уведомления о событиях ===
app.post("/send-event-notification", verifyToken, async (req, res) => {
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
      return res.status(400).json({
        error: "groupId, eventId, title обязательны"
      });
    }

    const actualGroupName = await withStrictTimeout(
      getGroupName(groupId),
      5000,
      'group name fetch'
    );

    const parents = await withStrictTimeout(
      findParentsByGroupIdOptimized(groupId),
      15000,
      'optimized parents search'
    );

    if (parents.length === 0) {
      return res.json({
        success: true,
        message: "Событие создано, но родители не найдены"
      });
    }

    const parentsWithTokens = parents.filter(parent => parent.fcmToken && parent.fcmToken.trim() !== "");
    const notificationBody = formatEventNotification(title, time, place, actualGroupName);

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

    res.json({
      success: true,
      message: `Уведомления отправлены ${sendResults.successful} родителям`,
      recipients: sendResults.successful,
      totalParents: parents.length,
      parentsWithTokens: sendResults.successful
    });

  } catch (err) {
    performanceMetrics.errors++;

    if (err.message.includes('timeout')) {
      return res.status(408).json({
        error: "Операция поиска родителей заняла слишком много времени"
      });
    }

    console.error("❌ Ошибка отправки уведомления о событии:", err);
    res.status(500).json({
      error: "Внутренняя ошибка сервера: " + err.message
    });
  }
});

// Вспомогательные функции
async function getGroupName(groupId) {
  try {
    const groupData = await getGroupWithCache(groupId);
    return groupData?.name || `Группа ${groupId}`;
  } catch (error) {
    console.error("❌ Ошибка получения названия группы:", error);
    return `Группа ${groupId}`;
  }
}

function formatEventNotification(title, time, place, groupName) {
  let notification = `📅 ${title}`;
  if (time) notification += ` в ${time}`;
  if (place) notification += ` (${place})`;
  if (groupName) notification += ` • ${groupName}`;
  return notification;
}

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
    let recipients = [];
    let chatTitle = "";

    if (isPrivate) {
      const parts = chatId.split('_');
      const otherUserId = parts.find(id => id !== senderId);

      if (otherUserId) {
        const userSnap = await withStrictTimeout(
          db.ref(`users/${otherUserId}`).once('value'),
          5000,
          'private chat user fetch'
        );
        const user = userSnap.val();
        if (user && user.fcmToken) {
          recipients.push({
            userId: otherUserId,
            name: user.name || "Пользователь",
            fcmToken: user.fcmToken
          });
        }
      }
    } else {
      const group = await getGroupWithCache(chatId);
      if (group) {
        chatTitle = group.name || "Групповой чат";

        if (group.teachers) {
          for (const [teacherId, teacherName] of Object.entries(group.teachers)) {
            if (teacherId !== senderId) {
              const teacherSnap = await withStrictTimeout(
                db.ref(`users/${teacherId}`).once('value'),
                3000,
                `teacher ${teacherId} fetch`
              );
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
      }
    }

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
      } catch (tokenError) {
        if (tokenError.code === "messaging/registration-token-not-registered") {
          await removeInvalidToken(recipient.fcmToken);
        }
      }
    }

    return { successful, total: recipients.length };

  } catch (error) {
    console.error("❌ Ошибка в sendChatNotification:", error);
    return { successful: 0, total: 0 };
  }
}

function getFileTypeText(messageType) {
  switch (messageType) {
    case 'image': return 'Изображение';
    case 'video': return 'Видео';
    case 'audio': return 'Аудио';
    case 'file': return 'Файл';
    default: return 'Файл';
  }
}

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
    let successful = 0;
    let failed = 0;

    for (const parent of parentsWithTokens) {
      try {
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

        await admin.messaging().send(messagePayload);
        successful++;
      } catch (tokenError) {
        failed++;
        if (tokenError.code === "messaging/registration-token-not-registered") {
          await removeInvalidToken(parent.fcmToken);
        }
      }
    }

    return { successful, failed, totalTokens: parentsWithTokens.length };

  } catch (err) {
    console.error("❌ Ошибка в sendEventNotifications:", err);
    return { successful: 0, failed: parents.length };
  }
}

// 🔥 ОПТИМИЗИРОВАННЫЙ keep-alive
const keepAliveOptimized = () => {
  setInterval(async () => {
    try {
      const http = require('http');
      const req = http.request({
        hostname: process.env.RENDER_EXTERNAL_HOSTNAME,
        port: 80,
        path: '/health',
        method: 'GET',
        timeout: 2000
      }, (res) => {
        if (res.statusCode !== 200 && process.env.NODE_ENV === 'development') {
          console.log('💓 Keep-alive status:', res.statusCode);
        }
      });

      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
      req.end();
    } catch (error) {
      // Игнорируем ошибки keep-alive
    }
  }, 10 * 60 * 1000); // 10 минут
};

// === Health checks и мониторинг ===
app.get("/health", (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    status: "OK",
    timestamp: Date.now(),
    memory: {
      rss: Math.round(memory.rss / 1024 / 1024) + "MB",
      heap: Math.round(memory.heapUsed / 1024 / 1024) + "MB"
    },
    uptime: Math.round(process.uptime()) + "s",
    quickCacheSize: quickCache.size
  });
});

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

app.get("/info", (req, res) => {
  res.json({
    service: "Firebase Admin Notification Server",
    version: "1.0.0",
    endpoints: {
      "POST /send-event-notification": "Отправка уведомлений о новых событиях",
      "GET /health": "Проверка работоспособности сервера",
      "GET /info": "Информация о сервере",
      "GET /ping": "Пинг с диагностикой",
      "GET /stress-test": "Тест нагрузки",
      "GET /metrics": "Метрики производительности"
    },
    features: [
      "Отправка FCM уведомлений о событиях",
      "Автоматическое удаление невалидных токенов",
      "Оптимизированный поиск родителей",
      "Кэширование Firebase запросов",
      "Строгие таймауты для всех операций",
      "Мониторинг памяти и производительности"
    ]
  });
});

app.get("/ping", async (req, res) => {
  const start = Date.now();
  const diagnostics = {};

  try {
    const fbStart = Date.now();
    await withStrictTimeout(
      db.ref('.info/connected').once('value'),
      3000,
      'Firebase ping'
    );
    diagnostics.firebase = `${Date.now() - fbStart}ms`;
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

app.get("/stress-test", async (req, res) => {
  const start = Date.now();
  const tests = [];
  tests.push({ name: "simple_response", time: "0ms" });

  const fbStart = Date.now();
  try {
    await withStrictTimeout(
      db.ref('.info/connected').once('value'),
      3000,
      'Firebase stress test'
    );
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

app.get("/", (req, res) => {
  res.json({
    message: "Firebase Admin Server is running (OPTIMIZED)",
    timestamp: Date.now(),
    endpoints: [
      "/health - Health check",
      "/info - Server information",
      "/ping - Ping with diagnostics",
      "/stress-test - Load test",
      "/metrics - Performance metrics"
    ]
  });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server started on port ${PORT} (OPTIMIZED VERSION)`);
  console.log(`✅ Memory limit: ${MEMORY_LIMIT / 1024 / 1024}MB`);
  console.log(`✅ Cache limit: ${CACHE_LIMIT} entries`);
  console.log(`✅ Firebase timeout: ${FIREBASE_TIMEOUT}ms`);
  console.log(`✅ S3 timeout: ${S3_TIMEOUT}ms`);
  keepAliveOptimized();
});

// Graceful shutdown
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

// 🔥 Emergency memory handler
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning' ||
      warning.message.includes('memory')) {
    console.error('🚨 EMERGENCY: Memory warning detected');

    if (!emergencyMode) {
      emergencyMode = true;
      quickCache.clear();
      if (global.gc) global.gc();

      setTimeout(() => {
        emergencyMode = false;
      }, 60000);
    }
  }
});