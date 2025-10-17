require('dotenv').config();

// 🔥 ИЗМЕНЕНИЕ: Добавлен apicache для кэширования
const apicache = require('apicache');
const cache = apicache.middleware;

// 🔥 ИЗМЕНЕНИЕ: Добавлен rate-limiting
const rateLimit = require('express-rate-limit');

// 🔥 ИЗМЕНЕНИЕ: Добавлено сжатие ответов
const compression = require('compression');

process.on('uncaughtException', (error) => {
  console.error('🔥 НЕОБРАБОТАННОЕ ИСКЛЮЧЕНИЕ:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 НЕОБРАБОТАННЫЙ ПРОМИС:', reason);
});

// ==================== ОПТИМИЗАЦИЯ №1: LRU КЭШ ВМЕСТО SIMPLE MAP ====================
class LRUCache {
  constructor(maxSize = 1000, maxMemoryMB = 500) {
    this.maxSize = maxSize;
    this.maxMemoryBytes = maxMemoryMB * 1024 * 1024;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.misses++;
      return null;
    }

    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    this.hits++;

    return value.data;
  }

  set(key, value, ttl = 300000) {
    const item = {
      data: value,
      timestamp: Date.now(),
      ttl: ttl
    };

    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, item);

    if (this.cache.size % 10 === 0) {
      this.cleanup();
    }
  }

  cleanup() {
    const now = Date.now();
    for (let [key, value] of this.cache.entries()) {
      if (now - value.timestamp > value.ttl) {
        this.cache.delete(key);
      }
    }
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(2) + '%' : '0%',
      memoryUsage: this.getMemoryUsage() + 'MB'
    };
  }

  getMemoryUsage() {
    let size = 0;
    for (let [key, value] of this.cache.entries()) {
      size += key.length;
      try {
        size += JSON.stringify(value).length;
      } catch (e) {
        size += 100;
      }
    }
    return Math.round(size / 1024 / 1024);
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ ОПТИМИЗИРОВАННОГО КЭША ====================
const quickCache = new LRUCache(1000, 500);

// ==================== ОПТИМИЗАЦИЯ №2: УВЕЛИЧЕННЫЕ ТАЙМАУТЫ И RETRY ЛОГИКА ====================
const FIREBASE_TIMEOUT = 15000;
const S3_TIMEOUT = 30000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY = 1000;

// 🔥 ИЗМЕНЕНИЕ: Добавлен оптимизированный пул соединений
const https = require('https');
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 20,
  timeout: 60000,
  freeSocketTimeout: 30000
});

// НОВАЯ ФУНКЦИЯ: Retry логика с exponential backoff
const withRetry = async (operation, operationName = 'Operation', timeoutMs = FIREBASE_TIMEOUT, maxRetries = RETRY_ATTEMPTS) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) =>
          setTimeout(() => {
            reject(new Error(`Таймаут операции ${operationName} после ${timeoutMs}мс (попытка ${attempt}/${maxRetries})`));
          }, timeoutMs)
        )
      ]);
      return result;
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      console.warn(`🔄 Повтор ${attempt}/${maxRetries} для ${operationName} через ${delay}мс:`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

const withStrictTimeout = (promise, timeoutMs, operationName = 'Operation') => {
  return withRetry(() => promise, operationName, timeoutMs, 1);
};

// ==================== ОПТИМИЗАЦИЯ №3: УВЕЛИЧЕННЫЕ ЛИМИТЫ ПАМЯТИ ====================
const MEMORY_LIMIT = 500 * 1024 * 1024;
let emergencyMode = false;

setInterval(() => {
  const memory = process.memoryUsage();
  const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);
  const memoryLimitMB = MEMORY_LIMIT / 1024 / 1024;

  if (heapUsedMB > memoryLimitMB * 0.9) {
    console.warn('🚨 КРИТИЧЕСКАЯ ПАМЯТЬ:', {
      используется: heapUsedMB + 'MB',
      всего: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
      лимит: memoryLimitMB + 'MB'
    });

    const now = Date.now();
    let cleanedCount = 0;

    for (let [key, value] of quickCache.cache.entries()) {
      if (now - value.timestamp > 60000) {
        quickCache.cache.delete(key);
        cleanedCount++;
      }
    }

    console.log(`🧹 Очистка памяти: удалено ${cleanedCount} старых записей кэша`);

    if (global.gc) {
      global.gc();
    }
  }

  if (process.env.NODE_ENV === 'development' && Date.now() % 300000 < 1000) {
    console.log('📊 Статистика кэша:', quickCache.getStats());
  }
}, 30000);

