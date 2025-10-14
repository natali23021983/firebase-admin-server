require('dotenv').config();
const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListBucketsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const pino = require('pino');
const expressPino = require('express-pino-logger');
const rateLimit = require('express-rate-limit');

// ==================== КОНФИГУРАЦИЯ ====================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// Оптимизация для production
if (NODE_ENV === 'production') {
  // Увеличиваем лимиты памяти
  require('v8').setFlagsFromString('--max_old_space_size=4096');
}

const logger = pino({
  level: process.env.LOG_LEVEL || (NODE_ENV === 'development' ? 'debug' : 'info'),
  transport: NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined
});

const expressLogger = expressPino({ logger });

// ✅ Создаём приложение Express
const app = express();

// ==================== MIDDLEWARE ====================
app.use(expressLogger);

// Оптимизированные лимиты для Render.com
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Таймауты для предотвращения зависаний
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    logger.warn(`Request timeout: ${req.method} ${req.path}`);
  });
  res.setTimeout(30000);
  next();
});

// CORS с оптимизацией
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Rate limiting
const healthLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 100,
  message: { error: 'Слишком много запросов к health endpoint' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Слишком много запросов' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/health', healthLimiter);
app.use('/api/', apiLimiter);

// ==================== FIREBASE INIT ====================
let firebaseInitialized = false;
let db = null;
let auth = null;

try {
  const base64 = process.env.FIREBASE_CONFIG;
  if (!base64) {
    logger.error("❌ FIREBASE_CONFIG переменная не найдена в .env");
    process.exit(1);
  }

  const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));

  // Оптимизированная конфигурация Firebase
  const firebaseConfig = {
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL,
    httpAgent: new require('http').Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      timeout: 10000
    })
  };

  // Проверяем, не инициализирован ли уже Firebase
  if (admin.apps.length === 0) {
    admin.initializeApp(firebaseConfig);
  }

  db = admin.database();
  auth = admin.auth();
  firebaseInitialized = true;
  logger.info("✅ Firebase инициализирован");

} catch (err) {
  logger.error("🔥 Критическая ошибка инициализации Firebase:", err);
  process.exit(1);
}

// ==================== YANDEX S3 CONFIG ====================
const s3 = new S3Client({
  region: process.env.YC_S3_REGION || "ru-central1",
  endpoint: process.env.YC_S3_ENDPOINT || "https://storage.yandexcloud.net",
  credentials: {
    accessKeyId: process.env.YC_ACCESS_KEY,
    secretAccessKey: process.env.YC_SECRET_KEY,
  },
  requestHandler: {
    connectionTimeout: 10000,
    socketTimeout: 30000
  },
  maxAttempts: 3
});

const BUCKET_NAME = process.env.YC_S3_BUCKET;

if (!BUCKET_NAME) {
  logger.error("❌ YC_S3_BUCKET не настроен");
  process.exit(1);
}

logger.info(`✅ S3 клиент инициализирован, bucket: ${BUCKET_NAME}`);

// ==================== MULTER CONFIG ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
    files: 5
  }
});

// ==================== MIME TYPES MAPPING ====================
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

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

function getFileExtension(fileType) {
  return mimeTypeMapping[fileType] || '.bin';
}

function getFileTypeText(messageType) {
  const types = {
    'image': 'Изображение',
    'video': 'Видео',
    'audio': 'Аудио',
    'file': 'Файл'
  };
  return types[messageType] || 'Файл';
}

