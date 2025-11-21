require('dotenv').config();

// ====================ИМПОРТЫ ====================
const net = require('net');
const os = require('os');
const https = require('https');
const http = require('http');
const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 10000;

console.log('Проверка порта на дубликаты...');

// ==================== ПРОВЕРКА ПОРТА ====================
const tester = net.createServer();

// Обработчик ошибок при проверке порта
tester.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Обнаружен дубликат! Завершаем процесс...');
    process.exit(0);
  }
});

// Обработчик успешного прослушивания порта
tester.once('listening', () => {
  tester.close(() => {
    console.log('Порту свободен! Запускаем основной сервер...');
    startMainServer();
  });
});

tester.listen(PORT, '0.0.0.0');

// ==================== ОСНОВНАЯ ФУНКЦИЯ СЕРВЕРА ====================
function startMainServer() {
  // Circuit Breaker для Firebase - защита от каскадных отказов
  const firebaseCircuitBreaker = {
    failures: 0,
    lastFailure: 0,
    isOpen: false,

    // Проверяет, можно ли выполнить операцию
    canExecute() {
      if (this.isOpen) {
        const cooldownPassed = Date.now() - this.lastFailure > 30000;
        if (cooldownPassed) {
          this.isOpen = false;
          this.failures = 0;
          console.log('Circuit breaker CLOSED');
          return true;
        }
        return false;
      }
      return true;
    },

    // Записывает успешное выполнение операции
    recordSuccess() {
      this.failures = 0;
      this.isOpen = false;
    },

    // Записывает неудачное выполнение операции
    recordFailure() {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= 3) {
        this.isOpen = true;
        console.log('Circuit breaker OPENED для Firebase');
      }
    }
  };

  // Безопасное выполнение операций Firebase с Circuit Breaker
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

  // Адаптивный лимит соединений для Render.com
  const MAX_CONCURRENT_CONNECTIONS = process.env.RENDER ? 50 : 200;
  let activeConnections = 0;
  let connectionFailures = 0;

  // Обнаружение среды выполнения
  if (process.env.RENDER) {
    console.log('Обнаружена среда Render.com - применяем оптимизации');
  }

  // Обработчик необработанных исключений
  process.on('uncaughtException', (error) => {
    console.error('Критическая ошибка:', error);
    console.error('Стек вызовов:', error.stack);
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });

  // Обработчик необработанных промисов
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Необработанный промис:', reason);
    console.error('Стек:', reason?.stack);
  });

  // Обработчик сигнала завершения
  process.on('SIGTERM', () => {
    console.log('Получен SIGTERM, завершаем работу...');
    gracefulShutdown();
  });

  // Обработчик сигнала прерывания
  process.on('SIGINT', () => {
    console.log('Получен SIGINT (Ctrl+C), завершаем работу...');
    gracefulShutdown();
  });

  // Грациозное завершение работы
  function gracefulShutdown() {
    console.log('Завершение работы...');
    if (quickCache) {
      quickCache.destroy();
    }
    process.exit(0);
  }

  // Оптимизация системы для Render.com
  const THREAD_POOL_SIZE = process.env.UV_THREADPOOL_SIZE || (process.env.RENDER ? 64 : 128);
  process.env.UV_THREADPOOL_SIZE = THREAD_POOL_SIZE;

  console.log('Оптимизация запущена:');
  console.log('   CPU cores: ' + os.cpus().length);
  console.log('   Thread pool: ' + THREAD_POOL_SIZE);
  console.log('   Memory: ' + Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB');

  // Оптимизация HTTP агентов для Render.com
  const agentOptions = {
    keepAlive: true,
    maxSockets: process.env.RENDER ? 50 : Infinity,
    maxFreeSockets: process.env.RENDER ? 20 : 256,
    timeout: 60000,
    freeSocketTimeout: 30000
  };

  https.globalAgent = new https.Agent(agentOptions);
  http.globalAgent = new http.Agent(agentOptions);

  // ==================== LRUCache ====================
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

      // Упрощенный интервал очистки - 30 минут для всех сред
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, 1800000);

      console.log('Кэш инициализирован: maxSize=' + maxSize + ', maxMemory=' + maxMemoryMB + 'MB');
    }

    // Получение значения по ключу
    get(key) {
      if (!this.cache.has(key)) {
        this.stats.misses++;
        return null;
      }

      const item = this.cache.get(key);
      const now = Date.now();

      // Проверка TTL
      if (now - item.timestamp > item.ttl) {
        this.cache.delete(key);
        this.stats.misses++;
        return null;
      }

      // Обновление порядка использования (LRU)
      this.cache.delete(key);
      this.cache.set(key, item);

      this.stats.hits++;
      return item.data;
    }

    // Установка значения по ключу
    set(key, value, ttl = 300000) {
      try {
        // Проверка необходимости вытеснения
        if (this.cache.size >= this.maxSize || this.getMemoryUsage() > this.maxMemoryBytes * 0.8) {
          this.evictOldest();
        }

        const item = {
          data: value,
          timestamp: Date.now(),
          ttl: ttl,
          size: this.calculateItemSize(key, value)
        };

        // Удаление существующего ключа (для обновления)
        if (this.cache.has(key)) {
          this.cache.delete(key);
        }

        this.cache.set(key, item);
        this.stats.sets++;

        // Отложенная очистка при приближении к лимиту
        if (this.cache.size > this.maxSize * 0.8) {
          setTimeout(() => this.cleanup(), 500);
        }

        return true;
      } catch (error) {
        console.error('Ошибка при установке значения в кэш:', error);
        return false;
      }
    }

    // Расчет размера элемента
    calculateItemSize(key, value) {
      try {
        let size = key.length;
        size += JSON.stringify(value).length;
        return size;
      } catch (e) {
        return 1000;
      }
    }

    // Очистка устаревших записей
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
          console.log('Автоочистка кэша: удалено ' + cleaned + ' устаревших записей');
        }

        return cleaned;
      } catch (error) {
        console.error('Ошибка при очистке кэша:', error);
        return 0;
      }
    }

    // Вытеснение самого старого элемента
    evictOldest() {
      const iterator = this.cache.keys();
      const firstKey = iterator.next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
      }
    }

    // Получение статистики кэша
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

    // Расчет использования памяти
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

    // Уничтожение кэша
    destroy() {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      this.cache.clear();
      this.stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };
      console.log('Кэш полностью уничтожен');
    }
  }

  // ==================== ИНИЦИАЛИЗАЦИЯ КЭША И МЕТРИК ====================
  // Упрощенные метрики производительности
  global.performanceMetrics = {
    requests: 0,
    errors: 0,
    startTime: Date.now()
  };

  console.log('Инициализация оптимизированного кэша для Render.com');

  const cacheSize = process.env.RENDER ? 50 : 200;
  const cacheMemory = process.env.RENDER ? 25 : 100;

  const quickCache = new OptimizedLRUCache(cacheSize, cacheMemory);
  global.quickCache = quickCache;
  console.log('Оптимизированный кэш инициализирован:', quickCache.getStats());

  const FIREBASE_TIMEOUT = process.env.RENDER ? 10000 : 30000;
  const S3_TIMEOUT = 30000;
  const RETRY_ATTEMPTS = 2;
  const RETRY_BASE_DELAY = 1000;

  // Упрощенный мониторинг памяти
  const MEMORY_LIMIT = process.env.RENDER ? (512 * 1024 * 1024) : (1600 * 1024 * 1024);
  let memoryMonitorInterval = null;

  // Запуск интервалов мониторинга
  function startMonitoringIntervals() {
    stopMonitoringIntervals();

    memoryMonitorInterval = setInterval(() => {
      const memory = process.memoryUsage();
      const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);
      const rssMB = Math.round(memory.rss / 1024 / 1024);

      if (heapUsedMB > MEMORY_LIMIT / 1024 / 1024 * 0.7) {
        console.warn('Высокая загрузка памяти: Heap ' + heapUsedMB + 'MB, RSS ' + rssMB + 'MB');
        quickCache.cleanup();
        if (global.gc) {
          global.gc();
          console.log('Экстренный сбор мусора выполнен');
        }
      }
    }, process.env.RENDER ? 60000 : 300000);
  }

  // Остановка интервалов мониторинга
  function stopMonitoringIntervals() {
    if (memoryMonitorInterval) {
      clearInterval(memoryMonitorInterval);
      memoryMonitorInterval = null;
    }
    console.log('Интервалы мониторинга остановлены');
  }

  startMonitoringIntervals();

  // Функция с повторными попытками и таймаутом
  const withRetry = async (operation, operationName = 'Operation', timeoutMs = FIREBASE_TIMEOUT, maxRetries = RETRY_ATTEMPTS) => {
    let timeoutId;
    try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await Promise.race([
            operation(),
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(new Error('Таймаут операции ' + operationName + ' после ' + timeoutMs + 'мс (попытка ' + attempt + '/' + maxRetries + ')'));
              }, timeoutMs);
            })
          ]);

          if (timeoutId) clearTimeout(timeoutId);
          return result;

        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId);

          if (attempt === maxRetries) {
            throw error;
          }

          const delay = RETRY_BASE_DELAY * Math.pow(1.5, attempt - 1);
          console.warn('Повтор ' + attempt + '/' + maxRetries + ' для ' + operationName + ' через ' + delay + 'мс:', error.message);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      throw error;
    }
  };

  // ==================== EXPRESS И СЕРВИСЫ ====================
  const app = express();
  app.set('trust proxy', 1);

  // Оптимизированные лимитеры для Render.com
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

  // Применение лимитеров
  app.use("/ping", pingLimiter);

  // Единственный ping эндпоинт
  app.get("/ping", (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Response-Priority', 'high');
    res.end('{"pong":' + Date.now() + ',"status":"ok"}');
  });

  // Health check для мониторинга
  app.get("/health-check", (req, res) => {
    res.json({
      status: "healthy",
      timestamp: Date.now(),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    });
  });

  // Основной health эндпоинт
  app.get("/health", (req, res) => {
    res.json({
      status: "OK",
      timestamp: Date.now(),
      uptime: Math.round(process.uptime()),
      environment: process.env.RENDER ? 'render' : 'local'
    });
  });

  // Middleware с приоритетами для легких эндпоинтов
  app.use((req, res, next) => {
    const lightEndpoints = ['/ping', '/health-check', '/health'];
    if (lightEndpoints.includes(req.url)) {
      res.setHeader('X-Request-Priority', 'high');
      return next();
    }

    // Проверка лимита одновременных соединений
    if (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
      connectionFailures++;
      console.warn('Превышен лимит соединений: ' + activeConnections + '/' + MAX_CONCURRENT_CONNECTIONS);

      return res.status(503).json({
        error: "Server busy",
        retryAfter: 30,
        connections: activeConnections
      });
    }

    activeConnections++;

    // Очистка счетчика соединений при завершении запроса
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
    next();
  });

  // Основные middleware
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // Применение лимитеров для тяжелых эндпоинтов
  app.use("/send-event-notification", heavyLimiter);
  app.use("/generate-upload-url", heavyLimiter);
  app.use("/news", apiLimiter);
  app.use("/send-message", apiLimiter);

  // Настройка multer для загрузки файлов
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 3
    }
  });

  // Маппинг MIME-типов на расширения файлов
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

  // Получение расширения файла по MIME-типу
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
    console.log("Firebase инициализирован с оптимизированными настройками");
  } catch (err) {
    console.error("Ошибка инициализации Firebase:", err);
  }

  const db = admin.database();
  const auth = admin.auth();

  // ==================== АВТОМАТИЧЕСКАЯ СИСТЕМА САМООБСЛУЖИВАНИЯ ====================