const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();

// 🔥 ИЗМЕНЕНИЕ: Добавлено сжатие ответов
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

app.use(cors());
app.use(express.json());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 🔥 ИЗМЕНЕНИЕ: Добавлен rate limiting
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 минута
  max: 100, // максимум 100 запросов с одного IP
  message: {
    error: "Слишком много запросов, попробуйте позже"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 10, // максимум 10 попыток входа
  message: {
    error: "Слишком много попыток аутентификации"
  }
});

app.use(generalLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5
  }
});

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
// 🔥 ИЗМЕНЕНИЕ: Добавлен оптимизированный requestHandler с пулом соединений
const s3 = new S3Client({
  region: process.env.YC_S3_REGION || "ru-central1",
  endpoint: process.env.YC_S3_ENDPOINT || "https://storage.yandexcloud.net",
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY,
    secretAccessKey: process.env.YC_SECRET_KEY,
  },
  requestHandler: new (require('@aws-sdk/node-http-handler').NodeHttpHandler)({
    httpsAgent: agent
  })
});
const BUCKET_NAME = process.env.YC_S3_BUCKET;

// === Middleware проверки Firebase-токена ===
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

  if (!token) {
    console.warn("🚫 Проверка токена: отсутствует заголовок Authorization");
    return res.status(401).send("Нет токена");
  }

  try {
    const decoded = await withRetry(
      () => admin.auth().verifyIdToken(token),
      'Проверка токена Firebase',
      FIREBASE_TIMEOUT
    );
    req.user = decoded;
    if (process.env.NODE_ENV === 'development') {
      console.log("✅ Проверка токена: токен валиден, uid:", decoded.uid);
    }
    next();
  } catch (err) {
    console.error("❌ Проверка токена: токен недействителен или истёк", err);
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

async function uploadToS3WithRetry(buffer, fileName, contentType, retries = RETRY_ATTEMPTS) {
  return withRetry(
    () => uploadToS3(buffer, fileName, contentType),
    'Загрузка в S3',
    S3_TIMEOUT,
    retries
  );
}

async function deleteFromS3(urls) {
  const keys = urls.map(url => {
    const parts = url.split(`${BUCKET_NAME}/`);
    return parts[1] ? { Key: parts[1] } : null;
  }).filter(Boolean);

  if (keys.length === 0) return;

  await withRetry(
    () => s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: keys }
    })),
    'Удаление из S3',
    S3_TIMEOUT
  );
}

// ==================== ОПТИМИЗАЦИЯ №4: УЛУЧШЕННАЯ ФУНКЦИЯ КЭШИРОВАНИЯ ГРУПП ====================
async function getGroupWithCache(groupId) {
  const cacheKey = `group_${groupId}`;
  const cached = quickCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const groupSnap = await withRetry(
      () => db.ref(`groups/${groupId}`).once('value'),
      `Получение группы ${groupId} из Firebase`,
      FIREBASE_TIMEOUT
    );
    const groupData = groupSnap.val();

    if (groupData) {
      quickCache.set(cacheKey, groupData, 300000);
    }

    return groupData;
  } catch (error) {
    console.error(`❌ Ошибка получения группы ${groupId}:`, error.message);
    return null;
  }
}