// ==================== MIDDLEWARE ПРОВЕРКИ ТОКЕНА ====================
async function verifyToken(req, res, next) {
  if (!firebaseInitialized) {
    return res.status(503).json({ error: "Сервис временно недоступен" });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

  if (!token) {
    logger.warn("🚫 verifyToken: отсутствует заголовок Authorization");
    return res.status(401).json({ error: "Токен не предоставлен" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    logger.debug(`✅ verifyToken: токен валиден, uid: ${decoded.uid}`);
    next();
  } catch (err) {
    logger.error("❌ verifyToken: токен недействителен или истёк", err);
    res.status(403).json({ error: "Неверный или просроченный токен" });
  }
}

// ==================== S3 УТИЛИТЫ ====================
async function uploadToS3(buffer, fileName, contentType) {
  try {
    logger.debug(`📤 Загрузка файла в S3: ${fileName}`);

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read'
    }));

    const fileUrl = `https://${BUCKET_NAME}.storage.yandexcloud.net/${fileName}`;
    logger.debug(`✅ Файл загружен: ${fileUrl}`);

    return fileUrl;
  } catch (error) {
    logger.error(`❌ Ошибка загрузки в S3: ${fileName}`, error);
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
      logger.warn("⚠️ Нет валидных URL для удаления");
      return;
    }

    logger.debug(`🗑️ Удаление файлов из S3: ${keys.length} файлов`);

    await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET_NAME,
      Delete: { Objects: keys }
    }));

    logger.debug(`✅ Файлы удалены из S3`);
  } catch (error) {
    logger.error("❌ Ошибка удаления из S3:", error);
    throw new Error(`Ошибка удаления файлов: ${error.message}`);
  }
}

// ==================== CHAT ACCESS CHECK ====================
async function checkChatAccess(userId, chatId, isPrivate) {
  try {
    logger.debug(`🔐 Проверка доступа: ${userId}, ${chatId}, ${isPrivate}`);

    if (isPrivate) {
      const parts = chatId.split('_');
      const hasAccess = parts.includes(userId);
      logger.debug(`🔒 Приватный чат доступ: ${hasAccess}`);
      return hasAccess;
    } else {
      const groupRef = db.ref(`chats/groups/${chatId}`);
      const groupSnap = await groupRef.once('value');
      const exists = groupSnap.exists();
      logger.debug(`👥 Групповой чат доступ: ${exists}`);
      return exists;
    }
  } catch (error) {
    logger.error('❌ Ошибка проверки доступа к чату:', error);
    return false;
  }
}

async function isPrivateChatId(chatId) {
  try {
    if (chatId.includes('_')) {
      logger.debug("🔍 ChatId содержит '_' - проверяем приватный чат");

      const privateChatRef = db.ref(`chats/private/${chatId}`);
      const privateSnap = await privateChatRef.once('value');

      if (privateSnap.exists()) {
        logger.debug("✅ Найден приватный чат с ID:", chatId);
        return true;
      }

      const groupChatRef = db.ref(`chats/groups/${chatId}`);
      const groupSnap = await groupChatRef.once('value');

      if (groupSnap.exists()) {
        logger.debug("✅ Найден групповой чат с ID (содержит '_'):", chatId);
        return false;
      }

      logger.debug("⚠️ Чат не найден, но ID содержит '_' - считаем приватным");
      return true;
    }

    const groupChatRef = db.ref(`chats/groups/${chatId}`);
    const groupSnap = await groupChatRef.once('value');

    if (groupSnap.exists()) {
      logger.debug("✅ Найден групповой чат с ID:", chatId);
      return false;
    }

    logger.debug("❌ Чат не найден ни в приватных, ни в групповых:", chatId);
    return false;

  } catch (error) {
    logger.error("❌ Ошибка определения типа чата:", error);
    return chatId.includes('_');
  }
}

// ==================== FCM TOKEN MANAGEMENT ====================
async function removeInvalidToken(invalidToken) {
  try {
    logger.debug("🗑️ Удаление невалидного FCM токена");

    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};

    for (const [userId, user] of Object.entries(users)) {
      if (user.fcmToken === invalidToken) {
        await db.ref(`users/${userId}`).update({ fcmToken: null });
        logger.debug("✅ Токен удален у пользователя:", userId);
        return { success: true, userId };
      }
    }

    logger.debug("⚠️ Токен не найден в базе пользователей");
    return { success: false, message: "Токен не найден" };

  } catch (err) {
    logger.error("❌ Ошибка удаления токена:", err);
    return { success: false, error: err.message };
  }
}

// ==================== GROUP UTILITIES ====================
async function getGroupName(groupId) {
  try {
    const groupSnap = await db.ref(`groups/${groupId}/name`).once('value');
    const groupName = groupSnap.val() || `Группа ${groupId}`;
    logger.debug("🏷️ Название группы:", groupName);
    return groupName;
  } catch (error) {
    logger.error("❌ Ошибка получения названия группы:", error);
    return `Группа ${groupId}`;
  }
}