// Класс для автоматического администрирования системы
class AutomatedAdminSystem {
  constructor() {
    this.lastCheck = Date.now();
    this.problemsDetected = [];
  }

  // Запуск автоматического мониторинга системы
  async startAutomaticMonitoring() {
    console.log('Запуск автоматического мониторинга системы...');

    // Проверка каждые 24 часа
    setInterval(async () => {
      await this.runAutomaticChecks();
    }, 24 * 60 * 60 * 1000);

    // Первая проверка через 30 секунд после запуска
    setTimeout(async () => {
      await this.runAutomaticChecks();
    }, 30000);
  }

  // Выполнение комплекса автоматических проверок
  async runAutomaticChecks() {
    try {
      console.log('Автоматическая проверка системы...');

      const checks = await Promise.allSettled([
        this.checkDataIntegrity(),
        this.checkSystemHealth(),
        this.checkArchiveNeeded()
      ]);

      const problems = checks
        .filter(result => result.status === 'fulfilled' && result.value.hasProblems)
        .map(result => result.value.message);

      // Отправка уведомления администратору если есть проблемы
      if (problems.length > 0) {
        await this.notifyAdmin('Обнаружены проблемы в системе: ' + problems.join(', '));
      }

      // Автоматическое исправление простых проблем
      await this.autoFixCommonProblems();

    } catch (error) {
      console.error('Ошибка автоматической проверки:', error);
    }
  }

  // Автоматическое исправление распространенных проблем данных
  async autoFixCommonProblems() {
    console.log('Автоматическое исправление распространенных проблем...');

    try {
      // Проверка и исправление пользователей без имени
      const usersSnap = await db.ref('users').once('value');
      const users = usersSnap.val() || {};

      let fixedUsers = 0;
      for (const [userId, user] of Object.entries(users)) {
        if (!user.name || user.name === 'Неизвестный') {
          await db.ref(`users/${userId}`).update({
            name: user.name || 'Пользователь'
          });
          fixedUsers++;
        }
      }

      if (fixedUsers > 0) {
        console.log(`Автоматически исправлено ${fixedUsers} пользователей`);
      }

      // Очистка кэша при низкой памяти
      const memoryUsage = process.memoryUsage();
      if (memoryUsage.heapUsed > MEMORY_LIMIT * 0.8) {
        console.log('Автоочистка кэша из-за нехватки памяти');
        if (global.quickCache) {
          global.quickCache.cleanup();
        }
      }

    } catch (error) {
      console.error('Ошибка автоисправления:', error);
    }
  }