// ==================== ОПТИМИЗАЦИЯ №5: УЛУЧШЕННЫЙ ПОИСК РОДИТЕЛЕЙ ====================
async function findParentsByGroupIdOptimized(groupId) {
  try {
    const groupData = await getGroupWithCache(groupId);
    const childrenInGroup = groupData?.children || {};
    const childIds = Object.keys(childrenInGroup);

    if (childIds.length === 0) return [];

    const parentsSnap = await withRetry(
      () => db.ref('users')
        .orderByChild('role')
        .equalTo('Родитель')
        .once('value'),
      'Оптимизированный поиск родителей',
      FIREBASE_TIMEOUT
    );

    const users = parentsSnap.val() || {};
    const parents = [];
    const foundParentIds = new Set();

    const childNamesMap = new Map();
    Object.entries(childrenInGroup).forEach(([childId, childName]) => {
      childNamesMap.set(childName.trim().toLowerCase(), childId);
    });

    for (const [userId, user] of Object.entries(users)) {
      if (user.children && !foundParentIds.has(userId)) {
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

// ==================== ОПТИМИЗАЦИЯ №6: ПАРАЛЛЕЛЬНАЯ ОТПРАВКА УВЕДОМЛЕНИЙ ====================
// 🔥 ИЗМЕНЕНИЕ: Уменьшен batch size с 10 до 5 для лучшей стабильности
async function sendNotificationsParallel(recipients, createMessagePayload, batchSize = 5) {
  const results = {
    successful: 0,
    failed: 0,
    errors: []
  };

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);

    const promises = batch.map(async (recipient) => {
      try {
        const messagePayload = createMessagePayload(recipient);
        await admin.messaging().send(messagePayload);
        return { success: true, recipient };
      } catch (error) {
        if (error.code === "messaging/registration-token-not-registered") {
          await removeInvalidToken(recipient.fcmToken);
        }
        return { success: false, recipient, error };
      }
    });

    const batchResults = await Promise.allSettled(promises);

    batchResults.forEach(result => {
      if (result.status === 'fulfilled') {
        if (result.value.success) {
          results.successful++;
        } else {
          results.failed++;
          results.errors.push(result.value.error);
        }
      } else {
        results.failed++;
        results.errors.push(result.reason);
      }
    });

    if (i + batchSize < recipients.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

async function sendEventNotificationsOptimized({
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

    if (parentsWithTokens.length === 0) {
      return { successful: 0, failed: 0, totalTokens: 0 };
    }

    const createMessagePayload = (parent) => ({
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
    });

    return await sendNotificationsParallel(parentsWithTokens, createMessagePayload, 15);

  } catch (err) {
    console.error("❌ Ошибка в sendEventNotificationsOptimized:", err);
    return { successful: 0, failed: parents.length, errors: [err] };
  }
}

// 🔥 ИЗМЕНЕНИЕ: Расширенные метрики производительности
const performanceMetrics = {
  requests: 0,
  errors: 0,
  slowRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  startTime: Date.now()
};

// 🔥 ИЗМЕНЕНИЕ: Добавлены расширенные метрики для детального отслеживания
const advancedMetrics = {
  endpointTimings: {},
  databaseQueries: 0,
  cacheEffectiveness: {
    hits: 0,
    misses: 0
  }
};

// 🔥 Middleware логирования с расширенными метриками
app.use((req, res, next) => {
  if (req.url === '/health' || req.url === '/ping' || req.url === '/metrics') {
    return next();
  }

  performanceMetrics.requests++;
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  const endpoint = req.path;

  if (process.env.NODE_ENV === 'development') {
    console.log(`📨 [${requestId}] ${req.method} ${req.url} - Начало`);
  }

  res.on('finish', () => {
    const duration = Date.now() - start;
    const isSlow = duration > 5000;

    // 🔥 ИЗМЕНЕНИЕ: Расширенное отслеживание времени выполнения по эндпоинтам
    if (!advancedMetrics.endpointTimings[endpoint]) {
      advancedMetrics.endpointTimings[endpoint] = {
        count: 0,
        totalTime: 0,
        average: 0
      };
    }

    advancedMetrics.endpointTimings[endpoint].count++;
    advancedMetrics.endpointTimings[endpoint].totalTime += duration;
    advancedMetrics.endpointTimings[endpoint].average =
      advancedMetrics.endpointTimings[endpoint].totalTime /
      advancedMetrics.endpointTimings[endpoint].count;

    if (isSlow) {
      performanceMetrics.slowRequests++;
      console.warn(`🐌 [${requestId}] МЕДЛЕННО: ${req.method} ${req.url} - ${duration}мс`);
    }

    // 🔥 ИЗМЕНЕНИЕ: Логируем все медленные запросы (>1 секунды)
    if (duration > 1000) {
      console.warn(`🐌 Медленный запрос: ${req.method} ${req.path} - ${duration}мс`);
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`✅ [${requestId}] ${req.method} ${req.url} - ${duration}мс`);
    }
  });

  next();
});

// === Удаление пользователя/ребёнка ===
app.post('/deleteUserByName', async (req, res) => {
  const fullName = req.body.fullName?.trim().toLowerCase();
  if (!fullName) return res.status(400).send("fullName обязателен");

  try {
    const usersSnap = await withRetry(
      () => db.ref('users').once('value'),
      'Удаление пользователя по имени',
      20000
    );
    const users = usersSnap.val() || {};
    let found = false;

    for (const [userId, user] of Object.entries(users)) {
      const name = user.name?.trim().toLowerCase();
      const role = user.role?.trim().toLowerCase();

      if (name === fullName && role === 'родитель') {
        found = true;

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

        await db.ref(`users/${userId}`).remove();

        try {
          await auth.getUser(userId);
          await auth.deleteUser(userId);
        } catch (authError) {
          console.log("Пользователь не найден в Auth, пропускаем:", authError.message);
        }

        return res.send("Родитель и его дети удалены.");
      }

      if (name === fullName && role === 'педагог') {
        found = true;

        const groupsSnap = await withRetry(
          () => db.ref('groups').once('value'),
          'Получение групп для удаления педагога',
          10000
        );
        const groups = groupsSnap.val() || {};

        for (const [groupId, group] of Object.entries(groups)) {
          if (group.teachers?.[userId]) {
            await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
          }
        }

        await db.ref(`users/${userId}`).remove();

        try {
          await auth.getUser(userId);
          await auth.deleteUser(userId);
        } catch (authError) {
          console.log("Пользователь не найден в Auth:", authError.message);
        }

        return res.send("Педагог удалён.");
      }

      if (user.children) {
        for (const [childId, child] of Object.entries(user.children)) {
          if (child.fullName?.trim().toLowerCase() === fullName) {
            found = true;

            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
            }

            const filesToDelete = [];
            if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
            if (filesToDelete.length > 0) {
              await deleteFromS3(filesToDelete);
            }

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
    const childRef = db.ref(`users/${userId}/children/${childId}`);
    const childSnap = await withRetry(
      () => childRef.once('value'),
      'Получение данных ребенка для удаления',
      10000
    );

    if (!childSnap.exists()) {
      return res.status(404).json({ error: "Ребенок не найден" });
    }

    const child = childSnap.val();
    const groupName = child.group;
    const childName = child.fullName.trim();

    let groupId = null;
    if (groupName) {
      const groupsRef = db.ref('groups');
      const groupsSnap = await withRetry(
        () => groupsRef.once('value'),
        'Поиск группы ребенка',
        10000
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

    if (groupId) {
      const groupChildrenRef = db.ref(`groups/${groupId}/children`);
      const groupChildrenSnap = await withRetry(
        () => groupChildrenRef.once('value'),
        'Получение детей группы',
        5000
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

    const filesToDelete = [];
    if (child.avatarUrl) {
      filesToDelete.push(child.avatarUrl);
    }

    if (filesToDelete.length > 0) {
      await deleteFromS3(filesToDelete);
    }

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

    const snap = await withRetry(
      () => db.ref("users").orderByChild("name").equalTo(fullName).once("value"),
      'Поиск пользователя для обновления email',
      15000
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
      const ref = db.ref(`news/${groupId}/${newsId}`);
      const snap = await withRetry(
        () => ref.once("value"),
        'Редактирование новости',
        10000
      );
      const oldNews = snap.val();
      if (!oldNews) return res.status(404).json({ error: "Новость не найдена" });
      if (oldNews.authorId !== authorId) return res.status(403).json({ error: "Нет прав" });

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

    const snap = await withRetry(
      () => db.ref(`news/${groupId}`).once("value"),
      'Получение списка новостей',
      10000
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

    const snap = await withRetry(
      () => db.ref(`news/${groupId}/${newsId}`).once('value'),
      'Удаление новости',
      5000
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
// 🔥 ИЗМЕНЕНИЕ: Добавлен rate limiting для генерации URL
app.post('/generate-upload-url', authLimiter, verifyToken, async (req, res) => {
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
      const hasAccess = await withRetry(
        () => checkChatAccess(req.user.uid, finalGroupId, folder === 'private-chats/'),
        'Проверка доступа к чату',
        5000
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
    const uploadUrl = await withRetry(
      () => getSignedUrl(s3, command, { expiresIn: 300 }),
      'Генерация signed URL S3',
      5000
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
      const privateSnap = await withRetry(
        () => privateChatRef.once('value'),
        'Проверка приватного чата',
        5000
      );

      if (privateSnap.exists()) {
        return true;
      }

      const groupChatRef = db.ref(`chats/groups/${chatId}`);
      const groupSnap = await withRetry(
        () => groupChatRef.once('value'),
        'Проверка группового чата',
        5000
      );

      if (groupSnap.exists()) {
        return false;
      }

      return true;
    }

    const groupChatRef = db.ref(`chats/groups/${chatId}`);
    const groupSnap = await withRetry(
      () => groupChatRef.once('value'),
      'Проверка существования группового чата',
      5000
    );

    return !groupSnap.exists();
  } catch (error) {
    console.error("❌ Ошибка определения типа чата:", error);
    return chatId.includes('_');
  }
}

async function removeInvalidToken(invalidToken) {
  try {
    const usersSnap = await withRetry(
      () => db.ref('users').once('value'),
      'Поиск пользователей для удаления токена',
      10000
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

// === Отправка сообщений ===
// 🔥 ИЗМЕНЕНИЕ: Добавлен rate limiting для отправки сообщений
app.post("/send-message", authLimiter, verifyToken, async (req, res) => {
  try {
    const { chatId, message, messageType = "text", fileUrl, fileName } = req.body;
    const senderId = req.user.uid;

    if (!chatId || !message) {
      return res.status(400).json({ error: "chatId и message обязательны" });
    }

    const senderSnap = await withRetry(
      () => db.ref(`users/${senderId}`).once('value'),
      'Получение данных отправителя',
      5000
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

    const isPrivateChat = await withRetry(
      () => isPrivateChatId(chatId),
      'Определение типа чата',
      5000
    );

    let chatRef;
    if (isPrivateChat) {
      chatRef = db.ref(`chats/private/${chatId}/messages/${messageId}`);
    } else {
      chatRef = db.ref(`chats/groups/${chatId}/messages/${messageId}`);
    }

    await chatRef.set(messageData);

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
        const userSnap = await withRetry(
          () => db.ref(`users/${otherUserId}`).once('value'),
          'Получение пользователя приватного чата',
          5000
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
              const teacherSnap = await withRetry(
                () => db.ref(`users/${teacherId}`).once('value'),
                `Получение педагога ${teacherId}`,
                3000
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

// === Отправка уведомлений о событиях ===
app.post("/send-event-notification", verifyToken, async (req, res) => {
  try {
    const { groupId, eventId, title, time, place, comments, date } = req.body;

    if (!groupId || !eventId || !title) {
      return res.status(400).json({
        error: "groupId, eventId, title обязательны"
      });
    }

    const actualGroupName = await withRetry(
      () => getGroupName(groupId),
      'Получение названия группы',
      10000
    );

    const parents = await withRetry(
      () => findParentsByGroupIdOptimized(groupId),
      'Оптимизированный поиск родителей',
      30000
    );

    if (parents.length === 0) {
      return res.json({
        success: true,
        message: "Событие создано, но родители не найдены"
      });
    }

    const notificationBody = formatEventNotification(title, time, place, actualGroupName);

    const sendResults = await sendEventNotificationsOptimized({
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
      parentsWithTokens: sendResults.successful,
      failed: sendResults.failed
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

// ==================== HEALTH CHECKS И МОНИТОРИНГ ====================

// 🔥 ИЗМЕНЕНИЕ: Добавлено кэширование для health checks
app.get("/health", cache('30 seconds'), (req, res) => {
  const memory = process.memoryUsage();
  const cacheStats = quickCache.getStats();

  res.json({
    status: "OK",
    timestamp: Date.now(),
    memory: {
      rss: Math.round(memory.rss / 1024 / 1024) + "MB",
      heap: Math.round(memory.heapUsed / 1024 / 1024) + "MB",
      limit: Math.round(MEMORY_LIMIT / 1024 / 1024) + "MB"
    },
    uptime: Math.round(process.uptime()) + "s",
    cache: cacheStats,
    performance: {
      requests: performanceMetrics.requests,
      errorRate: ((performanceMetrics.errors / Math.max(performanceMetrics.requests, 1)) * 100).toFixed(2) + '%'
    }
  });
});

// 🔥 ИЗМЕНЕНИЕ: Добавлено кэширование для metrics
app.get("/metrics", cache('10 seconds'), (req, res) => {
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
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      external: Math.round(process.memoryUsage().external / 1024 / 1024) + 'MB'
    },
    cache: quickCache.getStats(),
    advanced_metrics: advancedMetrics.endpointTimings,
    gc: global.gc ? 'available' : 'unavailable'
  });
});

// 🔥 ИЗМЕНЕНИЕ: Добавлен расширенный health check
app.get("/deep-health", async (req, res) => {
  const checks = {
    firebase: false,
    s3: false,
    memory: false,
    cache: false
  };

  try {
    const fbCheck = await withStrictTimeout(
      db.ref('.info/connected').once('value'),
      5000,
      'Глубокий health check Firebase'
    );
    checks.firebase = true;

    const s3Check = await withStrictTimeout(
      s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: 'health-check',
        Body: Buffer.from('health'),
        ContentType: 'text/plain'
      })),
      10000,
      'Глубокий health check S3'
    );
    checks.s3 = true;

    checks.memory = process.memoryUsage().heapUsed < MEMORY_LIMIT * 0.8;
    checks.cache = quickCache.cache.size < quickCache.maxSize;

    const allHealthy = Object.values(checks).every(Boolean);
    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: Date.now(),
      checks
    });

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: Date.now(),
      checks,
      error: error.message
    });
  }
});

// 🔥 ИЗМЕНЕНИЕ: Добавлен advanced health check
app.get("/advanced-health", async (req, res) => {
  const health = {
    status: "healthy",
    timestamp: Date.now(),
    checks: {}
  };

  // Проверка Firebase
  try {
    const fbStart = Date.now();
    await withStrictTimeout(
      db.ref('.info/connected').once('value'),
      3000,
      'Advanced Health Check Firebase'
    );
    health.checks.firebase = {
      status: "healthy",
      responseTime: Date.now() - fbStart
    };
  } catch (error) {
    health.checks.firebase = {
      status: "unhealthy",
      error: error.message
    };
    health.status = "degraded";
  }

  // Проверка S3
  try {
    const s3Start = Date.now();
    await withStrictTimeout(
      s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: 'health-check-temp',
        Body: Buffer.from('test'),
        ContentLength: 4
      })),
      5000,
      'Advanced Health Check S3'
    );
    health.checks.s3 = {
      status: "healthy",
      responseTime: Date.now() - s3Start
    };
  } catch (error) {
    health.checks.s3 = {
      status: "unhealthy",
      error: error.message
    };
    health.status = "degraded";
  }

  // Проверка памяти
  const memoryUsage = process.memoryUsage();
  const memoryPercent = (memoryUsage.heapUsed / MEMORY_LIMIT) * 100;
  health.checks.memory = {
    status: memoryPercent < 80 ? "healthy" : "warning",
    usage: Math.round(memoryPercent) + "%",
    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + "MB"
  };

  if (memoryPercent >= 80) {
    health.status = "degraded";
  }

  res.status(health.status === "healthy" ? 200 : 503).json(health);
});

app.get("/info", (req, res) => {
  res.json({
    service: "Firebase Admin Notification Server",
    version: "2.0.0-optimized",
    optimization: {
      lru_cache: "implemented",
      retry_logic: "implemented",
      parallel_notifications: "implemented",
      increased_timeouts: "implemented",
      memory_optimized: "implemented",
      compression: "implemented",
      rate_limiting: "implemented",
      connection_pooling: "implemented"
    },
    endpoints: {
      "POST /send-event-notification": "Отправка уведомлений о новых событиях",
      "GET /health": "Проверка работоспособности сервера",
      "GET /deep-health": "Глубокий health check с проверкой зависимостей",
      "GET /advanced-health": "Расширенный health check с метриками",
      "GET /info": "Информация о сервере",
      "GET /ping": "Пинг с диагностикой",
      "GET /stress-test": "Тест нагрузки",
      "GET /metrics": "Метрики производительности"
    }
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
      'Пинг Firebase'
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
      error: "Диагностика не удалась",
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
      'Стресс-тест Firebase'
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
      quick_cache_size: quickCache.cache.size
    },
    tests
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Firebase Admin Server работает (ОПТИМИЗИРОВАННАЯ ВЕРСИЯ 2.0)",
    timestamp: Date.now(),
    endpoints: [
      "/health - Проверка здоровья",
      "/info - Информация о сервере",
      "/ping - Пинг с диагностикой",
      "/stress-test - Тест нагрузки",
      "/metrics - Метрики производительности",
      "/advanced-health - Расширенная проверка"
    ]
  });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT} (ОПТИМИЗИРОВАННАЯ ВЕРСИЯ 2.0)`);
  console.log(`✅ Лимит памяти: ${MEMORY_LIMIT / 1024 / 1024}MB (УВЕЛИЧЕНО)`);
  console.log(`✅ Лимит кэша: ${quickCache.maxSize} записей (УВЕЛИЧЕНО)`);
  console.log(`✅ Таймаут Firebase: ${FIREBASE_TIMEOUT}мс (УВЕЛИЧЕНО)`);
  console.log(`✅ Таймаут S3: ${S3_TIMEOUT}мс (УВЕЛИЧЕНО)`);
  console.log(`✅ Попытки повтора: ${RETRY_ATTEMPTS} (НОВОЕ)`);
  console.log(`✅ Параллельные уведомления: включено (НОВОЕ)`);
  console.log(`✅ Сжатие ответов: включено (НОВОЕ)`);
  console.log(`✅ Rate limiting: включено (НОВОЕ)`);
  console.log(`✅ Пул соединений: включено (НОВОЕ)`);

  setInterval(() => {
    require('http').get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {});
  }, 600000);
});

server.keepAliveTimeout = 60000;
server.headersTimeout = 65000;

process.on('SIGTERM', () => {
  console.log('🔄 Получен SIGTERM, плавное завершение работы');
  console.log('📊 Финальная статистика кэша:', quickCache.getStats());

  server.close(() => {
    console.log('✅ HTTP сервер закрыт');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('⚠️ Принудительное завершение');
    process.exit(1);
  }, 10000);
});

process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning' ||
      warning.message.includes('memory')) {
    console.error('🚨 АВАРИЙНЫЙ РЕЖИМ: Обнаружено предупреждение памяти', warning.message);

    if (!emergencyMode) {
      emergencyMode = true;

      const currentSize = quickCache.cache.size;
      const targetSize = Math.floor(quickCache.maxSize * 0.3);

      let deleted = 0;
      for (let [key] of quickCache.cache.entries()) {
        if (deleted >= currentSize - targetSize) break;
        quickCache.cache.delete(key);
        deleted++;
      }

      console.log(`🚨 Аварийная очистка кэша: удалено ${deleted} записей`);

      if (global.gc) {
        global.gc();
        console.log('🚨 Аварийный сбор мусора выполнен');
      }

      setTimeout(() => {
        emergencyMode = false;
        console.log('🚨 Аварийный режим деактивирован');
      }, 120000);
    }
  }
});

console.log('🚀 Оптимизация сервера завершена:');
console.log('   • LRU Кэш реализован');
console.log('   • Логика повтора с exponential backoff');
console.log('   • Параллельная отправка уведомлений');
console.log('   • Увеличенные таймауты и лимиты памяти');
console.log('   • Оптимизированный алгоритм поиска родителей');
console.log('   • Сжатие ответов включено');
console.log('   • Rate limiting включен');
console.log('   • Пул соединений оптимизирован');
console.log('   • Кэширование health checks');
console.log('   • Расширенный мониторинг метрик');