// ==================== НОВОЕ: Оптимизации пула потоков и памяти ====================
require('dotenv').config();

// Увеличиваем лимиты Node.js для высоких нагрузок
const os = require('os');
const THREAD_POOL_SIZE = process.env.UV_THREADPOOL_SIZE || 128;
process.env.UV_THREADPOOL_SIZE = THREAD_POOL_SIZE;

console.log(`🚀 Оптимизация запущена:`);
console.log(`   CPU cores: ${os.cpus().length}`);
console.log(`   Thread pool: ${THREAD_POOL_SIZE}`);
console.log(`   Memory: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`);

// ==================== НОВОЕ: Оптимизация пула соединений ====================
const https = require('https');
const http = require('http');

// Увеличиваем максимальное количество сокетов
https.globalAgent.maxSockets = Infinity;
http.globalAgent.maxSockets = Infinity;
https.globalAgent.maxFreeSockets = 256;
http.globalAgent.maxFreeSockets = 256;

process.on('uncaughtException', (error) => {
  console.error('🔥 НЕОБРАБОТАННОЕ ИСКЛЮЧЕНИЕ:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 НЕОБРАБОТАННЫЙ ПРОМИС:', reason);
});

// ==================== ОПТИМИЗАЦИЯ №1: УЛУЧШЕННЫЙ LRU КЭШ ====================
class OptimizedLRUCache {
  constructor(maxSize = 2000, maxMemoryMB = 800) {
    this.maxSize = maxSize;
    this.maxMemoryBytes = maxMemoryMB * 1024 * 1024;
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.stats.misses++;
      return null;
    }

    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    this.stats.hits++;

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
      this.stats.evictions++;
    }

    this.cache.set(key, item);

    if (this.cache.size % 5 === 0) {
      this.cleanup();
    }
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (let [key, value] of this.cache.entries()) {
      if (now - value.timestamp > value.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Автоочистка кэша: удалено ${cleaned} устаревших записей`);
    }
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) + '%' : '0%',
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

  emergencyCleanup() {
    const currentSize = this.cache.size;
    const targetSize = Math.floor(this.maxSize * 0.3);

    if (currentSize <= targetSize) return 0;

    let deleted = 0;
    const keysToDelete = [];

    for (let [key] of this.cache.entries()) {
      if (deleted >= currentSize - targetSize) break;
      keysToDelete.push(key);
      deleted++;
    }

    keysToDelete.forEach(key => this.cache.delete(key));
    return deleted;
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ ОПТИМИЗИРОВАННОГО КЭША ====================
const quickCache = new OptimizedLRUCache(2000, 800);

// ==================== ОПТИМИЗАЦИЯ №2: УВЕЛИЧЕННЫЕ ТАЙМАУТЫ И RETRY ЛОГИКА ====================
const FIREBASE_TIMEOUT = 20000;
const S3_TIMEOUT = 45000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY = 1000;

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
const MEMORY_LIMIT = 800 * 1024 * 1024;
let emergencyMode = false;

setInterval(() => {
  const memory = process.memoryUsage();
  const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);
  const memoryLimitMB = MEMORY_LIMIT / 1024 / 1024;

  if (heapUsedMB > memoryLimitMB * 0.8) {
    console.warn('🚨 ВЫСОКАЯ ЗАГРУЗКА ПАМЯТИ:', {
      используется: heapUsedMB + 'MB',
      всего: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
      лимит: memoryLimitMB + 'MB'
    });

    const now = Date.now();
    let cleanedCount = 0;

    for (let [key, value] of quickCache.cache.entries()) {
      if (now - value.timestamp > 30000) {
        quickCache.cache.delete(key);
        cleanedCount++;
      }
    }

    console.log(`🧹 Очистка памяти: удалено ${cleanedCount} старых записей кэша`);

    if (global.gc) {
      global.gc();
      console.log('🔄 Сборка мусора выполнена');
    }
  }

  if (process.env.NODE_ENV === 'development' && Date.now() % 300000 < 1000) {
    console.log('📊 Статистика кэша:', quickCache.getStats());
  }
}, 15000);

const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();

// ==================== НОВОЕ: Лимитер запросов ====================
const rateLimit = require('express-rate-limit');

const heavyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: {
    error: "Слишком много запросов, попробуйте позже",
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(cors());
app.use(express.json());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Применяем лимитеры
app.use("/send-event-notification", heavyLimiter);
app.use("/generate-upload-url", heavyLimiter);
app.use("/news", apiLimiter);
app.use("/send-message", apiLimiter);

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

  const firebaseConfig = {
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL,
    httpAgent: new https.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: 30000,
      freeSocketTimeout: 30000
    })
  };

  admin.initializeApp(firebaseConfig);
  console.log("✅ Firebase инициализирован с оптимизированными настройками");
} catch (err) {
  console.error("🔥 Ошибка инициализации Firebase:", err);
}

const db = admin.database();
const auth = admin.auth();

// ==================== ОПТИМИЗАЦИЯ AWS SDK ====================
const s3 = new S3Client({
  region: process.env.YC_S3_REGION || "ru-central1",
  endpoint: process.env.YC_S3_ENDPOINT || "https://storage.yandexcloud.net",
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY,
    secretAccessKey: process.env.YC_SECRET_KEY,
  }
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
      10000
    );
    const groupData = groupSnap.val();

    if (groupData) {
      quickCache.set(cacheKey, groupData, 600000);
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
  cacheHits: 0,
  cacheMisses: 0,
  startTime: Date.now()
};

// 🔥 Middleware логирования
app.use((req, res, next) => {
  if (req.url === '/health' || req.url === '/ping' || req.url === '/metrics' ||
      req.url === '/light-ping' || req.url === '/load-metrics') {
    return next();
  }

  performanceMetrics.requests++;
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);

  if (process.env.NODE_ENV === 'development') {
    console.log(`📨 [${requestId}] ${req.method} ${req.url} - Начало`);
  }

  res.on('finish', () => {
    const duration = Date.now() - start;
    const isSlow = duration > 3000;

    if (isSlow) {
      performanceMetrics.slowRequests++;
      console.warn(`🐌 [${requestId}] МЕДЛЕННО: ${req.method} ${req.url} - ${duration}мс`);
    }

    if (process.env.NODE_ENV === 'development' || duration > 1000) {
      console.log(`✅ [${requestId}] ${req.method} ${req.url} - ${duration}мс`);
    }
  });

  next();
});

// ==================== УПРОЩЕННЫЕ HEALTH CHECKS ====================

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: Date.now(),
    uptime: Math.round(process.uptime())
  });
});

app.get("/light-ping", (req, res) => {
  res.json({
    pong: Date.now(),
    status: "alive",
    version: "2.0.0-optimized"
  });
});

app.get("/load-metrics", (req, res) => {
  const load = os.loadavg();
  const memory = process.memoryUsage();
  const uptime = Date.now() - performanceMetrics.startTime;
  const requestsPerMinute = (performanceMetrics.requests / (uptime / 60000)).toFixed(2);

  res.json({
    loadAverage: load,
    memory: {
      used: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(memory.rss / 1024 / 1024) + 'MB'
    },
    performance: {
      activeRequests: performanceMetrics.requests,
      requestsPerMinute: requestsPerMinute,
      errorRate: ((performanceMetrics.errors / Math.max(performanceMetrics.requests, 1)) * 100).toFixed(2) + '%',
      slowRequests: performanceMetrics.slowRequests
    },
    cache: quickCache.getStats(),
    system: {
      cpuCores: os.cpus().length,
      threadPool: THREAD_POOL_SIZE,
      uptime: Math.round(process.uptime()) + 's'
    }
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Firebase Admin Server работает (ОПТИМИЗИРОВАННАЯ ВЕРСИЯ 2.0)",
    timestamp: Date.now(),
    endpoints: [
      "/light-ping - Быстрый пинг для тестирования",
      "/load-metrics - Метрики нагрузки",
      "/health - Упрощенная проверка здоровья"
    ]
  });
});

const PORT = process.env.PORT || 3000;

// ==================== ЗАПУСК СЕРВЕРА ====================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT} (ОПТИМИЗИРОВАННАЯ ВЕРСИЯ 2.0)`);
  console.log(`✅ Лимит памяти: ${MEMORY_LIMIT / 1024 / 1024}MB`);
  console.log(`✅ Лимит кэша: ${quickCache.maxSize} записей`);
  console.log(`✅ Таймаут Firebase: ${FIREBASE_TIMEOUT}мс`);
  console.log(`✅ Таймаут S3: ${S3_TIMEOUT}мс`);
  console.log(`✅ Попытки повтора: ${RETRY_ATTEMPTS}`);
  console.log(`✅ Размер пула потоков: ${THREAD_POOL_SIZE}`);
  console.log(`✅ Лимитер запросов: включен`);
});

server.keepAliveTimeout = 60000;
server.headersTimeout = 65000;

// 🔄 ОБРАБОТКА SIGTERM
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

console.log('🚀 Оптимизация сервера завершена:');
console.log('   • LRU Кэш улучшен и увеличен');
console.log('   • Пул потоков увеличен до 128');
console.log('   • Пул соединений оптимизирован');
console.log('   • Лимитер запросов реализован');
console.log('   • Таймауты уменьшены для лучшей отзывчивости');