  // Запуск автоматической архивации по расписанию - выполняется каждые 30 дней
  async startAutomaticArchiving() {
    console.log('Настройка автоматической архивации...');

    // Архивация каждые 30 дней
    setInterval(async () => {
      try {
        console.log('Запуск автоматической архивации...');
        const archivedCount = await this.archiveOldDataAutomatically();

        if (archivedCount > 0) {
          await this.notifyAdmin(`Автоматически архивировано ${archivedCount} записей`);
        }
      } catch (error) {
        console.error('Ошибка автоматической архивации:', error);
      }
    }, 30 * 24 * 60 * 60 * 1000); // 30 дней
  }

  // Автоматическая архивация данных старше 3 лет - Данные перемещаются в раздел /archive/ в Firebase
  async archiveOldDataAutomatically() {
    try {
      const threeYearsAgo = Date.now() - (3 * 365 * 24 * 60 * 60 * 1000);
      const usersSnap = await db.ref('users').once('value');
      const users = usersSnap.val() || {};

      let archived = 0;
      for (const [userId, user] of Object.entries(users)) {
        // Архивация неактивных пользователей (старше 3 лет)
        if (user.lastActivity && user.lastActivity < threeYearsAgo) {
          // Перемещение в архив с метаданными
          await db.ref(`archive/users/${userId}`).set({
            ...user,
            archivedAt: Date.now(),
            archivedAutomatically: true,
            originalPath: `users/${userId}`
          });
          // Удаление из активных данных
          await db.ref(`users/${userId}`).remove();
          archived++;
        }
      }

      return archived;
    } catch (error) {
      console.error('Ошибка архивации:', error);
      return 0;
    }
  }

  // Запуск автоматического резервного копирования в S3
  async startAutomaticBackups() {
    console.log('Настройка автоматического резервного копирования...');

    // Бэкап каждые 7 дней
    setInterval(async () => {
      try {
        console.log('Запуск автоматического резервного копирования...');
        const result = await dataExporter.createAutomatedBackup();

        if (result.success) {
          console.log(`Автоматический бэкап создан: ${result.fileName}`);

          // Уведомление администратора о успешном бэкапе
          await this.notifyAdmin(`Создана резервная копия: ${result.fileName}`);

          // Очистка старых бэкапов (оставляем только 10 последних)
          await this.cleanupOldBackups();
        } else {
          console.error('Ошибка автоматического бэкапа:', result.error);
          await this.notifyAdmin(`Ошибка создания резервной копии: ${result.error}`);
        }
      } catch (error) {
        console.error('Ошибка автоматического бэкапа:', error);
      }
    }, 7 * 24 * 60 * 60 * 1000); // 7 дней
  }

  // Очистка старых резервных копий (оставляет только 10 последних)
  async cleanupOldBackups() {
    try {
      const backups = await dataExporter.listBackups();

      if (backups.length > 10) {
        const toDelete = backups.slice(10);

        console.log(`Очистка ${toDelete.length} старых бэкапов...`);

        for (const backup of toDelete) {
          await s3.send(new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: backup.key
          }));
          console.log(`Удален старый бэкап: ${backup.key}`);
        }

        return { deleted: toDelete.length };
      }