async function findParentsByGroupId(groupId) {
  try {
    logger.debug("🔍 Поиск родителей для группы:", groupId);

    const groupSnap = await db.ref(`groups/${groupId}/children`).once('value');
    const childrenInGroup = groupSnap.val() || {};
    const childIds = Object.keys(childrenInGroup);

    logger.debug("👶 Дети в группе:", childIds.length);

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
                logger.debug(`✅ Родитель найден: ${user.name} -> ${parentChildData.fullName}`);
                break;
              }
            }
          }
        }
      }
    }

    logger.debug(`👨‍👩‍👧‍👦 Найдено родителей: ${parents.length}`);
    return parents;

  } catch (error) {
    logger.error("❌ Ошибка поиска родителей:", error);
    return [];
  }
}

// ==================== NOTIFICATION FUNCTIONS ====================
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
    logger.debug("🔔 Отправка уведомления для чата:", chatId);

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
      const groupSnap = await db.ref(`groups/${chatId}`).once('value');
      const group = groupSnap.val();

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

    logger.debug(`📨 Найдено получателей: ${recipients.length}`);

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
        logger.debug(`✅ Уведомление отправлено для ${recipient.name}`);
      } catch (tokenError) {
        logger.error(`❌ Ошибка отправки для ${recipient.name}:`, tokenError.message);

        if (tokenError.code === "messaging/registration-token-not-registered") {
          await removeInvalidToken(recipient.fcmToken);
        }
      }
    }

    logger.debug(`🎉 Уведомления отправлены: ${successful}/${recipients.length}`);
    return { successful, total: recipients.length };

  } catch (error) {
    logger.error("❌ Ошибка в sendChatNotification:", error);
    return { successful: 0, total: 0 };
  }
}

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
    logger.debug(`📱 Отправка FCM уведомлений для ${parentsWithTokens.length} родителей с токенами`);

    let successful = 0;
    let failed = 0;
    const errors = [];

    for (const parent of parentsWithTokens) {
      try {
        logger.debug(`➡️ Отправка уведомления для ${parent.name}`);

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

        const response = await admin.messaging().send(messagePayload);
        successful++;
        logger.debug("✅ Пуш отправлен для", parent.name);

      } catch (tokenError) {
        failed++;
        logger.error("❌ Ошибка отправки для", parent.name, tokenError.message);

        errors.push({
          parent: parent.name,
          error: tokenError.message,
          code: tokenError.code
        });

        if (tokenError.code === "messaging/registration-token-not-registered") {
          const removeResult = await removeInvalidToken(parent.fcmToken);
          logger.debug(`🗑️ Результат удаления токена:`, removeResult);
        }
      }
    }

    logger.debug(`🎉 Уведомления отправлены: Успешно ${successful}, Неудачно ${failed}`);
    return { successful, failed, totalTokens: parentsWithTokens.length, errors };

  } catch (err) {
    logger.error("❌ Ошибка в sendEventNotifications:", err);
    return { successful: 0, failed: parents.length, errors: [err.message] };
  }
}

// ==================== ROUTES ====================

// ==================== HEALTH & MONITORING ====================
app.get('/health', (req, res) => {
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: NODE_ENV,
    firebase: firebaseInitialized ? 'connected' : 'disconnected',
    s3: BUCKET_NAME ? 'configured' : 'missing',
    version: '2.0.0'
  };

  res.set('Cache-Control', 'no-cache');
  res.json(health);
});

app.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.send('pong');
});

app.get('/metrics', (req, res) => {
  const metrics = {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    firebase: firebaseInitialized,
    activeHandles: process._getActiveHandles().length,
    activeRequests: process._getActiveRequests().length
  };

  res.json(metrics);
});

