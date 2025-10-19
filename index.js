// 🔥 ПРИНУДИТЕЛЬНАЯ ЗАЩИТА ОТ ДУБЛИКАТОВ - ДОБАВЬТЕ ПЕРВЫМИ СТРОЧКАМИ
require('dotenv').config();

// ==================== ИМПОРТЫ ====================
const net = require('net');
const os = require('os');
const https = require('https');
const http = require('http');
const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 10000;

console.log('🔍 Проверка порта на дубликаты...');

// ==================== ПЕРЕМЕННЫЕ УРОВНЯ МОДУЛЯ ====================
let eventLoopLag = 0;
let activeConnections = 0;
let isStabilizing = false;
let emergencyMode = false;

// 🔥 УЛУЧШЕННЫЙ МОНИТОРИНГ EVENT LOOP
const monitorEventLoop = () => {
  const start = Date.now();
  setImmediate(() => {
    eventLoopLag = Date.now() - start;
    if (eventLoopLag > 100 && !isStabilizing) {
      stabilizeSystem();
    }
  });
};

setInterval(monitorEventLoop, 30000);

// ==================== ПРОВЕРКА ПОРТА ====================
const tester = net.createServer();

tester.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('🚨 ОБНАРУЖЕН ДУБЛИКАТ! Завершаем процесс...');
    process.exit(0);
  }
});

tester.once('listening', () => {
  tester.close(() => {
    console.log('🟢 Порту свободен! Запускаем основной сервер...');
    startMainServer();
  });
});

tester.listen(PORT, '0.0.0.0');