      return { deleted: 0 };
    } catch (error) {
      console.error('Ошибка очистки старых бэкапов:', error);
      return { deleted: 0, error: error.message };
    }
  }

  // Отправка простых уведомлений администраторам через FCM
  async notifyAdmin(message) {
    try {
      console.log(`Уведомление администратору: ${message}`);

      // Поиск всех администраторов в системе
      const usersSnap = await db.ref('users').once('value');
      const users = usersSnap.val() || {};

      const admins = Object.entries(users)
        .filter(([_, user]) => user.role === 'администратор')
        .map(([userId, user]) => ({ userId, ...user }));

      // Отправка push-уведомлений всем администраторам
      for (const adminUser of admins) {
        if (adminUser.fcmToken) {
          try {
            await admin.messaging().send({
              token: adminUser.fcmToken,
              notification: {
                title: 'Уведомление системы',
                body: message.length > 100 ? message.substring(0, 100) + '...' : message
              },
              data: {
                type: 'system_notification',
                message: message,
                timestamp: String(Date.now())
              }
            });
          } catch (error) {
            console.log(`Не удалось отправить уведомление администратору ${adminUser.userId}`);
          }
        }
      }

    } catch (error) {
      console.error('Ошибка отправки уведомления:', error);
    }
  }

  // Проверка целостности данных пользователей
  async checkDataIntegrity() {
    try {
      const usersSnap = await db.ref('users').once('value');
      const users = usersSnap.val() || {};

      const problems = [];
      for (const [userId, user] of Object.entries(users)) {
        if (!user.name || !user.role) {
          problems.push(`Неполные данные пользователя ${userId}`);
        }
      }

      return {
        hasProblems: problems.length > 0,
        message: problems.length > 0 ? `Найдено ${problems.length} проблем с данными` : 'Данные в порядке'
      };
    } catch (error) {
      return { hasProblems: true, message: 'Ошибка проверки целостности данных' };
    }
  }

  // Проверка здоровья системы и использования ресурсов
  async checkSystemHealth() {
    try {
      const memoryUsage = process.memoryUsage();
      const memoryPercent = (memoryUsage.heapUsed / MEMORY_LIMIT) * 100;

      if (memoryPercent > 80) {
        return {
          hasProblems: true,
          message: `Высокая загрузка памяти: ${Math.round(memoryPercent)}%`
        };
      }

      return { hasProblems: false, message: 'Система работает стабильно' };
    } catch (error) {
      return { hasProblems: true, message: 'Ошибка проверки здоровья системы' };
    }
  }

  // Проверка необходимости архивации данных
  async checkArchiveNeeded() {
    try {
      const threeYearsAgo = Date.now() - (3 * 365 * 24 * 60 * 60 * 1000);
      const usersSnap = await db.ref('users').once('value');
      const users = usersSnap.val() || {};

      const oldUsers = Object.values(users).filter(user =>
        user.lastActivity && user.lastActivity < threeYearsAgo
      ).length;

      if (oldUsers > 0) {
        return {
          hasProblems: true,
          message: `Требуется архивация: ${oldUsers} устаревших записей`
        };
      }

      return { hasProblems: false, message: 'Архивация не требуется' };
    } catch (error) {
      return { hasProblems: true, message: 'Ошибка проверки архивации' };
    }
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ АВТОМАТИЧЕСКОЙ СИСТЕМЫ ====================

const autoAdminSystem = new AutomatedAdminSystem();

// ЗАПУСК АВТОМАТИЧЕСКИХ СИСТЕМ
autoAdminSystem.startAutomaticMonitoring();
autoAdminSystem.startAutomaticArchiving();
autoAdminSystem.startAutomaticBackups();

// ==================== СИСТЕМА ЭКСПОРТА ДАННЫХ ДЛЯ АДМИНИСТРАТОРА ====================

// Обеспечивает бэкапы в Yandex Object Storage и экспорт данных
class DataExporter {
  // Экспорт всех данных системы для администратора
  async exportAllData() {
    try {
      const [usersSnap, groupsSnap, newsSnap] = await Promise.all([
        db.ref('users').once('value'),
        db.ref('groups').once('value'),
        db.ref('news').once('value')
      ]);

      const exportData = {
        timestamp: Date.now(),
        exportDate: new Date().toISOString(),
        users: usersSnap.val() || {},
        groups: groupsSnap.val() || {},
        news: newsSnap.val() || {},
        statistics: {
          usersCount: Object.keys(usersSnap.val() || {}).length,
          groupsCount: Object.keys(groupsSnap.val() || {}).length,
          newsCount: Object.keys(newsSnap.val() || {}).length
        }
      };

      return exportData;
    } catch (error) {
      console.error('Ошибка экспорта данных:', error);
      throw error;
    }
  }

  // Получение системной статистики для мониторинга
  async getSystemStatistics() {
    try {
      const [usersSnap, groupsSnap, newsSnap] = await Promise.all([
        db.ref('users').once('value'),
        db.ref('groups').once('value'),
        db.ref('news').once('value')
      ]);

      const users = usersSnap.val() || {};
      const groups = groupsSnap.val() || {};
      const news = newsSnap.val() || {};

      // Статистика по ролям
      const roles = {};
      Object.values(users).forEach(user => {
        const role = user.role || 'неизвестно';
        roles[role] = (roles[role] || 0) + 1;
      });

      return {
        timestamp: Date.now(),
        users: {
          total: Object.keys(users).length,
          byRole: roles
        },
        groups: {
          total: Object.keys(groups).length,
          withTeachers: Object.values(groups).filter(group =>
            group.teachers && Object.keys(group.teachers).length > 0
          ).length
        },
        news: {
          total: Object.keys(news).length
        },
        system: {
          uptime: process.uptime(),
          memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
          cacheStats: global.quickCache ? global.quickCache.getStats() : null
        }
      };
    } catch (error) {
      console.error('Ошибка получения статистики:', error);
      throw error;
    }
  }

  // Автоматическое создание резервной копии в Yandex Object Storage
  async createAutomatedBackup() {
    try {
      console.log('Создание автоматической резервной копии в S3...');

      const backupData = await this.exportAllData();
      const fileName = `backups/auto-backup-${Date.now()}.json`;

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: JSON.stringify(backupData, null, 2),
        ContentType: 'application/json'
      }));

      const backupUrl = `https://storage.yandexcloud.net/${BUCKET_NAME}/${fileName}`;
      console.log(`Резервная копия создана: ${fileName}`);

      return {
        success: true,
        fileName,
        backupUrl,
        timestamp: Date.now(),
        size: JSON.stringify(backupData).length
      };

    } catch (error) {
      console.error('Ошибка создания автоматического бэкапа:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Получение списка всех резервных копий из S3
  async listBackups() {
    try {
      const command = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: 'backups/'
      });

      const response = await s3.send(command);
      const backups = response.Contents || [];

      return backups.map(backup => {
        const url = `https://storage.yandexcloud.net/${BUCKET_NAME}/${backup.Key}`;
        return {
          key: backup.Key,
          size: backup.Size,
          lastModified: backup.LastModified,
          url: url
        };
      }).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    } catch (error) {
      console.error('Ошибка получения списка бэкапов:', error);
      return [];
    }
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ СИСТЕМЫ ЭКСПОРТА ====================

const dataExporter = new DataExporter();

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

  // Получение пользователя с кэшированием
  async function getUserWithCache(userId) {
    const cacheKey = 'user_' + userId;
    const cached = quickCache.get(cacheKey);

    if (cached) {
      if (process.env.NODE_ENV === 'development') {
        console.log('Кэш попадание для пользователя: ' + userId);
      }
      return cached;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('Кэш промах для пользователя: ' + userId);
    }

    try {
      const userSnap = await safeFirebaseOperation(
        () => db.ref('users/' + userId).once('value'),
        'Получение пользователя ' + userId + ' из Firebase'
      );
      const userData = userSnap.val();

      if (userData) {
        quickCache.set(cacheKey, userData, 1200000);
        if (process.env.NODE_ENV === 'development') {
          console.log('Пользователь ' + userId + ' сохранен в кэш');
        }
      }

      return userData;
    } catch (error) {
      console.error('Ошибка получения пользователя ' + userId + ':', error.message);
      return null;
    }
  }

  // Получение новостей с кэшированием
  async function getNewsWithCache(groupId) {
    const cacheKey = 'news_' + groupId;
    const cached = quickCache.get(cacheKey);

    if (cached) {
      if (process.env.NODE_ENV === 'development') {
        console.log('Кэш попадание для новостей группы: ' + groupId);
      }
      return cached;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('Кэш промах для новостей группы: ' + groupId);
    }

    try {
      const newsSnap = await safeFirebaseOperation(
        () => db.ref('news/' + groupId).once('value'),
        'Получение новостей группы ' + groupId + ' из Firebase'
      );
      const newsData = newsSnap.val() || {};

      quickCache.set(cacheKey, newsData, 900000);
      if (process.env.NODE_ENV === 'development') {
        console.log('Новости группы ' + groupId + ' сохранены в кэш');
      }

      return newsData;
    } catch (error) {
      console.error('Ошибка получения новостей группы ' + groupId + ':', error.message);
      return {};
    }
  }

  // Получение структуры групп с кэшированием
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

      quickCache.set(cacheKey, groupsData, 3600000);
      if (process.env.NODE_ENV === 'development') {
        console.log('Структура групп сохранена в кэш');
      }

      return groupsData;
    } catch (error) {
      console.error('Ошибка получения структуры групп:', error.message);
      return {};
    }
  }

  // Получение группы с кэшированием
  async function getGroupWithCache(groupId) {
    const cacheKey = 'group_' + groupId;
    const cached = quickCache.get(cacheKey);

    if (cached) {
      if (process.env.NODE_ENV === 'development') {
        console.log('Кэш попадание для группы: ' + groupId);
      }
      return cached;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('Кэш промах для группы: ' + groupId);
    }

    try {
      const groupSnap = await safeFirebaseOperation(
        () => db.ref('groups/' + groupId).once('value'),
        'Получение группы ' + groupId + ' из Firebase'
      );
      const groupData = groupSnap.val();

      if (groupData) {
        quickCache.set(cacheKey, groupData, 1800000);
        if (process.env.NODE_ENV === 'development') {
          console.log('Группа ' + groupId + ' сохранена в кэш');
        }
      }

      return groupData;
    } catch (error) {
      console.error('Ошибка получения группы ' + groupId + ':', error.message);
      return null;
    }
  }

  // ==================== MIDDLEWARE И УТИЛИТЫ ====================

  // Middleware проверки токена
  async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

    if (!token) {
      console.warn("Проверка токена: отсутствует заголовок Authorization");
      return res.status(401).send("Нет токена");
    }

    try {
      const decoded = await safeFirebaseOperation(
        () => admin.auth().verifyIdToken(token),
        'Проверка токена Firebase'
      );
      req.user = decoded;
      if (process.env.NODE_ENV === 'development') {
        console.log("Проверка токена: токен валиден, uid:", decoded.uid);
      }
      next();
    } catch (err) {
      console.error("Проверка токена: токен недействителен или истёк", err);
      res.status(403).send("Неверный токен");
    }
  }

  // Загрузка файла в S3
  async function uploadToS3(buffer, fileName, contentType) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read'
    }));
    return 'https://' + BUCKET_NAME + '.storage.yandexcloud.net/' + fileName;
  }

  // Загрузка в S3 с повторными попытками
  async function uploadToS3WithRetry(buffer, fileName, contentType, retries = RETRY_ATTEMPTS) {
    return withRetry(
      () => uploadToS3(buffer, fileName, contentType),
      'Загрузка в S3',
      S3_TIMEOUT,
      retries
    );
  }

  // Удаление файлов из S3
  async function deleteFromS3(urls) {
    const keys = urls.map(url => {
      const parts = url.split(BUCKET_NAME + '/');
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

    // УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ
    app.post('/deleteUserByName', async (req, res) => {
      // Удаление пользователя по имени (родитель, педагог или ребенок)
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

        // Поиск пользователя по имени и роли
        for (const [userId, user] of Object.entries(users)) {
          const name = user.name?.trim().toLowerCase();
          const role = user.role?.trim().toLowerCase();

          // Обработка удаления родителя
          if (name === fullName && role === 'родитель') {
            found = true;

            // Удаление детей родителя из групп
            if (user.children) {
              const filesToDelete = [];

              for (const [childId, child] of Object.entries(user.children)) {
                if (child.group) {
                  await db.ref(`groups/${child.group}/children/${childId}`).remove();
                  quickCache.cache.delete(`group_${child.group}`);
                }
                if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
              }

              // Удаление файлов аватаров из S3
              if (filesToDelete.length > 0) {
                await deleteFromS3(filesToDelete);
              }
            }

            // Удаление пользователя из базы
            await db.ref(`users/${userId}`).remove();
            quickCache.cache.delete(`user_${userId}`);

            // Удаление из Firebase Auth
            try {
              await auth.getUser(userId);
              await auth.deleteUser(userId);
            } catch (authError) {
              console.log("Пользователь не найден в Auth, пропускаем:", authError.message);
            }

            return res.send("Родитель и его дети удалены.");
          }

          // Обработка удаления педагога
          if (name === fullName && role === 'педагог') {
            found = true;

            // Удаление педагога из всех групп
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

          // Обработка удаления ребенка
          if (user.children) {
            for (const [childId, child] of Object.entries(user.children)) {
              if (child.fullName?.trim().toLowerCase() === fullName) {
                found = true;

                // Удаление ребенка из группы
                if (child.group) {
                  await db.ref(`groups/${child.group}/children/${childId}`).remove();
                  quickCache.cache.delete(`group_${child.group}`);
                }

                // Удаление аватара из S3
                const filesToDelete = [];
                if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
                if (filesToDelete.length > 0) {
                  await deleteFromS3(filesToDelete);
                }

                // Удаление ребенка из пользователя
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
      // Удаление конкретного ребенка по userId и childId
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

        // Поиск ID группы по названию
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

        // Удаление ребенка из группы
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

        // Удаление файлов аватара из S3
        const filesToDelete = [];
        if (child.avatarUrl) {
          filesToDelete.push(child.avatarUrl);
        }

        if (filesToDelete.length > 0) {
          await deleteFromS3(filesToDelete);
        }

        // Удаление ребенка из пользователя
        await childRef.remove();
        quickCache.cache.delete(`user_${userId}`);

        res.json({
          success: true,
          message: `Ребенок ${childName} успешно удален`
        });

      } catch (err) {
        global.performanceMetrics.errors++;
        console.error('Ошибка при deleteChild:', err);

        if (err.message.includes('timeout')) {
          return res.status(408).json({ error: "Операция заняла слишком много времени" });
        }

        res.status(500).json({ error: "Ошибка при удалении ребенка" });
      }
    });

    app.post("/admin/remove-old-passwords", verifyToken, async (req, res) => {
      // Удаление старых паролей из базы данных
      const usersSnapshot = await db.ref('users').once('value');
      const users = usersSnapshot.val() || {};

      let updated = 0;
      for (const [userId, userData] of Object.entries(users)) {
        if (userData.password) {
          await db.ref(`users/${userId}`).update({ password: null });
          updated++;
        }
      }

      res.json({ success: true, updated: updated });
    });

    app.post("/admin/migrate-passwords", verifyToken, async (req, res) => {
      // Миграция паролей на двухуровневую систему хранения
      try {
        const usersSnapshot = await db.ref('users').once('value');
        const users = usersSnapshot.val() || {};

        const bcrypt = require('bcryptjs');
        const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);

        let migratedCount = 0;
        let errorCount = 0;
        const batchSize = 50;

        const entries = Object.entries(users);

        // Обработка пользователей батчами
        for (let i = 0; i < entries.length; i += batchSize) {
          const batch = entries.slice(i, i + batchSize);

          const promises = batch.map(async ([userId, userData]) => {
            // Миграция только если есть пароль и нет хэша
            if (userData && userData.password && !userData.passwordHash) {
              try {
                const plain = userData.password;

                // Создание безопасного хэша для аутентификации
                const hash = await bcrypt.hash(plain, saltRounds);

                // Создание base64 для показа администратору
                const encryptedForDisplay = Buffer.from(plain).toString('base64');

                // Обновление записи пользователя
                await db.ref(`users/${userId}`).update({
                  passwordHash: hash,           // для проверки паролей
                  encryptedPassword: encryptedForDisplay, // для показа админу
                  password: null                // удаляем открытый пароль
                });

                migratedCount++;
                return { ok: true, id: userId };
              } catch (err) {
                errorCount++;
                console.error(`Ошибка при миграции пользователя ${userId}:`, err.message);
                return { ok: false, id: userId, error: err.message };
              }
            } else {
              return { ok: null, id: userId }; // пропуск
            }
          });

          await Promise.all(promises);
        }

        res.json({
          success: true,
          message: `Миграция завершена: ${migratedCount} успешно, ${errorCount} ошибок`,
          migrated: migratedCount,
          errors: errorCount
        });
      } catch (error) {
        console.error("Ошибка миграции:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/update-user", async (req, res) => {
      // Обновление email пользователя
      try {
        const { fullName, newEmail } = req.body;
        if (!fullName || !newEmail) return res.status(400).json({ error: "fullName и newEmail обязательны" });

        // Поиск пользователя по имени
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

        // Обновление email в Firebase Auth и базе данных
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

    // НОВОСТИ И СОБЫТИЯ
    app.put("/news", verifyToken, async (req, res) => {
      // Редактирование существующей новости
      try {
        const { newsId, groupId, title, description, imagesToKeep = [], video } = req.body;
        const authorId = req.user.uid;

        if (!newsId || !groupId || !title || !description) {
          return res.status(400).json({ error: "newsId, groupId, title и description обязательны" });
        }

        const ref = db.ref(`news/${groupId}/${newsId}`);
        const snap = await safeFirebaseOperation(
          () => ref.once("value"),
          'Редактирование новости'
        );

        const oldNews = snap.val();
        if (!oldNews) {
          return res.status(404).json({ error: "Новость не найдена" });
        }

        // Проверка прав на редактирование
        if (oldNews.authorId !== authorId) {
          return res.status(403).json({ error: "Нет прав для редактирования этой новости" });
        }

        // Сбор всех медиафайлов
        const mediaUrls = [...imagesToKeep];
        if (video) {
          mediaUrls.push(video);
        }

        // Определение файлов для удаления
        const oldUrls = oldNews.mediaUrls || [];
        const keepSet = new Set(mediaUrls);
        const toDelete = oldUrls.filter(url => !keepSet.has(url));

        // Удаление старых файлов из S3
        if (toDelete.length > 0) {
          await deleteFromS3(toDelete);
        }

        // Полное обновление данных новости
        const updatedData = {
          id: newsId,
          title: title.trim(),
          description: description.trim(),
          mediaUrls: mediaUrls,
          authorId: oldNews.authorId, // Сохраняем оригинального автора
          groupId: groupId,
          timestamp: oldNews.timestamp, // Сохраняем оригинальное время создания
          updatedAt: Date.now() // Добавляем время обновления
        };

        await ref.update(updatedData);

        // Очистка кэша для этой группы
        quickCache.cache.delete(`news_${groupId}`);

        // Возврат полных обновленных данных
        return res.json({
          success: true,
          updated: true,
          news: updatedData,
          deletedFiles: toDelete.length
        });

      } catch (err) {
        global.performanceMetrics.errors++;

        if (err.message.includes('timeout')) {
          return res.status(408).json({ error: "Операция заняла слишком много времени" });
        }

        console.error("Ошибка PUT /news:", err);
        res.status(500).json({ error: err.message });
      }
    });

    app.post("/news", verifyToken, async (req, res) => {
      // Создание новой новости
      try {
        const { groupId, title, description, mediaUrls = [] } = req.body;
        const authorId = req.user.uid;

        if (!groupId || !title || !description) {
          return res.status(400).json({ error: "groupId, title и description обязательны" });
        }

        const id = uuidv4();
        const ref = db.ref(`news/${groupId}/${id}`);

        const data = {
          id,
          title: title.trim(),
          description: description.trim(),
          mediaUrls,
          timestamp: Date.now(),
          authorId,
          groupId
        };

        await ref.set(data);

        // Очистка кэша
        quickCache.cache.delete(`news_${groupId}`);

        return res.json({
          success: true,
          id,
          news: data
        });

      } catch (err) {
        global.performanceMetrics.errors++;

        if (err.message.includes('timeout')) {
          return res.status(408).json({ error: "Операция заняла слишком много времени" });
        }

        console.error("Ошибка POST /news:", err);
        res.status(500).json({ error: err.message });
      }
    });

    app.post("/deleteNews", verifyToken, async (req, res) => {
      // Удаление новости
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

        // Удаление медиафайлов из S3
        const urls = data.mediaUrls || [];
        await deleteFromS3(urls);

        // Удаление новости из базы
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

    app.get("/news", verifyToken, async (req, res) => {
      // Получение списка новостей для группы
      try {
        const { groupId } = req.query;
        const userId = req.user.uid;

        if (!groupId) {
          return res.status(400).json({ error: "groupId обязателен" });
        }

        console.log(`GET /news запрос для группы: ${groupId}, пользователь: ${userId}`);

        // Использование кэшированных данных
        const newsData = await getNewsWithCache(groupId);

        // Преобразование объекта в массив
        const newsArray = Object.entries(newsData || {}).map(([id, news]) => ({
          id,
          ...news
        }));

        // Сортировка по времени (новые сначала)
        newsArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        console.log(`Возвращаем ${newsArray.length} новостей для группы ${groupId}`);

        res.json(newsArray);

      } catch (err) {
        global.performanceMetrics.errors++;

        if (err.message.includes('timeout')) {
          return res.status(408).json({ error: "Операция заняла слишком много времени" });
        }

        console.error("Ошибка GET /news:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // ЗАГРУЗКА ФАЙЛОВ
    app.post('/generate-upload-url', verifyToken, async (req, res) => {
      // Генерация signed URL для загрузки файлов в S3
      try {
        const { fileName, fileType, groupId, isPrivateChat, context } = req.body;

        if (!fileName || !fileType) {
          return res.status(400).json({ error: "fileName и fileType обязательны" });
        }

        const fileExtension = getFileExtension(fileType);
        let finalFileName = fileName;

        // Проверка и коррекция расширения файла
        if (!finalFileName.includes('.') || !finalFileName.toLowerCase().endsWith(fileExtension.toLowerCase())) {
          const baseName = finalFileName.includes('.')
            ? finalFileName.substring(0, finalFileName.lastIndexOf('.'))
            : finalFileName;
          finalFileName = baseName + fileExtension;
        }

        // Определение папки для загрузки
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

        // Проверка доступа к чату
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

        // Генерация уникального ключа файла
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
        console.error("Ошибка генерации upload URL:", err);

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
      // Проверка доступа пользователя к чату
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
      // Определение типа чата (приватный/групповой)
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
        console.error("Ошибка определения типа чата:", error);
        return chatId.includes('_');
      }
    }

    // ЧАТ И СООБЩЕНИЯ
    app.post("/send-message", verifyToken, async (req, res) => {
      // Отправка сообщения в чат
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

        // Определение типа чата
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

        // Отправка уведомления
        sendChatNotification({
          chatId,
          senderId,
          senderName,
          message,
          messageType,
          fileUrl,
          fileName,
          isPrivate: isPrivateChat
        }).catch(err => console.error("Ошибка отправки уведомления:", err));

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

        console.error("Ошибка отправки сообщения:", err);
        res.status(500).json({ error: err.message });
      }
    });

    app.post("/save-fcm-token", verifyToken, async (req, res) => {
      // Сохранение FCM токена для push-уведомлений
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
        console.error("Ошибка сохранения FCM токена:", err);
        res.status(500).json({ error: err.message });
      }
    });

    async function removeInvalidToken(invalidToken) {
      // Удаление невалидного FCM токена
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
        console.error("Ошибка удаления токена:", err);
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
      // Отправка push-уведомления о новом сообщении
      try {
        let recipients = [];
        let chatTitle = "";

        // Определение получателей для приватного чата
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
          // Определение получателей для группового чата
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
        console.error("Ошибка в sendChatNotification:", error);
        return { successful: 0, total: 0 };
      }
    }

    function getFileTypeText(messageType) {
      // Получение текстового описания типа файла
      switch (messageType) {
        case 'image': return 'Изображение';
        case 'video': return 'Видео';
        case 'audio': return 'Аудио';
        case 'file': return 'Файл';
        default: return 'Файл';
      }
    }

    // УВЕДОМЛЕНИЯ О СОБЫТИЯХ
    async function preloadParentsData(groupId) {
      // Предзагрузка данных родителей для группы с кэшированием
      const cacheKey = `parents_${groupId}`;
      const cached = quickCache.get(cacheKey);

      if (cached) {
        if (process.env.NODE_ENV === 'development') {
          console.log(`Кэш попадание для родителей группы: ${groupId}`);
        }
        return cached;
      }

      if (process.env.NODE_ENV === 'development') {
        console.log(`Кэш промах для родителей группы: ${groupId}`);
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

        // Поиск родителей детей из группы
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
          console.log(`Данные родителей группы ${groupId} сохранены в кэш (${parents.length} родителей)`);
        }

        return parents;

      } catch (error) {
        console.error("Ошибка предзагрузки родителей:", error);
        return [];
      }
    }

    async function findParentsByGroupIdOptimized(groupId) {
      // Оптимизированный поиск родителей по ID группы
      return await preloadParentsData(groupId);
    }

    async function sendNotificationsParallel(recipients, createMessagePayload, batchSize = 15) {
      // Параллельная отправка уведомлений батчами
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

        // Задержка между батчами для избежания перегрузки
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
      // Оптимизированная отправка уведомлений о событиях
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
        console.error("Ошибка в sendEventNotificationsOptimized:", err);
        return { successful: 0, failed: parents.length, errors: [err] };
      }
    }

    app.post("/send-event-notification", verifyToken, async (req, res) => {
      // Отправка уведомлений о новом событии
      try {
        const { groupId, eventId, title, time, place, comments, date } = req.body;

        if (!groupId || !eventId || !title) {
          return res.status(400).json({
            error: "groupId, eventId, title обязательны"
          });
        }

        // Получение названия группы
        const actualGroupName = await withRetry(
          () => getGroupName(groupId),
          'Получение названия группы',
          8000
        );

        // Поиск родителей группы
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

        // Отправка уведомлений
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

        console.error("Ошибка отправки уведомления о событии:", err);
        res.status(500).json({
          error: "Внутренняя ошибка сервера: " + err.message
        });
      }
    });

    async function getGroupName(groupId) {
      // Получение названия группы по ID
      try {
        const groupData = await getGroupWithCache(groupId);
        return groupData?.name || `Группа ${groupId}`;
      } catch (error) {
        console.error("Ошибка получения названия группы:", error);
        return `Группа ${groupId}`;
      }
    }

    function formatEventNotification(title, time, place, groupName) {
      // Форматирование текста уведомления о событии
      let notification = `📅 ${title}`;
      if (time) notification += ` в ${time}`;
      if (place) notification += ` (${place})`;
      if (groupName) notification += ` • ${groupName}`;
      return notification;
    }
 // ==================== HEALTH CHECKS И МОНИТОРИНГ ====================

 // Защита от частых запросов warmup
 let lastWarmupTime = 0;
 const WARMUP_COOLDOWN = 30000; // 30 секунд между разогревами
 let isWarmupInProgress = false;

 app.get("/warmup-cache", async (req, res) => {
   // Эндпоинт для разогрева кэша с защитой от частых запросов
   const startTime = Date.now();
   const requestId = Math.random().toString(36).substring(2, 8);

   console.log(`[${requestId}] GET /warmup-cache - Запрос от ${req.ip || 'unknown'}`);

   // Проверка частоты запросов
   const now = Date.now();
   const timeSinceLastWarmup = now - lastWarmupTime;

   // Проверка, выполняется ли уже разогрев
   if (isWarmupInProgress) {
     console.log(`[${requestId}] Разогрев уже выполняется, пропускаем...`);
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

   // Проверка cooldown периода
   if (timeSinceLastWarmup < WARMUP_COOLDOWN) {
     const remainingCooldown = Math.ceil((WARMUP_COOLDOWN - timeSinceLastWarmup) / 1000);
     console.log(`[${requestId}] Слишком частый запрос, cooldown: ${remainingCooldown}с`);
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

     // Блокируем повторные вызовы
     isWarmupInProgress = true;
     lastWarmupTime = now;

     // Немедленный ответ, разогрев в фоне
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

     // Фоновый разогрев с защитой
     setTimeout(async () => {
       try {
         console.log(`[${requestId}] Фоновый разогрев кэша...`);

         const warmupStart = Date.now();

         // Ограничиваем параллельные вызовы для критических данных
         await Promise.allSettled([
           getGroupsStructureWithCache(),
         ]);

         const warmupTime = Date.now() - warmupStart;
         const finalStats = quickCache.getStats();

         console.log(`[${requestId}] Фоновый разогрев завершен за ${warmupTime}ms`);
         console.log(`[${requestId}] Кэш: ${finalStats.size} записей, HitRate: ${finalStats.hitRate}`);

       } catch (error) {
         console.error(`[${requestId}] Ошибка фонового разогрева:`, error.message);
       } finally {
         // Разблокировка в любом случае
         isWarmupInProgress = false;
       }
     }, 100);

   } catch (error) {
     // Разблокировка при ошибке
     isWarmupInProgress = false;

     console.error(`[${requestId}] Ошибка warmup-cache:`, error);
     res.status(500).json({
       success: false,
       requestId: requestId,
       error: error.message,
       responseTime: `${Date.now() - startTime}ms`
     });
   }
 });

 app.post("/warmup-cache", async (req, res) => {
   // POST эндпоинт для принудительного разогрева кэша
   try {
     console.log('Разогрев кэша...');

     const startTime = Date.now();

     // Предзагрузка критических данных в кэш
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
     console.error('Ошибка разогрева кэша:', error);
     res.status(500).json({
       success: false,
       error: error.message,
       stats: quickCache.getStats()
     });
   }
 });

 app.get("/environment", (req, res) => {
   // Информация о среде выполнения приложения
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

 app.get("/load-metrics", (req, res) => {
   // Метрики текущей нагрузки сервера
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
   // Простой эндпоинт для проверки доступности сервера
   console.log(`External keep-alive ping from: ${req.ip || 'unknown'}`);

   res.json({
     status: "alive",
     server_time: new Date().toISOString(),
     uptime: Math.round(process.uptime()) + "s",
     version: "2.0.0-optimized-cache",
     environment: process.env.NODE_ENV || 'production'
   });
 });

 app.get("/wake-up", async (req, res) => {
   // Эндпоинт для пробуждения сервера и проверки зависимостей
   console.log('Сервер пробужден внешним запросом');

   try {
     // Проверка доступности Firebase
     const firebaseAlive = await withRetry(
       () => db.ref('.info/connected').once('value'),
       'Wake-up Firebase check',
       3000
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
   // Детальные метрики производительности сервера
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
     memory: {
       rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
       heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
       external: Math.round(process.memoryUsage().external / 1024 / 1024) + 'MB'
     },
     cache: quickCache.getStats(),
     gc: global.gc ? 'available' : 'unavailable'
   });
 });

 app.get("/info", (req, res) => {
   // Общая информация о сервере и его возможностях
   res.json({
     service: "Firebase Admin Notification Server",
     version: "2.0.0-optimized-cache",
     optimization: {
       lru_cache: "enhanced",
       user_caching: "implemented",
       news_caching: "implemented",
       groups_caching: "implemented",
       health_cache: "implemented"
     },
     cache_config: {
       max_size: quickCache.maxSize,
       max_memory: Math.round(quickCache.maxMemoryBytes / 1024 / 1024) + "MB",
       default_ttl: "10 minutes"
     },
     endpoints: {
       "GET /ping": "Быстрый пинг",
       "GET /load-metrics": "Метрики нагрузки",
       "GET /news": "Новости с кэшированием",
       "POST /send-message": "Сообщения с кэшированием пользователей",
       "GET /health": "Проверка работоспособности",
       "GET /info": "Информация о сервере и кэше",
       "POST /warmup-cache": "Разогрев кэша",
       "GET /environment": "Информация об окружении"
     }
   });
 });

 app.get("/cache-stats", (req, res) => {
   // Детальная статистика кэша
   const stats = quickCache.getStats();

   res.json({
     quickCache: stats,
     globalPerformance: {
       requests: global.performanceMetrics.requests,
       errors: global.performanceMetrics.errors,
       uptime: Date.now() - global.performanceMetrics.startTime
     },
     timestamp: Date.now(),
     cacheKeys: Array.from(quickCache.cache.keys()).slice(0, 10) // Первые 10 ключей для отладки
   });
 });

 app.post("/reset-cache", (req, res) => {
   // Принудительный сброс всего кэша
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

 app.get("/", (req, res) => {
   // Корневой эндпоинт с основной информацией
   res.json({
     message: "Firebase Admin Server работает",
     timestamp: Date.now(),
     endpoints: [
       "/ping - Быстрый пинг",
       "/health - Проверка здоровья",
       "/load-metrics - Метрики нагрузки",
       "/info - Информация о сервере",
       "/metrics - Метрики производительности",
       "/warmup-cache - Разогрев кэша",
       "/environment - Информация об окружении"
     ]
   });
 });


 app.get("/admin/simple-status", verifyToken, async (req, res) => {
   try {
     const user = await getUserWithCache(req.user.uid);
     if (user.role !== 'администратор') {
       return res.status(403).json({ error: "Требуются права администратора" });
     }

     // Простая статусная страница "зеленый/желтый/красный"
     const memoryUsage = process.memoryUsage();
     const memoryPercent = Math.round((memoryUsage.heapUsed / MEMORY_LIMIT) * 100);

     const status = {
       system: memoryPercent < 70 ? 'Отлично' : memoryPercent < 85 ? 'Внимание' : 'Проблема',
       memory: `${memoryPercent}% использовано`,
       users: 'Автоматически управляется',
       archive: 'Автоматически выполняется',
       lastCheck: new Date().toLocaleString('ru-RU'),
       message: 'Система работает в автоматическом режиме'
     };

     res.json(status);

   } catch (error) {
     res.status(500).json({ error: error.message });
   }
 });

 app.get("/debug-s3", (req, res) => {
   res.json({
     bucket: process.env.YC_S3_BUCKET,
     accessKey: process.env.YC_ACCESS_KEY ? "Есть" : "Нет",
     secretKey: process.env.YC_SECRET_KEY ? "Есть" : "Нет",
     region: process.env.YC_S3_REGION
   });
 });

 function startExternalKeepAlive() {
   // Функция для поддержания активности на Render.com
   if (!process.env.RENDER_EXTERNAL_URL) return;

   console.log('Внешний keep-alive активирован для Render.com');

   const externalUrl = process.env.RENDER_EXTERNAL_URL;

   // Основной интервал - каждые 60 секунд
   setInterval(() => {
     require('https').request(externalUrl + '/health', {
       timeout: 5000
     }, () => {}).on('error', () => {}).end();
   }, 60000);

   console.log('Keep-alive запущен: запросы каждые 60 секунд');
 }

 // Запуск сервера
 if (process.env.RENDER_EXTERNAL_URL) {
   console.log('Запуск на Render.com обнаружен');
   console.log(`External URL: ${process.env.RENDER_EXTERNAL_URL}`);
   console.log(`Port: ${PORT}`);
 }

 const server = app.listen(PORT, '0.0.0.0', () => {
   // Запуск HTTP сервера и инициализация компонентов
   console.log(`Сервер запущен на порту ${PORT}`);
   console.log(`Лимит памяти: ${Math.round(MEMORY_LIMIT / 1024 / 1024)}MB`);
   console.log(`Лимит кэша: ${quickCache.maxSize} записей, ${Math.round(quickCache.maxMemoryBytes / 1024 / 1024)}MB`);
   console.log(`Максимум соединений: ${MAX_CONCURRENT_CONNECTIONS}`);
   console.log(`Таймаут Firebase: ${FIREBASE_TIMEOUT}мс`);
   console.log(`Таймаут S3: ${S3_TIMEOUT}мс`);
   console.log(`Circuit breaker: включен`);

   // Запуск мониторинга и keep-alive
   startMonitoringIntervals();
   startExternalKeepAlive();

   // Отложенная предзагрузка критических данных
   setTimeout(preloadCriticalData, 5000);
 });

 // Настройка таймаутов сервера
 server.keepAliveTimeout = 30000;
 server.headersTimeout = 35000;

 function gracefulShutdown() {
   // Грациозное завершение работы сервера
   console.log('Начало плавного завершения работы...');

   // Остановка мониторинга
   stopMonitoringIntervals();

   console.log('Финальная статистика кэша:', quickCache.getStats());
   console.log(`Активные HTTP соединения: ${activeConnections}`);

   // Уничтожение кэша
   quickCache.destroy();

   // Закрытие HTTP сервера
   server.close(() => {
     console.log('HTTP сервер закрыт');

     // Закрытие Firebase соединений
     if (admin.apps.length) {
       Promise.all(admin.apps.map(app => app.delete()))
         .then(() => {
           console.log('Firebase соединения закрыты');
           process.exit(0);
         })
         .catch(err => {
           console.error('Ошибка закрытия Firebase:', err);
           process.exit(1);
         });
     } else {
       process.exit(0);
     }
   });

   // Принудительное завершение через 5 секунд
   setTimeout(() => {
     console.log('Принудительное завершение');
     process.exit(1);
   }, 5000);
 }

 // Обработчики сигналов завершения
 process.on('SIGTERM', gracefulShutdown);
 process.on('SIGINT', gracefulShutdown);

 async function preloadCriticalData() {
   // Предзагрузка критически важных данных в кэш при запуске
   console.log('Предзагрузка критических данных в кэш...');
   try {
     await getGroupsStructureWithCache();
     console.log('Критические данные загружены в кэш');

     const stats = quickCache.getStats();
     console.log('Статус кэша после предзагрузки:', {
       size: stats.size,
       memoryUsage: stats.memoryUsage,
       timestamp: new Date().toISOString()
     });
   } catch (error) {
     console.log('Предзагрузка данных пропущена:', error.message);
   }
 }

 console.log('Оптимизированная версия для Render.com:');
 console.log('   Адаптивные лимиты памяти и соединений');
 console.log('   Уменьшенные таймауты Firebase');
 console.log('   Оптимизированный кэш');
 console.log('   Улучшенная обработка ошибок');
 console.log('   Проактивный мониторинг ресурсов');
 }