// ==================== USER MANAGEMENT ====================
app.post('/deleteUserByName', async (req, res) => {
  try {
    const fullName = req.body.fullName?.trim().toLowerCase();
    if (!fullName) {
      return res.status(400).json({ error: "fullName обязателен" });
    }

    logger.debug(`🗑️ Запрос на удаление пользователя: ${fullName}`);

    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};
    let found = false;

    for (const [userId, user] of Object.entries(users)) {
      const name = user.name?.trim().toLowerCase();
      const role = user.role?.trim().toLowerCase();

      // Родитель
      if (name === fullName && role === 'родитель') {
        found = true;
        logger.debug(`👨‍👩‍👧‍👦 Найден родитель для удаления: ${userId}`);

        if (user.children) {
          const filesToDelete = [];

          for (const [childId, child] of Object.entries(user.children)) {
            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
              logger.debug(`✅ Ребенок удален из группы: ${child.group}`);
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
          logger.debug(`✅ Пользователь удален из Auth: ${userId}`);
        } catch (authError) {
          logger.debug("ℹ️ Пользователь не найден в Auth, пропускаем:", authError.message);
        }

        return res.json({ success: true, message: "Родитель и его дети удалены." });
      }

      // Педагог
      if (name === fullName && role === 'педагог') {
        found = true;
        logger.debug(`👨‍🏫 Найден педагог для удаления: ${userId}`);

        const groupsSnap = await db.ref('groups').once('value');
        const groups = groupsSnap.val() || {};

        for (const [groupId, group] of Object.entries(groups)) {
          if (group.teachers?.[userId]) {
            await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
            logger.debug(`✅ Педагог удален из группы: ${groupId}`);
          }
        }

        await db.ref(`users/${userId}`).remove();

        try {
          await auth.getUser(userId);
          await auth.deleteUser(userId);
          logger.debug(`✅ Педагог удален из Auth: ${userId}`);
        } catch (authError) {
          logger.debug("ℹ️ Педагог не найден в Auth:", authError.message);
        }

        return res.json({ success: true, message: "Педагог удалён." });
      }

      // Отдельный ребенок
      if (user.children) {
        for (const [childId, child] of Object.entries(user.children)) {
          if (child.fullName?.trim().toLowerCase() === fullName) {
            found = true;
            logger.debug(`👶 Найден ребенок для удаления: ${childId}`);

            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
              logger.debug(`✅ Ребенок удален из группы: ${child.group}`);
            }

            const filesToDelete = [];
            if (child.avatarUrl) filesToDelete.push(child.avatarUrl);
            if (filesToDelete.length > 0) {
              await deleteFromS3(filesToDelete);
            }

            await db.ref(`users/${userId}/children/${childId}`).remove();

            return res.json({ success: true, message: "Ребёнок удалён." });
          }
        }
      }
    }

    if (!found) {
      logger.debug("❌ Пользователь не найден:", fullName);
      return res.status(404).json({ error: "Пользователь не найден." });
    }
  } catch (err) {
    logger.error("❌ Ошибка при deleteUserByName:", err);
    res.status(500).json({ error: "Ошибка при удалении: " + err.message });
  }
});

app.post('/deleteChild', async (req, res) => {
  try {
    const { userId, childId } = req.body;

    if (!userId || !childId) {
      return res.status(400).json({ error: "userId и childId обязательны" });
    }

    logger.debug('🗑️ Запрос на удаление ребенка:', { userId, childId });

    const childRef = db.ref(`users/${userId}/children/${childId}`);
    const childSnap = await childRef.once('value');

    if (!childSnap.exists()) {
      return res.status(404).json({ error: "Ребенок не найден" });
    }

    const child = childSnap.val();
    const groupName = child.group;
    const childName = child.fullName.trim();

    logger.debug('👶 Удаление ребенка:', childName, 'Группа:', groupName);

    let groupId = null;
    if (groupName) {
      logger.debug('🔍 Ищем ID группы по названию:', groupName);

      const groupsRef = db.ref('groups');
      const groupsSnap = await groupsRef.once('value');
      const groups = groupsSnap.val() || {};

      for (const [id, groupData] of Object.entries(groups)) {
        if (groupData.name === groupName) {
          groupId = id;
          logger.debug('✅ Найдена группа ID:', groupId);
          break;
        }
      }

      if (!groupId) {
        logger.debug('❌ Группа не найдена по названию:', groupName);
        return res.status(404).json({ error: "Группа не найдена" });
      }
    }

    if (groupId) {
      const groupChildrenRef = db.ref(`groups/${groupId}/children`);
      const groupChildrenSnap = await groupChildrenRef.once('value');
      const groupChildren = groupChildrenSnap.val() || {};

      let foundGroupChildId = null;
      for (const [groupChildId, groupChildName] of Object.entries(groupChildren)) {
        if (groupChildName.trim() === childName) {
          foundGroupChildId = groupChildId;
          break;
        }
      }

      if (foundGroupChildId) {
        logger.debug('🗑️ Удаляем ребенка из группы');
        await groupChildrenRef.child(foundGroupChildId).remove();
        logger.debug('✅ Ребенок удален из группы');
      } else {
        logger.debug('❌ Ребенок не найден в группе');
        return res.status(404).json({ error: "Ребенок не найден в группе" });
      }
    }

    const filesToDelete = [];
    if (child.avatarUrl) {
      filesToDelete.push(child.avatarUrl);
    }

    if (filesToDelete.length > 0) {
      await deleteFromS3(filesToDelete);
    }

    logger.debug('🗑️ Удаляем ребенка из базы пользователя');
    await childRef.remove();

    logger.debug('✅ Ребенок полностью удален');

    res.json({
      success: true,
      message: `Ребенок ${childName} успешно удален`
    });

  } catch (err) {
    logger.error('❌ Ошибка при deleteChild:', err);
    res.status(500).json({ error: "Ошибка при удалении ребенка: " + err.message });
  }
});