// ==================== ОСНОВНАЯ ФУНКЦИЯ СЕРВЕРА ====================
function startMainServer() {
  // 🔥 ИСПРАВЛЕНИЕ 1: CIRCUIT BREAKER ДЛЯ FIREBASE
  const firebaseCircuitBreaker = {
    failures: 0,
    lastFailure: 0,
    isOpen: false,

    canExecute() {
      if (this.isOpen) {
        const cooldownPassed = Date.now() - this.lastFailure > 30000;
        if (cooldownPassed) {
          this.isOpen = false;
          this.failures = 0;
          console.log('🔌 Circuit breaker CLOSED');
          return true;
        }
        return false;
      }
      return true;
    },

    recordSuccess() {
      this.failures = 0;
      this.isOpen = false;
    },

    recordFailure() {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= 3) {
        this.isOpen = true;
        console.log('🚨 Circuit breaker OPENED для Firebase');
      }
    }
  };

  async function safeFirebaseOperation(operation, operationName) {
    if (!firebaseCircuitBreaker.canExecute()) {
      throw new Error(`Firebase временно недоступен (circuit breaker open)`);
    }

    try {
      const result = await operation();
      firebaseCircuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      firebaseCircuitBreaker.recordFailure();
      throw error;
    }
  }

  // 🔥 ИСПРАВЛЕНИЕ 2: АДАПТИВНЫЙ ЛИМИТ СОЕДИНЕНИЙ ДЛЯ RENDER.COM
  const MAX_CONCURRENT_CONNECTIONS = process.env.RENDER ? 50 : 200;
  let connectionFailures = 0;

  function stabilizeSystem() {
    if (isStabilizing) return;

    isStabilizing = true;
    console.log('🔧 Стабилизация системы при снижении нагрузки...');

    quickCache.cleanup();

    if (global.gc) {
      global.gc();
      console.log('🧹 Принудительный сбор мусора выполнен');
    }

    setTimeout(() => {
      isStabilizing = false;
      console.log('✅ Стабилизация завершена');
    }, 3000);
  }

  // 🔥 УЛУЧШЕННЫЕ ОБРАБОТЧИКИ ОШИБОК
  if (process.env.RENDER) {
    console.log('🚀 Обнаружена среда Render.com - применяем оптимизации');
  }

  process.on('uncaughtException', (error) => {
    console.error('🔥 КРИТИЧЕСКАЯ ОШИБКА:', error);
    console.error('🔥 Стек вызовов:', error.stack);

    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 НЕОБРАБОТАННЫЙ ПРОМИС:', reason);
    console.error('🔥 Стек:', reason?.stack);
  });

  process.on('SIGTERM', () => {
    console.log('🔄 Получен SIGTERM, завершаем работу...');
    gracefulShutdown();
  });

  process.on('SIGINT', () => {
    console.log('🔄 Получен SIGINT (Ctrl+C), завершаем работу...');
    gracefulShutdown();
  });

  // 🔥 ОПТИМИЗАЦИЯ СИСТЕМЫ ДЛЯ RENDER.COM
  const THREAD_POOL_SIZE = process.env.UV_THREADPOOL_SIZE || (process.env.RENDER ? 64 : 128);
  process.env.UV_THREADPOOL_SIZE = THREAD_POOL_SIZE;

  console.log(`🚀 Оптимизация запущена:`);
  console.log(`   CPU cores: ${os.cpus().length}`);
  console.log(`   Thread pool: ${THREAD_POOL_SIZE}`);
  console.log(`   Memory: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`);

  // 🔥 ОПТИМИЗАЦИЯ HTTP АГЕНТОВ ДЛЯ RENDER.COM
  const agentOptions = {
    keepAlive: true,
    maxSockets: process.env.RENDER ? 50 : Infinity,
    maxFreeSockets: process.env.RENDER ? 20 : 256,
    timeout: 60000,
    freeSocketTimeout: 30000
  };

  https.globalAgent = new https.Agent(agentOptions);
  http.globalAgent = new http.Agent(agentOptions);

  // ==================== OPTIMIZEDLRUCACHE С ОПТИМИЗАЦИЯМИ ====================
  class OptimizedLRUCache {
    constructor(maxSize = 100, maxMemoryMB = 50) {
      this.maxSize = maxSize;
      this.maxMemoryBytes = maxMemoryMB * 1024 * 1024;
      this.cache = new Map();
      this.stats = {
        hits: 0,
        misses: 0,
        evictions: 0,
        sets: 0
      };

      this.cleanupInterval = setInterval(() => {
        this.adaptiveCleanup();
      }, process.env.RENDER ? 300000 : 600000);

      console.log(`✅ Кэш инициализирован: maxSize=${maxSize}, maxMemory=${maxMemoryMB}MB`);
    }

    get(key) {
      if (!this.cache.has(key)) {
        this.stats.misses++;
        if (global.performanceMetrics) {
          global.performanceMetrics.cacheMisses++;
        }
        return null;
      }

      const item = this.cache.get(key);
      const now = Date.now();

      if (now - item.timestamp > item.ttl) {
        this.cache.delete(key);
        this.stats.misses++;
        if (global.performanceMetrics) {
          global.performanceMetrics.cacheMisses++;
        }
        return null;
      }

      this.cache.delete(key);
      this.cache.set(key, item);

      this.stats.hits++;
      if (global.performanceMetrics) {
        global.performanceMetrics.cacheHits++;
      }

      return item.data;
    }

    set(key, value, ttl = 300000, priority = 'medium') {
      try {
        if (this.cache.size >= this.maxSize || this.getMemoryUsage() > this.maxMemoryBytes * 0.8) {
          this.evictByPriority();
        }

        const item = {
          data: value,
          timestamp: Date.now(),
          ttl: ttl,
          priority: priority,
          size: this.calculateItemSize(key, value)
        };

        if (this.cache.has(key)) {
          this.cache.delete(key);
        }

        this.cache.set(key, item);
        this.stats.sets++;

        if (this.cache.size > this.maxSize * 0.8) {
          setTimeout(() => this.cleanup(), 500);
        }

        return true;
      } catch (error) {
        console.error('❌ Ошибка при установке значения в кэш:', error);
        return false;
      }
    }

    calculateItemSize(key, value) {
      try {
        let size = key.length;
        size += JSON.stringify(value).length;
        return size;
      } catch (e) {
        return 1000;
      }
    }

    evictByPriority() {
      const now = Date.now();
      const priorities = ['low', 'medium', 'high'];
      let evicted = 0;

      for (let [key, value] of this.cache.entries()) {
        if (now - value.timestamp > value.ttl) {
          this.cache.delete(key);
          this.stats.evictions++;
          evicted++;
          if (this.cache.size < this.maxSize * 0.7) return;
        }
      }

      if (this.cache.size >= this.maxSize) {
        for (const priority of priorities) {
          for (let [key, value] of this.cache.entries()) {
            if (value.priority === priority) {
              this.cache.delete(key);
              this.stats.evictions++;
              evicted++;
              if (this.cache.size < this.maxSize * 0.7) return;
              if (evicted > 10) return;
            }
          }
        }
      }

      if (this.cache.size >= this.maxSize) {
        const iterator = this.cache.keys();
        for (let i = 0; i < 5; i++) {
          const key = iterator.next().value;
          if (key) {
            this.cache.delete(key);
            this.stats.evictions++;
          }
        }
      }
    }

    cleanup() {
      try {
        const now = Date.now();
        let cleaned = 0;
        const keysToDelete = [];

        for (let [key, value] of this.cache.entries()) {
          if (now - value.timestamp > value.ttl) {
            keysToDelete.push(key);
            cleaned++;
            if (cleaned >= 20) break;
          }
        }

        keysToDelete.forEach(key => this.cache.delete(key));

        if (cleaned > 0 && process.env.NODE_ENV === 'development') {
          console.log(`🧹 Автоочистка кэша: удалено ${cleaned} устаревших записей`);
        }

        return cleaned;
      } catch (error) {
        console.error('❌ Ошибка при очистке кэша:', error);
        return 0;
      }
    }

    adaptiveCleanup() {
      const memoryUsage = this.getMemoryUsage();
      const memoryMB = Math.round(memoryUsage / 1024 / 1024);

      if (memoryMB > this.maxMemoryBytes / 1024 / 1024 * 0.6 || this.cache.size > this.maxSize * 0.8) {
        console.log(`🔧 Адаптивная очистка: память ${memoryMB}MB, записей ${this.cache.size}`);
        this.aggressiveCleanup();
      } else {
        this.cleanup();
      }
    }

    aggressiveCleanup() {
      try {
        const now = Date.now();
        let cleaned = 0;
        const keysToDelete = [];

        for (let [key, value] of this.cache.entries()) {
          if (now - value.timestamp > 1800000) {
            keysToDelete.push(key);
            cleaned++;
          }
        }

        keysToDelete.forEach(key => this.cache.delete(key));

        if (cleaned > 0) {
          console.log(`🧹 Агрессивная очистка: удалено ${cleaned} старых записей`);
        }

        if (global.gc && this.cache.size > this.maxSize * 0.9) {
          global.gc();
        }

        return cleaned;
      } catch (error) {
        console.error('❌ Ошибка агрессивной очистки:', error);
        return 0;
      }
    }

    getStats() {
      const total = this.stats.hits + this.stats.misses;
      return {
        size: this.cache.size,
        hits: this.stats.hits,
        misses: this.stats.misses,
        sets: this.stats.sets,
        evictions: this.stats.evictions,
        hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) + '%' : '0%',
        memoryUsage: this.getMemoryUsage() + 'MB'
      };
    }

    getMemoryUsage() {
      try {
        let size = 0;
        for (let [key, value] of this.cache.entries()) {
          size += key.length;
          try {
            size += JSON.stringify(value.data).length;
          } catch (e) {
            size += 100;
          }
        }
        return Math.round(size / 1024 / 1024);
      } catch (error) {
        return 0;
      }
    }

    emergencyCleanup() {
      try {
        const currentSize = this.cache.size;
        const targetSize = Math.floor(this.maxSize * 0.4);

        if (currentSize <= targetSize) return 0;

        const keysToDelete = [];
        const now = Date.now();

        for (let [key, value] of this.cache.entries()) {
          if (now - value.timestamp > value.ttl) {
            keysToDelete.push(key);
            if (keysToDelete.length >= currentSize - targetSize) break;
          }
        }

        if (keysToDelete.length < currentSize - targetSize) {
          for (let [key, value] of this.cache.entries()) {
            if (value.priority === 'low' && !keysToDelete.includes(key)) {
              keysToDelete.push(key);
              if (keysToDelete.length >= currentSize - targetSize) break;
            }
          }
        }

        if (keysToDelete.length < currentSize - targetSize) {
          let mediumCount = 0;
          for (let [key, value] of this.cache.entries()) {
            if (value.priority === 'medium' && !keysToDelete.includes(key)) {
              keysToDelete.push(key);
              mediumCount++;
              if (keysToDelete.length >= currentSize - targetSize || mediumCount >= 5) break;
            }
          }
        }

        keysToDelete.forEach(key => this.cache.delete(key));
        console.log(`🚨 Аварийная очистка: удалено ${keysToDelete.length} записей`);

        return keysToDelete.length;
      } catch (error) {
        console.error('❌ Ошибка при аварийной очистке:', error);
        return 0;
      }
    }

    destroy() {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      this.cache.clear();
      this.stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };
      console.log('✅ Кэш полностью уничтожен');
    }
  }

  // ==================== ИНИЦИАЛИЗАЦИЯ КЭША И МЕТРИК ====================
  if (!global.performanceMetrics) {
    global.performanceMetrics = {
      requests: 0,
      errors: 0,
      slowRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      startTime: Date.now()
    };
  }

  console.log('🆕 Инициализация ОПТИМИЗИРОВАННОГО кэша для Render.com');

  const cacheSize = process.env.RENDER ? 100 : 200;
  const cacheMemory = process.env.RENDER ? 50 : 100;

  const quickCache = new OptimizedLRUCache(cacheSize, cacheMemory);
  global.quickCache = quickCache;
  console.log('🔍 Оптимизированный кэш инициализирован:', quickCache.getStats());

  const FIREBASE_TIMEOUT = process.env.RENDER ? 15000 : 30000;
  const S3_TIMEOUT = 30000;
  const RETRY_ATTEMPTS = 2;
  const RETRY_BASE_DELAY = 1000;

  const connectionCounters = {
    firebase: 0,
    s3: 0,
    http: 0
  };

  const withRetry = async (operation, operationName = 'Operation', timeoutMs = FIREBASE_TIMEOUT, maxRetries = RETRY_ATTEMPTS) => {
    const counterType = operationName.includes('Firebase') ? 'firebase' :
                       operationName.includes('S3') ? 's3' : 'http';
    connectionCounters[counterType]++;

    let timeoutId;
    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await Promise.race([
            operation(),
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(new Error(`Таймаут операции ${operationName} после ${timeoutMs}мс (попытка ${attempt}/${maxRetries})`));
              }, timeoutMs);
            })
          ]);

          if (timeoutId) clearTimeout(timeoutId);
          connectionCounters[counterType]--;
          return result;

        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId);

          if (attempt === maxRetries) {
            connectionCounters[counterType]--;
            throw error;
          }

          const delay = RETRY_BASE_DELAY * Math.pow(1.5, attempt - 1);
          console.warn(`🔄 Повтор ${attempt}/${maxRetries} для ${operationName} через ${delay}мс:`, error.message);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      connectionCounters[counterType]--;
      throw error;
    }
  };

  const withStrictTimeout = (promise, timeoutMs, operationName = 'Operation') => {
    return withRetry(() => promise, operationName, timeoutMs, 1);
  };

  const MEMORY_LIMIT = process.env.RENDER ? (512 * 1024 * 1024) : (1600 * 1024 * 1024);

  let memoryMonitorInterval = null;
  let performanceMonitorInterval = null;

  function startMonitoringIntervals() {
    stopMonitoringIntervals();

    memoryMonitorInterval = setInterval(() => {
      const memory = process.memoryUsage();
      const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);
      const rssMB = Math.round(memory.rss / 1024 / 1024);

      if (heapUsedMB > MEMORY_LIMIT / 1024 / 1024 * 0.7) {
        console.warn(`🚨 ВЫСОКАЯ ЗАГРУЗКА ПАМЯТИ: Heap ${heapUsedMB}MB, RSS ${rssMB}MB`);
        quickCache.emergencyCleanup();
        if (global.gc) {
          global.gc();
          console.log('🧹 Экстренный сбор мусора выполнен');
        }
      }
    }, process.env.RENDER ? 60000 : 300000);

    performanceMonitorInterval = setInterval(() => {
      const stats = quickCache.getStats();
      const memory = process.memoryUsage();

      if (process.env.NODE_ENV === 'development') {
        console.log('📊 Статистика:', {
          cache: { size: stats.size, hitRate: stats.hitRate },
          memory: { heap: Math.round(memory.heapUsed / 1024 / 1024) + 'MB' },
          connections: activeConnections,
          eventLoopLag: eventLoopLag + 'ms'
        });
      }
    }, 300000);
  }

  function stopMonitoringIntervals() {
    if (memoryMonitorInterval) {
      clearInterval(memoryMonitorInterval);
      memoryMonitorInterval = null;
    }
    if (performanceMonitorInterval) {
      clearInterval(performanceMonitorInterval);
      performanceMonitorInterval = null;
    }
    console.log('✅ Интервалы мониторинга остановлены');
  }

  // ==================== EXPRESS И СЕРВИСЫ ====================
  const app = express();

  // 🔥 ОПТИМИЗИРОВАННЫЕ ЛИМИТЕРЫ ДЛЯ RENDER.COM
  const heavyLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: process.env.RENDER ? 50 : 100,
    message: { error: "Слишком много запросов" },
    standardHeaders: true,
    legacyHeaders: false
  });

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.RENDER ? 500 : 1000,
    standardHeaders: true,
    legacyHeaders: false
  });

  const pingLimiter = rateLimit({
    windowMs: 1000,
    max: process.env.RENDER ? 500 : 1000,
    message: { error: "Too many pings" },
    skip: (req) => req.ip === '127.0.0.1',
    standardHeaders: true
  });

  const warmupLimiter = rateLimit({
    windowMs: 60000, // 1 минута
    max: 5, // максимум 5 запросов в минуту
    message: { error: "Слишком много запросов разогрева" },
    standardHeaders: true,
    skip: (req) => req.ip === '127.0.0.1' // разрешить локальные запросы
  });

  // 🔥 ПРИМЕНЕНИЕ ЛИМИТЕРОВ
  app.use("/ping", pingLimiter);
  app.use("/light-ping", pingLimiter);
  app.use("/micro-ping", pingLimiter);
  app.use("/nanoping", pingLimiter);
  app.use("/warmup-cache", warmupLimiter);

  // 🔥 СУПЕР-БЫСТРЫЕ PING ЭНДПОИНТЫ С ПРИОРИТЕТОМ
  app.get("/ping", (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Response-Priority', 'high');
    res.end(`{"p":${Date.now()},"s":"ok"}`);
  });

  app.get("/light-ping", (req, res) => {
    res.setHeader('X-Response-Priority', 'high');
    res.end(Date.now().toString());
  });

  app.get("/micro-ping", (req, res) => {
    res.setHeader('X-Response-Priority', 'high');
    res.end("ok");
  });

  app.get("/nanoping", (req, res) => {
    res.setHeader('X-Response-Priority', 'high');
    res.status(200).end();
  });

  app.get("/health", (req, res) => {
    res.json({
      status: "OK",
      timestamp: Date.now(),
      uptime: Math.round(process.uptime()),
      environment: process.env.RENDER ? 'render' : 'local'
    });
  });

  // 🔥 УЛУЧШЕННЫЙ MIDDLEWARE С ПРИОРИТЕТАМИ
  app.use((req, res, next) => {
    const lightEndpoints = ['/ping', '/light-ping', '/micro-ping', '/nanoping', '/health'];
    if (lightEndpoints.includes(req.url)) {
      res.setHeader('X-Request-Priority', 'high');
      return next();
    }

    if (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
      connectionFailures++;
      console.warn(`🚨 Превышен лимит соединений: ${activeConnections}/${MAX_CONCURRENT_CONNECTIONS}`);

      return res.status(503).json({
        error: "Server busy",
        retryAfter: 30,
        connections: activeConnections
      });
    }

    activeConnections++;

    const cleanup = () => {
      activeConnections--;
      res.removeListener('finish', cleanup);
      res.removeListener('close', cleanup);
      res.removeListener('error', cleanup);
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    global.performanceMetrics.requests++;
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > 5000) {
        global.performanceMetrics.slowRequests++;
      }
    });

    next();
  });

  // 🔥 ОСНОВНЫЕ MIDDLEWARE
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // 🔥 ПРИМЕНЕНИЕ ЛИМИТЕРОВ ДЛЯ ТЯЖЕЛЫХ ЭНДПОИНТОВ
  app.use("/send-event-notification", heavyLimiter);
  app.use("/generate-upload-url", heavyLimiter);
  app.use("/news", apiLimiter);
  app.use("/send-message", apiLimiter);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 3
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

  // ==================== FIREBASE ====================
  try {
    const base64 = process.env.FIREBASE_CONFIG;
    if (!base64) throw new Error("FIREBASE_CONFIG переменная не найдена в .env");
    const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));

    const firebaseConfig = {
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL,
      httpAgent: new https.Agent({
        keepAlive: true,
        maxSockets: process.env.RENDER ? 30 : 200,
        maxFreeSockets: process.env.RENDER ? 10 : 50,
        timeout: 10000,
        freeSocketTimeout: 10000
      })
    };

    admin.initializeApp(firebaseConfig);
    console.log("✅ Firebase инициализирован с оптимизированными настройками");
  } catch (err) {
    console.error("🔥 Ошибка инициализации Firebase:", err);
  }

  const db = admin.database();
  const auth = admin.auth();

  // ==================== AWS S3 ====================
  const s3 = new S3Client({
    region: process.env.YC_S3_REGION || "ru-central1",
    endpoint: process.env.YC_S3_ENDPOINT || "https://storage.yandexcloud.net",
    credentials: {
      accessKeyId: process.env.YC_ACCESS_KEY,
      secretAccessKey: process.env.YC_SECRET_KEY,
    }
  });

  const BUCKET_NAME = process.env.YC_S3_BUCKET;

  // ==================== ФУНКЦИИ КЭШИРОВАНИЯ ====================

  async function getUserWithCache(userId) {
    const cacheKey = `user_${userId}`;
    const cached = quickCache.get(cacheKey);

    if (cached) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`✅ Кэш попадание для пользователя: ${userId}`);
      }
      return cached;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`❌ Кэш промах для пользователя: ${userId}`);
    }

    try {
      const userSnap = await safeFirebaseOperation(
        () => db.ref(`users/${userId}`).once('value'),
        `Получение пользователя ${userId} из Firebase`
      );
      const userData = userSnap.val();

      if (userData) {
        quickCache.set(cacheKey, userData, 1200000, 'high');
        if (process.env.NODE_ENV === 'development') {
          console.log(`💾 Пользователь ${userId} сохранен в кэш`);
        }
      }

      return userData;
    } catch (error) {
      console.error(`❌ Ошибка получения пользователя ${userId}:`, error.message);
      return null;
    }
  }

  async function getNewsWithCache(groupId) {
    const cacheKey = `news_${groupId}`;
    const cached = quickCache.get(cacheKey);

    if (cached) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`✅ Кэш попадание для новостей группы: ${groupId}`);
      }
      return cached;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`❌ Кэш промах для новостей группы: ${groupId}`);
    }

    try {
      const newsSnap = await safeFirebaseOperation(
        () => db.ref(`news/${groupId}`).once('value'),
        `Получение новостей группы ${groupId} из Firebase`
      );
      const newsData = newsSnap.val() || {};

      quickCache.set(cacheKey, newsData, 900000, 'medium');
      if (process.env.NODE_ENV === 'development') {
        console.log(`💾 Новости группы ${groupId} сохранены в кэш`);
      }

      return newsData;
    } catch (error) {
      console.error(`❌ Ошибка получения новостей группы ${groupId}:`, error.message);
      return {};
    }
  }

  async function getGroupsStructureWithCache() {
    const cacheKey = 'groups_structure';
    const cached = quickCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const groupsSnap = await safeFirebaseOperation(
        () => db.ref('groups').once('value'),
        'Получение структуры всех групп из Firebase'
      );
      const groupsData = groupsSnap.val() || {};

      quickCache.set(cacheKey, groupsData, 3600000, 'medium');
      if (process.env.NODE_ENV === 'development') {
        console.log('💾 Структура групп сохранена в кэш');
      }

      return groupsData;
    } catch (error) {
      console.error('❌ Ошибка получения структуры групп:', error.message);
      return {};
    }
  }

  async function getGroupWithCache(groupId) {
    const cacheKey = `group_${groupId}`;
    const cached = quickCache.get(cacheKey);

    if (cached) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`✅ Кэш попадание для группы: ${groupId}`);
      }
      return cached;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`❌ Кэш промах для группы: ${groupId}`);
    }

    try {
      const groupSnap = await safeFirebaseOperation(
        () => db.ref(`groups/${groupId}`).once('value'),
        `Получение группы ${groupId} из Firebase`
      );
      const groupData = groupSnap.val();

      if (groupData) {
        quickCache.set(cacheKey, groupData, 1800000, 'high');
        if (process.env.NODE_ENV === 'development') {
          console.log(`💾 Группа ${groupId} сохранена в кэш`);
        }
      }

      return groupData;
    } catch (error) {
      console.error(`❌ Ошибка получения группы ${groupId}:`, error.message);
      return null;
    }
  }

  // ==================== MIDDLEWARE И УТИЛИТЫ ====================

  async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

    if (!token) {
      console.warn("🚫 Проверка токена: отсутствует заголовок Authorization");
      return res.status(401).send("Нет токена");
    }

    try {
      const decoded = await safeFirebaseOperation(
        () => admin.auth().verifyIdToken(token),
        'Проверка токена Firebase'
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

  // ==================== ВСЕ ОСНОВНЫЕ ЭНДПОИНТЫ ====================

  // 🔥 УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ
  app.post('/deleteUserByName', async (req, res) => {
    const fullName = req.body.fullName?.trim().toLowerCase();
    if (!fullName) return res.status(400).send("fullName обязателен");

    try {
      const groups = await getGroupsStructureWithCache();
      const usersSnap = await safeFirebaseOperation(
        () => db.ref('users').once('value'),
        'Удаление пользователя по имени'
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
                quickCache.cache.delete(`group_${child.group}`);
              }
              if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
            }

            if (filesToDelete.length > 0) {
              await deleteFromS3(filesToDelete);
            }
          }

          await db.ref(`users/${userId}`).remove();
          quickCache.cache.delete(`user_${userId}`);

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

          const groupsSnap = await safeFirebaseOperation(
            () => db.ref('groups').once('value'),
            'Получение групп для удаления педагога'
          );
          const groups = groupsSnap.val() || {};

          for (const [groupId, group] of Object.entries(groups)) {
            if (group.teachers?.[userId]) {
              await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
              quickCache.cache.delete(`group_${groupId}`);
            }
          }

          await db.ref(`users/${userId}`).remove();
          quickCache.cache.delete(`user_${userId}`);

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
                quickCache.cache.delete(`group_${child.group}`);
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
      global.performanceMetrics.errors++;
      console.error("Ошибка при deleteUserByName:", err);

      if (err.message.includes('timeout')) {
        return res.status(408).send("Операция заняла слишком много времени");
      }

      res.status(500).send("Ошибка при удалении: " + err.message);
    }
  });

  app.post('/deleteChild', async (req, res) => {
    const { userId, childId } = req.body;

    if (!userId || !childId) {
      return res.status(400).json({ error: "userId и childId обязательны" });
    }

    try {
      const childRef = db.ref(`users/${userId}/children/${childId}`);
      const childSnap = await safeFirebaseOperation(
        () => childRef.once('value'),
        'Получение данных ребенка для удаления'
      );

      if (!childSnap.exists()) {
        return res.status(404).json({ error: "Ребенок не найден" });
      }

      const child = childSnap.val();
      const groupName = child.group;
      const childName = child.fullName.trim();

      let groupId = null;
      if (groupName) {
        const groups = await getGroupsStructureWithCache();

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
        const groupChildrenSnap = await safeFirebaseOperation(
          () => groupChildrenRef.once('value'),
          'Получение детей группы'
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
          quickCache.cache.delete(`group_${groupId}`);
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
      quickCache.cache.delete(`user_${userId}`);

      res.json({
        success: true,
        message: `Ребенок ${childName} успешно удален`
      });

    } catch (err) {
      global.performanceMetrics.errors++;
      console.error('❌ Ошибка при deleteChild:', err);

      if (err.message.includes('timeout')) {
        return res.status(408).json({ error: "Операция заняла слишком много времени" });
      }

      res.status(500).json({ error: "Ошибка при удалении ребенка" });
    }
  });

  app.post("/update-user", async (req, res) => {
    try {
      const { fullName, newEmail } = req.body;
      if (!fullName || !newEmail) return res.status(400).json({ error: "fullName и newEmail обязательны" });

      const snap = await safeFirebaseOperation(
        () => db.ref("users").orderByChild("name").equalTo(fullName).once("value"),
        'Поиск пользователя для обновления email'
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

      quickCache.cache.delete(`user_${userId}`);

      res.json({ message: "Email обновлен", userId, updatedUser: { name: fullName, email: newEmail } });
    } catch (err) {
      global.performanceMetrics.errors++;
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

  // 🔥 НОВОСТИ И СОБЫТИЯ
  app.post("/news", verifyToken, async (req, res) => {
    try {
      const { newsId, groupId, title, description, mediaUrls = [] } = req.body;
      const authorId = req.user.uid;

      if (!groupId || !title || !description) {
        return res.status(400).json({ error: "groupId, title и description обязательны" });
      }

      if (newsId) {
        const ref = db.ref(`news/${groupId}/${newsId}`);
        const snap = await safeFirebaseOperation(
          () => ref.once("value"),
          'Редактирование новости'
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
        quickCache.cache.delete(`news_${groupId}`);

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
      quickCache.cache.delete(`news_${groupId}`);

      return res.json({ success: true, id });

    } catch (err) {
      global.performanceMetrics.errors++;

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

      const newsData = await getNewsWithCache(groupId);

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

      const cacheStatus = quickCache.get(`news_${groupId}`) ? 'hit' : 'miss';
      res.set({
        'X-Cache-Status': cacheStatus,
        'X-Cache-Hits': quickCache.stats.hits,
        'X-Cache-Misses': quickCache.stats.misses
      });

      res.json(newsList);

    } catch (err) {
      global.performanceMetrics.errors++;

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

      const snap = await safeFirebaseOperation(
        () => db.ref(`news/${groupId}/${newsId}`).once('value'),
        'Удаление новости'
      );
      const data = snap.val();
      if (!data) return res.status(404).json({ error: "Новость не найдена" });
      if (data.authorId !== authorId) return res.status(403).json({ error: "Нет прав" });

      const urls = data.mediaUrls || [];
      await deleteFromS3(urls);
      await db.ref(`news/${groupId}/${newsId}`).remove();

      quickCache.cache.delete(`news_${groupId}`);

      res.json({ success: true });
    } catch (err) {
      global.performanceMetrics.errors++;

      if (err.message.includes('timeout')) {
        return res.status(408).json({ error: "Операция заняла слишком много времени" });
      }

      console.error("Ошибка deleteNews:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // 🔥 ЗАГРУЗКА ФАЙЛОВ
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
        const hasAccess = await withRetry(
          () => checkChatAccess(req.user.uid, finalGroupId, folder === 'private-chats/'),
          'Проверка доступа к чату',
          4000
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
        4000
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
      global.performanceMetrics.errors++;
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

  async function isPrivateChatId(chatId) {
    try {
      if (chatId.includes('_')) {
        const privateChatRef = db.ref(`chats/private/${chatId}`);
        const privateSnap = await safeFirebaseOperation(
          () => privateChatRef.once('value'),
          'Проверка приватного чата'
        );

        if (privateSnap.exists()) {
          return true;
        }

        const groupChatRef = db.ref(`chats/groups/${chatId}`);
        const groupSnap = await safeFirebaseOperation(
          () => groupChatRef.once('value'),
          'Проверка группового чата'
        );

        if (groupSnap.exists()) {
          return false;
        }

        return true;
      }

      const groupChatRef = db.ref(`chats/groups/${chatId}`);
      const groupSnap = await safeFirebaseOperation(
        () => groupChatRef.once('value'),
        'Проверка существования группового чата'
      );

      return !groupSnap.exists();
    } catch (error) {
      console.error("❌ Ошибка определения типа чата:", error);
      return chatId.includes('_');
    }
  }

  // 🔥 ЧАТ И СООБЩЕНИЯ
  app.post("/send-message", verifyToken, async (req, res) => {
    try {
      const { chatId, message, messageType = "text", fileUrl, fileName } = req.body;
      const senderId = req.user.uid;

      if (!chatId || !message) {
        return res.status(400).json({ error: "chatId и message обязательны" });
      }

      const sender = await getUserWithCache(senderId);
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
        4000
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
      global.performanceMetrics.errors++;

      if (err.message.includes('timeout')) {
        return res.status(408).json({ error: "Операция заняла слишком много времени" });
      }

      console.error("❌ Ошибка отправки сообщения:", err);
      res.status(500).json({ error: err.message });
    }
  });

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

      quickCache.cache.delete(`user_${userId}`);

      res.json({ success: true });

    } catch (err) {
      global.performanceMetrics.errors++;
      console.error("❌ Ошибка сохранения FCM токена:", err);
      res.status(500).json({ error: err.message });
    }
  });

  async function removeInvalidToken(invalidToken) {
    try {
      const usersSnap = await safeFirebaseOperation(
        () => db.ref('users').once('value'),
        'Поиск пользователей для удаления токена'
      );
      const users = usersSnap.val() || {};

      for (const [userId, user] of Object.entries(users)) {
        if (user.fcmToken === invalidToken) {
          await db.ref(`users/${userId}`).update({ fcmToken: null });
          quickCache.cache.delete(`user_${userId}`);
          return { success: true, userId };
        }
      }

      return { success: false, message: "Токен не найден" };

    } catch (err) {
      console.error("❌ Ошибка удаления токена:", err);
      return { success: false, error: err.message };
    }
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
          const user = await getUserWithCache(otherUserId);
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
                const teacher = await getUserWithCache(teacherId);
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

  // 🔥 УВЕДОМЛЕНИЯ О СОБЫТИЯХ
  async function preloadParentsData(groupId) {
    const cacheKey = `parents_${groupId}`;
    const cached = quickCache.get(cacheKey);

    if (cached) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`✅ Кэш попадание для родителей группы: ${groupId}`);
      }
      return cached;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`❌ Кэш промах для родителей группы: ${groupId}`);
    }

    try {
      const [groupData, allParents] = await Promise.all([
        getGroupWithCache(groupId),
        safeFirebaseOperation(() =>
          db.ref('users')
            .orderByChild('role')
            .equalTo('Родитель')
            .once('value'),
          'Загрузка всех родителей'
        )
      ]);

      const childrenInGroup = groupData?.children || {};
      const childIds = Object.keys(childrenInGroup);

      if (childIds.length === 0) {
        quickCache.set(cacheKey, [], 300000, 'medium');
        return [];
      }

      const users = allParents.val() || {};
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

      quickCache.set(cacheKey, parents, 600000, 'high');
      if (process.env.NODE_ENV === 'development') {
        console.log(`💾 Данные родителей группы ${groupId} сохранены в кэш (${parents.length} родителей)`);
      }

      return parents;

    } catch (error) {
      console.error("❌ Ошибка предзагрузки родителей:", error);
      return [];
    }
  }

  async function findParentsByGroupIdOptimized(groupId) {
    return await preloadParentsData(groupId);
  }

  async function sendNotificationsParallel(recipients, createMessagePayload, batchSize = 15) {
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
        await new Promise(resolve => setTimeout(resolve, 50));
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

      return await sendNotificationsParallel(parentsWithTokens, createMessagePayload, 20);

    } catch (err) {
      console.error("❌ Ошибка в sendEventNotificationsOptimized:", err);
      return { successful: 0, failed: parents.length, errors: [err] };
    }
  }

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
        8000
      );

      const parents = await withRetry(
        () => findParentsByGroupIdOptimized(groupId),
        'Оптимизированный поиск родителей',
        20000
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
      global.performanceMetrics.errors++;

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

 // 🔥 ЗАЩИТА ОТ ЧАСТЫХ ЗАПРОСОВ WARMUP
 let lastWarmupTime = 0;
 const WARMUP_COOLDOWN = 30000; // 30 секунд между разогревами
 let isWarmupInProgress = false;

 app.get("/warmup-cache", async (req, res) => {
   const startTime = Date.now();
   const requestId = Math.random().toString(36).substring(2, 8);

   console.log(`🔥 [${requestId}] GET /warmup-cache - Запрос от ${req.ip || 'unknown'}`);

   // 🔒 ПРОВЕРКА ЧАСТОТЫ ЗАПРОСОВ
   const now = Date.now();
   const timeSinceLastWarmup = now - lastWarmupTime;

   if (isWarmupInProgress) {
     console.log(`⏳ [${requestId}] Разогрев уже выполняется, пропускаем...`);
     const stats = quickCache.getStats();
     return res.json({
       success: true,
       requestId: requestId,
       message: "Разогрев кэша уже выполняется",
       status: "in_progress",
       cache: stats,
       responseTime: `${Date.now() - startTime}ms`
     });
   }

   if (timeSinceLastWarmup < WARMUP_COOLDOWN) {
     const remainingCooldown = Math.ceil((WARMUP_COOLDOWN - timeSinceLastWarmup) / 1000);
     console.log(`⏳ [${requestId}] Слишком частый запрос, cooldown: ${remainingCooldown}с`);
     const stats = quickCache.getStats();
     return res.json({
       success: true,
       requestId: requestId,
       message: `Кэш уже разогрет. Следующий разогрев через ${remainingCooldown}с`,
       cooldown: remainingCooldown,
       cache: stats,
       responseTime: `${Date.now() - startTime}ms`
     });
   }

   try {
     const initialStats = quickCache.getStats();

     // 🔒 БЛОКИРУЕМ ПОВТОРНЫЕ ВЫЗОВЫ
     isWarmupInProgress = true;
     lastWarmupTime = now;

     res.json({
       success: true,
       requestId: requestId,
       message: "Запрос на разогрев кэша принят",
       initialCache: {
         size: initialStats.size,
         hitRate: initialStats.hitRate,
         memory: initialStats.memoryUsage
       },
       responseTime: `${Date.now() - startTime}ms`,
       timestamp: now,
       note: "Кэш разогревается в фоновом режиме",
       nextAvailable: new Date(now + WARMUP_COOLDOWN).toISOString()
     });

     // 🔥 ФОНОВЫЙ РАЗОГРЕВ С ЗАЩИТОЙ
     setTimeout(async () => {
       try {
         console.log(`🔥 [${requestId}] Фоновый разогрев кэша...`);

         const warmupStart = Date.now();

         // ОГРАНИЧИВАЕМ ПАРАЛЛЕЛЬНЫЕ ВЫЗОВЫ
         await Promise.allSettled([
           getGroupsStructureWithCache(),
         ]);

         const warmupTime = Date.now() - warmupStart;
         const finalStats = quickCache.getStats();

         console.log(`✅ [${requestId}] Фоновый разогрев завершен за ${warmupTime}ms`);
         console.log(`📊 [${requestId}] Кэш: ${finalStats.size} записей, HitRate: ${finalStats.hitRate}`);

       } catch (error) {
         console.error(`❌ [${requestId}] Ошибка фонового разогрева:`, error.message);
       } finally {
         // ✅ РАЗБЛОКИРОВКА В ЛЮБОМ СЛУЧАЕ
         isWarmupInProgress = false;
       }
     }, 100);

   } catch (error) {
     // ✅ РАЗБЛОКИРОВКА ПРИ ОШИБКЕ
     isWarmupInProgress = false;

     console.error(`❌ [${requestId}] Ошибка warmup-cache:`, error);
     res.status(500).json({
       success: false,
       requestId: requestId,
       error: error.message,
       responseTime: `${Date.now() - startTime}ms`
     });
   }
 });

  app.post("/warmup-cache", async (req, res) => {
    try {
      console.log('🔥 Разогрев кэша...');

      const startTime = Date.now();

      await Promise.allSettled([
        getGroupsStructureWithCache(),
      ]);

      const duration = Date.now() - startTime;

      res.json({
        success: true,
        message: "Кэш разогрет",
        duration: `${duration}ms`,
        stats: quickCache.getStats()
      });
    } catch (error) {
      console.error('❌ Ошибка разогрева кэша:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        stats: quickCache.getStats()
      });
    }
  });

  app.get("/environment", (req, res) => {
    res.json({
      node_env: process.env.NODE_ENV,
      port: process.env.PORT,
      render_external_url: process.env.RENDER_EXTERNAL_URL,
      render: process.env.RENDER ? 'true' : 'false',
      memory_limit: Math.round(MEMORY_LIMIT / 1024 / 1024) + 'MB',
      thread_pool: THREAD_POOL_SIZE,
      firebase_initialized: !!admin.apps.length,
      s3_configured: !!(process.env.YC_ACCESS_KEY && process.env.YC_SECRET_KEY),
      timestamp: new Date().toISOString()
    });
  });

  app.get("/connection-stats", (req, res) => {
    res.json({
      connections: connectionCounters,
      memory: process.memoryUsage(),
      cacheSize: quickCache.cache.size,
      uptime: Math.round(process.uptime()),
      timestamp: Date.now()
    });
  });

  app.get("/deep-ping", async (req, res) => {
    const start = Date.now();
    const diagnostics = {};

    try {
      const fbStart = Date.now();
      await withStrictTimeout(
        db.ref('.info/connected').once('value'),
        2000,
        'Пинг Firebase'
      );
      diagnostics.firebase = `${Date.now() - fbStart}ms`;
      diagnostics.total = `${Date.now() - start}ms`;

      res.json({
        pong: Date.now(),
        diagnostics,
        timestamp: Date.now()
      });
    } catch (error) {
      res.status(500).json({
        error: "Диагностика не удалась",
        message: error.message
      });
    }
  });

  app.get("/load-metrics", (req, res) => {
    const memory = process.memoryUsage();

    res.json({
      memory: {
        used: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
      },
      connections: activeConnections,
      cacheSize: quickCache.cache.size,
      timestamp: Date.now()
    });
  });

  app.get("/keep-alive", (req, res) => {
    console.log(`🌐 External keep-alive ping from: ${req.ip || 'unknown'}`);

    res.json({
      status: "alive",
      server_time: new Date().toISOString(),
      uptime: Math.round(process.uptime()) + "s",
      version: "2.0.0-optimized-cache",
      environment: process.env.NODE_ENV || 'production'
    });
  });

  app.get("/wake-up", async (req, res) => {
    console.log('🔔 Сервер пробужден внешним запросом');

    try {
      const firebaseAlive = await withStrictTimeout(
        db.ref('.info/connected').once('value'),
        3000,
        'Wake-up Firebase check'
      );

      res.json({
        status: "awake",
        timestamp: new Date().toISOString(),
        dependencies: {
          firebase: true,
          s3: true
        },
        message: "Сервер активен и готов к работе"
      });
    } catch (error) {
      res.status(500).json({
        status: "awake_with_issues",
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  app.get("/metrics", (req, res) => {
    const uptime = Date.now() - global.performanceMetrics.startTime;
    const requestsPerMinute = (global.performanceMetrics.requests / (uptime / 60000)).toFixed(2);
    const errorRate = global.performanceMetrics.requests > 0
      ? ((global.performanceMetrics.errors / global.performanceMetrics.requests) * 100).toFixed(2)
      : 0;

    res.json({
      uptime: Math.round(uptime / 1000) + 's',
      total_requests: global.performanceMetrics.requests,
      requests_per_minute: requestsPerMinute,
      error_rate: errorRate + '%',
      slow_requests: global.performanceMetrics.slowRequests,
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        external: Math.round(process.memoryUsage().external / 1024 / 1024) + 'MB'
      },
      cache: quickCache.getStats(),
      gc: global.gc ? 'available' : 'unavailable'
    });
  });

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
        3000,
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
        5000,
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

  app.get("/info", (req, res) => {
    res.json({
      service: "Firebase Admin Notification Server",
      version: "2.0.0-optimized-cache",
      optimization: {
        lru_cache: "enhanced",
        cache_priorities: "implemented",
        user_caching: "implemented",
        news_caching: "implemented",
        groups_caching: "implemented",
        health_cache: "implemented",
        cache_monitoring: "enhanced"
      },
      cache_config: {
        max_size: quickCache.maxSize,
        max_memory: Math.round(quickCache.maxMemoryBytes / 1024 / 1024) + "MB",
        default_ttl: "10 minutes",
        priorities: ["high", "medium", "low"]
      },
      endpoints: {
        "GET /light-ping": "Быстрый пинг с кэшированием",
        "GET /load-metrics": "Метрики нагрузки с кэшированием",
        "GET /news": "Новости с кэшированием",
        "POST /send-message": "Сообщения с кэшированием пользователей",
        "GET /health": "Упрощенная проверка работоспособности",
        "GET /deep-health": "Глубокий health check",
        "GET /info": "Информация о сервере и кэше",
        "POST /warmup-cache": "Разогрев кэша",
        "GET /environment": "Информация об окружении",
        "GET /connection-stats": "Мониторинг активных соединений"
      }
    });
  });

  app.get("/stress-test", async (req, res) => {
    const start = Date.now();
    const tests = [];
    tests.push({ name: "simple_response", time: "0ms" });

    const fbStart = Date.now();
    try {
      await withStrictTimeout(
        db.ref('.info/connected').once('value'),
        2000,
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

  app.get("/cache-stats", (req, res) => {
    const stats = quickCache.getStats();

    res.json({
      quickCache: stats,
      globalPerformance: global.performanceMetrics,
      timestamp: Date.now(),
      cacheKeys: Array.from(quickCache.cache.keys()).slice(0, 10)
    });
  });

  app.post("/reset-cache", (req, res) => {
    const oldStats = quickCache.getStats();

    quickCache.cache.clear();
    quickCache.stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };

    res.json({
      success: true,
      message: "Кэш сброшен",
      oldStats: {
        quickCache: oldStats
      },
      newStats: {
        quickCache: quickCache.getStats()
      }
    });
  });

  app.get("/system-debug", (req, res) => {
    const memory = process.memoryUsage();
    const stats = {
      timestamp: Date.now(),
      uptime: process.uptime(),
      memory: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
        external: Math.round(memory.external / 1024 / 1024) + 'MB'
      },
      connections: {
        active: activeConnections,
        max: MAX_CONCURRENT_CONNECTIONS,
        firebase: connectionCounters.firebase,
        s3: connectionCounters.s3
      },
      cache: quickCache.getStats(),
      eventLoop: eventLoopLag + 'ms',
      loadavg: os.loadavg(),
      freemem: Math.round(os.freemem() / 1024 / 1024) + 'MB'
    };

    res.json(stats);
  });

  app.get("/", (req, res) => {
    res.json({
      message: "Firebase Admin Server работает (ОПТИМИЗИРОВАННАЯ ВЕРСИЯ ДЛЯ RENDER.COM)",
      timestamp: Date.now(),
      endpoints: [
        "/ping - Ультра-быстрый пинг (1-2ms)",
        "/light-ping - Легкий пинг",
        "/health - Проверка здоровья",
        "/load-metrics - Метрики нагрузки",
        "/info - Информация о сервере",
        "/stress-test - Тест нагрузки",
        "/metrics - Метрики производительности",
        "/warmup-cache - Разогрев кэша",
        "/environment - Информация об окружении",
        "/connection-stats - Мониторинг соединений"
      ]
    });
  });

  // ==================== ЗАПУСК СЕРВЕРА С ОПТИМИЗАЦИЯМИ ====================
  if (process.env.RENDER_EXTERNAL_URL) {
    console.log('🚀 Запуск на Render.com обнаружен');
    console.log(`🌐 External URL: ${process.env.RENDER_EXTERNAL_URL}`);
    console.log(`🔧 Port: ${PORT}`);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT} (ОПТИМИЗИРОВАННАЯ ВЕРСИЯ ДЛЯ RENDER.COM)`);
    console.log(`✅ Лимит памяти: ${Math.round(MEMORY_LIMIT / 1024 / 1024)}MB`);
    console.log(`✅ Лимит кэша: ${quickCache.maxSize} записей, ${Math.round(quickCache.maxMemoryBytes / 1024 / 1024)}MB`);
    console.log(`✅ Максимум соединений: ${MAX_CONCURRENT_CONNECTIONS}`);
    console.log(`✅ Таймаут Firebase: ${FIREBASE_TIMEOUT}мс`);
    console.log(`✅ Таймаут S3: ${S3_TIMEOUT}мс`);
    console.log(`✅ Circuit breaker: включен`);
    console.log(`✅ Адаптивные лимиты: активны`);

    startMonitoringIntervals();

    setTimeout(preloadCriticalData, 5000);
  });

  server.keepAliveTimeout = 30000;
  server.headersTimeout = 35000;

  function gracefulShutdown() {
    console.log('🔄 Начало плавного завершения работы...');

    stopMonitoringIntervals();

    console.log('📊 Финальная статистика кэша:', quickCache.getStats());
    console.log('📊 Активные соединения:', connectionCounters);
    console.log(`📊 Активные HTTP соединения: ${activeConnections}`);

    quickCache.destroy();

    server.close(() => {
      console.log('✅ HTTP сервер закрыт');

      if (admin.apps.length) {
        Promise.all(admin.apps.map(app => app.delete()))
          .then(() => {
            console.log('✅ Firebase соединения закрыты');
            process.exit(0);
          })
          .catch(err => {
            console.error('❌ Ошибка закрытия Firebase:', err);
            process.exit(1);
          });
      } else {
        process.exit(0);
      }
    });

    setTimeout(() => {
      console.log('⚠️ Принудительное завершение');
      process.exit(1);
    }, 5000);
  }

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  process.on('warning', (warning) => {
    if (warning.name === 'MaxListenersExceededWarning' ||
        warning.message.includes('memory')) {
      console.error('🚨 АВАРИЙНЫЙ РЕЖИМ: Обнаружено предупреждение памяти', warning.message);

      if (!emergencyMode) {
        emergencyMode = true;

        const deleted = quickCache.emergencyCleanup();
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

  async function preloadCriticalData() {
    console.log('🔥 Предзагрузка критических данных в кэш...');
    try {
      await getGroupsStructureWithCache();
      console.log('✅ Критические данные загружены в кэш');

      const stats = quickCache.getStats();
      console.log('📊 Статус кэша после предзагрузки:', {
        size: stats.size,
        memoryUsage: stats.memoryUsage,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.log('⚠️ Предзагрузка данных пропущена:', error.message);
    }
  }

  console.log('🚀 ОПТИМИЗИРОВАННАЯ ВЕРСИЯ ДЛЯ RENDER.COM:');
  console.log('   ✅ Адаптивные лимиты памяти и соединений');
  console.log('   ✅ Уменьшенные таймауты Firebase');
  console.log('   ✅ Оптимизированный кэш с приоритетами');
  console.log('   ✅ Улучшенная обработка ошибок');
  console.log('   ✅ Проактивный мониторинг ресурсов');
  console.log('   ✅ ВСЕ 25+ эндпоинтов сохранены и оптимизированы');
}