app.post("/update-user", async (req, res) => {
  try {
    const { fullName, newEmail } = req.body;
    if (!fullName || !newEmail) {
      return res.status(400).json({ error: "fullName и newEmail обязательны" });
    }

    logger.debug(`✏️ Запрос на обновление email: ${fullName} -> ${newEmail}`);

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

    logger.debug(`✅ Email обновлен для пользователя: ${userId}`);

    res.json({
      success: true,
      message: "Email обновлен",
      userId,
      updatedUser: { name: fullName, email: newEmail }
    });
  } catch (err) {
    logger.error("❌ Ошибка update-user:", err);

    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: "Email уже используется" });
    }

    res.status(500).json({ error: "Ошибка сервера: " + err.message });
  }
});

// ==================== NEWS MANAGEMENT ====================
app.post("/news", verifyToken, async (req, res) => {
  try {
    const { newsId, groupId, title, description, mediaUrls = [] } = req.body;
    const authorId = req.user.uid;

    if (!groupId || !title || !description) {
      return res.status(400).json({ error: "groupId, title и description обязательны" });
    }

    logger.debug(`📰 ${newsId ? 'Редактирование' : 'Создание'} новости для группы: ${groupId}`);

    if (newsId) {
      const ref = db.ref(`news/${groupId}/${newsId}`);
      const snap = await ref.once("value");
      const oldNews = snap.val();
      if (!oldNews) {
        return res.status(404).json({ error: "Новость не найдена" });
      }

      if (oldNews.authorId !== authorId) {
        return res.status(403).json({ error: "Нет прав на редактирование" });
      }

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
      logger.debug(`✅ Новость отредактирована: ${newsId}`);

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
    logger.debug(`✅ Новость создана: ${id}`);

    return res.json({ success: true, id });

  } catch (err) {
    logger.error("Ошибка POST /news:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/news", verifyToken, async (req, res) => {
  try {
    const groupId = req.query.groupId;
    if (!groupId) {
      return res.status(400).json({ error: "groupId обязателен" });
    }

    logger.debug(`📖 Получение новостей для группы: ${groupId}`);

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

    logger.debug(`✅ Получено новостей: ${newsList.length}`);

    res.json(newsList);
  } catch (err) {
    logger.error("Ошибка GET /news:", err);
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

    logger.debug(`🗑️ Удаление новости: ${newsId} из группы: ${groupId}`);

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

    logger.debug(`✅ Новость удалена: ${newsId}`);

    res.json({ success: true });
  } catch (err) {
    logger.error("Ошибка deleteNews:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FILE UPLOAD ====================
app.post('/generate-upload-url', verifyToken, async (req, res) => {
  logger.debug('=== /generate-upload-url: запрос получен');

  try {
    const { fileName, fileType, groupId, isPrivateChat, context } = req.body;

    if (!fileName || !fileType) {
      logger.debug('Ошибка: отсутствуют обязательные поля fileName или fileType');
      return res.status(400).json({ error: "fileName и fileType обязательны" });
    }

    const fileExtension = getFileExtension(fileType);
    let finalFileName = fileName;

    if (!finalFileName.includes('.') || !finalFileName.toLowerCase().endsWith(fileExtension.toLowerCase())) {
      const baseName = finalFileName.includes('.')
        ? finalFileName.substring(0, finalFileName.lastIndexOf('.'))
        : finalFileName;

      finalFileName = baseName + fileExtension;
      logger.debug('Скорректированное имя файла:', finalFileName);
    }

    let folder;
    let finalGroupId = groupId;

    if (context === 'news') {
      folder = 'news/';
      logger.debug('Тип: новость');
    } else if (isPrivateChat === true) {
      folder = 'private-chats/';
      logger.debug('Тип: приватный чат (по флагу isPrivateChat)');
    } else if (groupId && groupId.startsWith('private_')) {
      folder = 'private-chats/';
      finalGroupId = groupId.replace('private_', '');
      logger.debug('Тип: приватный чат (legacy format)');
    } else if (groupId) {
      folder = 'group-chats/';
      logger.debug('Тип: групповой чат');
    } else {
      folder = 'misc/';
      logger.debug('Тип: прочее (без контекста)');
    }

    if (finalGroupId && folder !== 'news/') {
      const hasAccess = await checkChatAccess(req.user.uid, finalGroupId, folder === 'private-chats/');
      if (!hasAccess) {
        logger.debug('Ошибка: пользователь', req.user.uid, 'не имеет доступа к чату', finalGroupId);
        return res.status(403).json({ error: "Нет доступа к этому чату" });
      }
      logger.debug('Доступ к чату подтвержден для пользователя');
    }

    const timestamp = Date.now();
    const uniqueId = uuidv4().substring(0, 8);
    const safeFileName = finalFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `${folder}${finalGroupId ? finalGroupId + '/' : ''}${timestamp}_${uniqueId}_${safeFileName}`;

    logger.debug('Финальный ключ для файла:', key);

    const signedUrlParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: String(fileType),
      ACL: "public-read"
    };

    const command = new PutObjectCommand(signedUrlParams);
    logger.debug('Генерация signed URL...');

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    const fileUrl = `https://${BUCKET_NAME}.storage.yandexcloud.net/${key}`;

    logger.debug('✅ Signed URL успешно сгенерирован');
    logger.debug('📁 File URL:', fileUrl);

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
    logger.error("❌ Ошибка генерации upload URL:", err);

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

// ==================== CHAT & MESSAGING ====================
app.post("/send-message", verifyToken, async (req, res) => {
  try {
    const { chatId, message, messageType = "text", fileUrl, fileName } = req.body;
    const senderId = req.user.uid;
    logger.debug("📨 Новое сообщение:", { senderId, chatId, messageType });

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
    logger.debug("🔍 Тип чата:", isPrivateChat ? "PRIVATE" : "GROUP");

    let chatRef;
    if (isPrivateChat) {
      chatRef = db.ref(`chats/private/${chatId}/messages/${messageId}`);
      logger.debug("📁 Путь: chats/private/");
    } else {
      chatRef = db.ref(`chats/groups/${chatId}/messages/${messageId}`);
      logger.debug("📁 Путь: chats/groups/");
    }

    await chatRef.set(messageData);
    logger.debug("✅ Сообщение сохранено в Firebase");

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

    logger.debug("✅ Уведомления отправлены");

    res.json({
      success: true,
      messageId,
      timestamp: messageData.timestamp
    });

  } catch (err) {
    logger.error("❌ Ошибка отправки сообщения:", err);
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

    logger.debug("💾 Сохранение FCM токена для пользователя:", userId);

    await db.ref(`users/${userId}`).update({
      fcmToken,
      fcmTokenUpdated: Date.now()
    });

    logger.debug("✅ FCM токен сохранен");
    res.json({ success: true });

  } catch (err) {
    logger.error("❌ Ошибка сохранения FCM токена:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== EVENT NOTIFICATIONS ====================
app.post("/send-event-notification", verifyToken, async (req, res) => {
  logger.debug("🟢 Запрос на отправку уведомления о событии");

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
      logger.debug("❌ Недостаточно данных для отправки уведомления");
      return res.status(400).json({
        error: "groupId, eventId, title обязательны"
      });
    }
    logger.debug("🔔 Данные события:", { groupId, title, time, date });

    const actualGroupName = await getGroupName(groupId);
    logger.debug("Название группы: ", actualGroupName);

    const parents = await findParentsByGroupId(groupId);

    if (parents.length === 0) {
      logger.debug("⚠️ Не найдены родители для группы:", groupId);
      return res.json({
        success: true,
        message: "Событие создано, но родители не найдены"
      });
    }

    logger.debug("👨‍👩‍👧‍👦 Найдены родители:", parents.length);
    parents.forEach((parent, index) => {
      logger.debug(`   ${index + 1}. ${parent.name} (ребенок: ${parent.childName})`);
    });

    const parentsWithTokens = parents.filter(parent => parent.fcmToken && parent.fcmToken.trim() !== "");
    logger.debug(`📱 Активные токены: ${parentsWithTokens.length} из ${parents.length}`);

    const notificationBody = formatEventNotification(title, time, place, actualGroupName);
    logger.debug("📝 Текст уведомления:", notificationBody);

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

    logger.debug(`🎉 Уведомления о событии отправлены для ${sendResults.successful} родителей`);

    res.json({
      success: true,
      message: `Уведомления отправлены ${sendResults.successful} родителям`,
      recipients: sendResults.successful,
      totalParents: parents.length,
      parentsWithTokens: sendResults.successful,
      statistics: sendResults
    });

  } catch (err) {
    logger.error("❌ Ошибка отправки уведомления о событии:", err);
    res.status(500).json({
      error: "Внутренняя ошибка сервера: " + err.message
    });
  }
});

// ==================== INFO & ROOT ====================
app.get("/info", (req, res) => {
  logger.debug("ℹ️ Запрос информации о сервере");
  res.json({
    service: "Firebase Admin Notification Server",
    version: "2.0.0",
    environment: NODE_ENV,
    firebase: firebaseInitialized ? "connected" : "disconnected",
    endpoints: {
      "GET /health": "Проверка работоспособности с метриками",
      "GET /ping": "Быстрая проверка доступности",
      "GET /metrics": "Метрики производительности",
      "POST /send-event-notification": "Отправка уведомлений о новых событиях",
      "POST /send-message": "Отправка сообщений в чат",
      "POST /generate-upload-url": "Генерация URL для загрузки файлов",
      "GET /news": "Получение новостей",
      "POST /news": "Создание/редактирование новостей",
      "POST /deleteUserByName": "Удаление пользователя по имени",
      "GET /info": "Информация о сервере"
    },
    features: [
      "FCM уведомления о событиях",
      "Чат с файлами",
      "Загрузка файлов в S3",
      "Управление новостями",
      "Автоматическое удаление невалидных токенов",
      "Оптимизировано для Render.com"
    ]
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Firebase Admin Server is running",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    docs: "/info"
  });
});

// ==================== ERROR HANDLING ====================
app.use((req, res) => {
  logger.warn(`❌ Маршрут не найден: ${req.method} ${req.path}`);
  res.status(404).json({
    error: "Маршрут не найден",
    path: req.path,
    method: req.method
  });
});

app.use((err, req, res, next) => {
  logger.error("💥 Непредвиденная ошибка:", err);
  res.status(500).json({
    error: "Внутренняя ошибка сервера",
    message: NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ==================== SERVER WARMUP ====================
async function warmUpServer() {
  try {
    logger.info('🔥 Прогрев сервера...');

    // Проверяем подключения
    await db.ref('.info/connected').once('value');
    await s3.send(new ListBucketsCommand({}));

    logger.info('✅ Сервер прогрет');
  } catch (error) {
    logger.warn('⚠️ Прогрев завершен с предупреждениями:', error.message);
  }
}

// ==================== GLOBAL ERROR HANDLERS ====================
process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// ==================== SERVER START ====================
app.listen(PORT, async () => {
  logger.info(`🚀 Server started on port ${PORT}`);
  logger.info(`📊 Environment: ${NODE_ENV}`);
  logger.info(`🔧 Firebase: ${firebaseInitialized ? '✅' : '❌'}`);
  logger.info(`🌐 S3 Bucket: ${BUCKET_NAME}`);
  logger.info(`⏰ Started at: ${new Date().toISOString()}`);

  // Неблокирующий прогрев
  setTimeout(warmUpServer, 2000);
});