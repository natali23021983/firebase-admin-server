require('dotenv').config();
const express = require('express');
const cors = require("cors");
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');

// ==================== КОНФИГУРАЦИЯ ЛОГГЕРА ====================
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

// ==================== КОНФИГУРАЦИЯ СЕРВЕРА ====================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

logger.info('🚀 Запуск сервера на Render.com...');

const app = express();

// ==================== ОПТИМИЗАЦИЯ ДЛЯ RENDER ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());

// ==================== ИНИЦИАЛИЗАЦИЯ FIREBASE ====================
let firebaseInitialized = false;
let db = null;
let auth = null;

async function initializeFirebase() {
    try {
        logger.info('🔥 Инициализация Firebase...');

        const base64 = process.env.FIREBASE_CONFIG;
        if (!base64) {
            throw new Error("FIREBASE_CONFIG не найден");
        }

        const serviceAccount = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));

        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.FIREBASE_DB_URL
            });
        }

        db = admin.database();
        auth = admin.auth();
        firebaseInitialized = true;

        logger.info('✅ Firebase успешно инициализирован');
        return true;
    } catch (error) {
        logger.error('❌ Ошибка инициализации Firebase: %s', error.message);
        return false;
    }
}

// ==================== MIDDLEWARE ПРОВЕРКИ ТОКЕНА ====================
async function verifyToken(req, res, next) {
    if (!firebaseInitialized) {
        return res.status(503).json({ error: "Сервис инициализируется, попробуйте снова" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

    if (!token) {
        logger.warn('🚫 Отсутствует заголовок Authorization');
        return res.status(401).json({ error: "Токен не предоставлен" });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        logger.debug('✅ Токен валиден, uid: %s', decoded.uid);
        next();
    } catch (err) {
        logger.error('❌ Токен недействителен или истёк: %s', err.message);
        res.status(403).json({ error: "Неверный или просроченный токен" });
    }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ УВЕДОМЛЕНИЙ ====================

// Удаление невалидного FCM токена
async function removeInvalidToken(invalidToken) {
    try {
        logger.debug('🗑️ Удаление невалидного FCM токена');

        const usersSnap = await db.ref('users').once('value');
        const users = usersSnap.val() || {};

        for (const [userId, user] of Object.entries(users)) {
            if (user.fcmToken === invalidToken) {
                await db.ref(`users/${userId}`).update({ fcmToken: null });
                logger.debug('✅ Токен удален у пользователя: %s', userId);
                return { success: true, userId };
            }
        }

        logger.warn('⚠️ Токен не найден в базе пользователей');
        return { success: false, message: "Токен не найден" };

    } catch (err) {
        logger.error('❌ Ошибка удаления токена: %s', err.message);
        return { success: false, error: err.message };
    }
}

// Получение названия группы
async function getGroupName(groupId) {
    try {
        const groupSnap = await db.ref(`groups/${groupId}/name`).once('value');
        const groupName = groupSnap.val() || `Группа ${groupId}`;
        logger.debug('🏷️ Название группы: %s', groupName);
        return groupName;
    } catch (error) {
        logger.error('❌ Ошибка получения названия группы: %s', error.message);
        return `Группа ${groupId}`;
    }
}

// Поиск родителей по ID группы
async function findParentsByGroupId(groupId) {
    try {
        logger.debug('🔍 Поиск родителей для группы: %s', groupId);

        const groupSnap = await db.ref(`groups/${groupId}/children`).once('value');
        const childrenInGroup = groupSnap.val() || {};
        const childIds = Object.keys(childrenInGroup);

        logger.debug('👶 Дети в группе: %d', childIds.length);

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
                                logger.debug('✅ Родитель найден: %s -> %s', user.name, parentChildData.fullName);
                                break;
                            }
                        }
                    }
                }
            }
        }

        logger.debug('👨‍👩‍👧‍👦 Найдено родителей: %d', parents.length);
        return parents;

    } catch (error) {
        logger.error('❌ Ошибка поиска родителей: %s', error.message);
        return [];
    }
}

// Функция отправки уведомлений о новых сообщениях
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
        logger.debug('🔔 Отправка уведомления для чата: %s', chatId);

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

        logger.debug('📨 Найдено получателей: %d', recipients.length);

        function getFileTypeText(messageType) {
            switch (messageType) {
                case 'image': return 'Изображение';
                case 'video': return 'Видео';
                case 'audio': return 'Аудио';
                case 'file': return 'Файл';
                default: return 'Файл';
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
                logger.debug('✅ Уведомление отправлено для %s', recipient.name);
            } catch (tokenError) {
                logger.error('❌ Ошибка отправки для %s: %s', recipient.name, tokenError.message);

                if (tokenError.code === "messaging/registration-token-not-registered") {
                    await removeInvalidToken(recipient.fcmToken);
                }
            }
        }

        logger.debug('🎉 Уведомления отправлены: %d/%d', successful, recipients.length);
        return { successful, total: recipients.length };

    } catch (error) {
        logger.error('❌ Ошибка в sendChatNotification: %s', error.message);
        return { successful: 0, total: 0 };
    }
}

// Форматирование текста уведомления
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

// Отправка FCM уведомлений о событии
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
        logger.debug('📱 Отправка FCM уведомлений для %d родителей с токенами', parentsWithTokens.length);

        let successful = 0;
        let failed = 0;
        const errors = [];

        for (const parent of parentsWithTokens) {
            try {
                logger.debug('➡️ Отправка уведомления для %s', parent.name);

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
                logger.debug('✅ Пуш отправлен для %s', parent.name);

            } catch (tokenError) {
                failed++;
                logger.error('❌ Ошибка отправки для %s: %s', parent.name, tokenError.message);

                errors.push({
                    parent: parent.name,
                    error: tokenError.message,
                    code: tokenError.code
                });

                if (tokenError.code === "messaging/registration-token-not-registered") {
                    const removeResult = await removeInvalidToken(parent.fcmToken);
                    logger.debug('🗑️ Результат удаления токена: %j', removeResult);
                }
            }
        }

        logger.debug('🎉 Уведомления отправлены: Успешно %d, Неудачно %d', successful, failed);
        return { successful, failed, totalTokens: parentsWithTokens.length, errors };

    } catch (err) {
        logger.error('❌ Ошибка в sendEventNotifications: %s', err.message);
        return { successful: 0, failed: parents.length, errors: [err.message] };
    }
}

// ==================== HEALTH ENDPOINTS ====================
app.get('/health', (req, res) => {
    logger.debug('Health check выполнен');
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        firebase: firebaseInitialized,
        environment: NODE_ENV
    });
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

app.get('/', (req, res) => {
    res.json({
        message: 'Firebase Admin Server работает',
        status: 'active',
        firebase: firebaseInitialized ? 'connected' : 'connecting'
    });
});

// ==================== ОСНОВНЫЕ ENDPOINTS ====================

// Удаление пользователя по имени
app.post('/deleteUserByName', async (req, res) => {
    if (!firebaseInitialized) {
        return res.status(503).json({ error: "Сервис инициализируется" });
    }

    try {
        const fullName = req.body.fullName?.trim().toLowerCase();
        if (!fullName) {
            return res.status(400).json({ error: "fullName обязателен" });
        }

        logger.info('🗑️ Запрос на удаление пользователя: %s', fullName);

        const usersSnap = await db.ref('users').once('value');
        const users = usersSnap.val() || {};
        let found = false;

        for (const [userId, user] of Object.entries(users)) {
            const name = user.name?.trim().toLowerCase();
            const role = user.role?.trim().toLowerCase();

            if (name === fullName && role === 'родитель') {
                found = true;
                logger.info('👨‍👩‍👧‍👦 Найден родитель для удаления: %s', userId);

                if (user.children) {
                    for (const [childId, child] of Object.entries(user.children)) {
                        if (child.group) {
                            await db.ref(`groups/${child.group}/children/${childId}`).remove();
                            logger.debug('✅ Ребенок удален из группы: %s', child.group);
                        }
                    }
                }

                await db.ref(`users/${userId}`).remove();

                try {
                    await auth.deleteUser(userId);
                    logger.info('✅ Пользователь удален из Auth: %s', userId);
                } catch (authError) {
                    logger.debug('ℹ️ Пользователь не найден в Auth, пропускаем');
                }

                return res.json({ success: true, message: "Родитель и его дети удалены." });
            }

            if (name === fullName && role === 'педагог') {
                found = true;
                logger.info('👨‍🏫 Найден педагог для удаления: %s', userId);

                const groupsSnap = await db.ref('groups').once('value');
                const groups = groupsSnap.val() || {};

                for (const [groupId, group] of Object.entries(groups)) {
                    if (group.teachers?.[userId]) {
                        await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
                        logger.debug('✅ Педагог удален из группы: %s', groupId);
                    }
                }

                await db.ref(`users/${userId}`).remove();

                try {
                    await auth.deleteUser(userId);
                    logger.info('✅ Педагог удален из Auth: %s', userId);
                } catch (authError) {
                    logger.debug('ℹ️ Педагог не найден в Auth');
                }

                return res.json({ success: true, message: "Педагог удалён." });
            }

            if (user.children) {
                for (const [childId, child] of Object.entries(user.children)) {
                    if (child.fullName?.trim().toLowerCase() === fullName) {
                        found = true;
                        logger.info('👶 Найден ребенок для удаления: %s', childId);

                        if (child.group) {
                            await db.ref(`groups/${child.group}/children/${childId}`).remove();
                            logger.debug('✅ Ребенок удален из группы: %s', child.group);
                        }

                        await db.ref(`users/${userId}/children/${childId}`).remove();

                        return res.json({ success: true, message: "Ребёнок удалён." });
                    }
                }
            }
        }

        if (!found) {
            logger.warn('❌ Пользователь не найден: %s', fullName);
            return res.status(404).json({ error: "Пользователь не найден." });
        }
    } catch (err) {
        logger.error('❌ Ошибка при deleteUserByName: %s', err.message);
        res.status(500).json({ error: "Ошибка при удалении: " + err.message });
    }
});

// Удаление ребенка
app.post('/deleteChild', async (req, res) => {
    try {
        const { userId, childId } = req.body;

        if (!userId || !childId) {
            return res.status(400).json({ error: "userId и childId обязательны" });
        }

        logger.info('🗑️ Запрос на удаление ребенка: %s, %s', userId, childId);

        const childRef = db.ref(`users/${userId}/children/${childId}`);
        const childSnap = await childRef.once('value');

        if (!childSnap.exists()) {
            return res.status(404).json({ error: "Ребенок не найден" });
        }

        const child = childSnap.val();
        const groupName = child.group;
        const childName = child.fullName.trim();

        logger.info('👶 Удаление ребенка: %s, Группа: %s', childName, groupName);

        let groupId = null;
        if (groupName) {
            logger.debug('🔍 Ищем ID группы по названию: %s', groupName);

            const groupsRef = db.ref('groups');
            const groupsSnap = await groupsRef.once('value');
            const groups = groupsSnap.val() || {};

            for (const [id, groupData] of Object.entries(groups)) {
                if (groupData.name === groupName) {
                    groupId = id;
                    logger.debug('✅ Найдена группа ID: %s', groupId);
                    break;
                }
            }

            if (!groupId) {
                logger.warn('❌ Группа не найдена по названию: %s', groupName);
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
                logger.warn('❌ Ребенок не найден в группе');
                return res.status(404).json({ error: "Ребенок не найден в группе" });
            }
        }

        logger.debug('🗑️ Удаляем ребенка из базы пользователя');
        await childRef.remove();

        logger.info('✅ Ребенок полностью удален');

        res.json({
            success: true,
            message: `Ребенок ${childName} успешно удален`
        });

    } catch (err) {
        logger.error('❌ Ошибка при deleteChild: %s', err.message);
        res.status(500).json({ error: "Ошибка при удалении ребенка: " + err.message });
    }
});

// Обновление email пользователя
app.post("/update-user", async (req, res) => {
    try {
        const { fullName, newEmail } = req.body;
        if (!fullName || !newEmail) {
            return res.status(400).json({ error: "fullName и newEmail обязательны" });
        }

        logger.info('✏️ Запрос на обновление email: %s -> %s', fullName, newEmail);

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

        logger.info('✅ Email обновлен для пользователя: %s', userId);

        res.json({
            success: true,
            message: "Email обновлен",
            userId,
            updatedUser: { name: fullName, email: newEmail }
        });
    } catch (err) {
        logger.error('❌ Ошибка update-user: %s', err.message);

        if (err.code === 'auth/email-already-exists') {
            return res.status(400).json({ error: "Email уже используется" });
        }

        res.status(500).json({ error: "Ошибка сервера: " + err.message });
    }
});

// Работа с новостями
app.post("/news", verifyToken, async (req, res) => {
    try {
        const { newsId, groupId, title, description, mediaUrls = [] } = req.body;
        const authorId = req.user.uid;

        if (!groupId || !title || !description) {
            return res.status(400).json({ error: "groupId, title и description обязательны" });
        }

        logger.info('📰 %s новости для группы: %s', newsId ? 'Редактирование' : 'Создание', groupId);

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

            const newData = {
                title,
                description,
                mediaUrls,
                authorId,
                timestamp: Date.now(),
            };

            await ref.update(newData);
            logger.info('✅ Новость отредактирована: %s', newsId);

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
        logger.info('✅ Новость создана: %s', id);

        return res.json({ success: true, id });

    } catch (err) {
        logger.error('Ошибка POST /news: %s', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Получение новостей
app.get("/news", verifyToken, async (req, res) => {
    try {
        const groupId = req.query.groupId;
        if (!groupId) {
            return res.status(400).json({ error: "groupId обязателен" });
        }

        logger.debug('📖 Получение новостей для группы: %s', groupId);

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

        logger.debug('✅ Получено новостей: %d', newsList.length);

        res.json(newsList);
    } catch (err) {
        logger.error('Ошибка GET /news: %s', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Удаление новости
app.post("/deleteNews", verifyToken, async (req, res) => {
    try {
        const { groupId, newsId } = req.body;
        const authorId = req.user.uid;

        if (!groupId || !newsId) {
            return res.status(400).json({ error: "groupId и newsId обязательны" });
        }

        logger.info('🗑️ Удаление новости: %s из группы: %s', newsId, groupId);

        const snap = await db.ref(`news/${groupId}/${newsId}`).once('value');
        const data = snap.val();

        if (!data) {
            return res.status(404).json({ error: "Новость не найдена" });
        }

        if (data.authorId !== authorId) {
            return res.status(403).json({ error: "Нет прав" });
        }

        await db.ref(`news/${groupId}/${newsId}`).remove();

        logger.info('✅ Новость удалена: %s', newsId);

        res.json({ success: true });
    } catch (err) {
        logger.error('Ошибка deleteNews: %s', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Отправка сообщения в чат
app.post("/send-message", verifyToken, async (req, res) => {
    try {
        const { chatId, message, messageType = "text", fileUrl, fileName } = req.body;
        const senderId = req.user.uid;
        logger.debug('📨 Новое сообщение: %s, %s, %s', senderId, chatId, messageType);

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

        const isPrivateChat = chatId.includes('_');
        let chatRef;

        if (isPrivateChat) {
            chatRef = db.ref(`chats/private/${chatId}/messages/${messageId}`);
        } else {
            chatRef = db.ref(`chats/groups/${chatId}/messages/${messageId}`);
        }

        await chatRef.set(messageData);
        logger.debug('✅ Сообщение сохранено в Firebase');

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

        logger.debug('✅ Уведомления отправлены');

        res.json({
            success: true,
            messageId,
            timestamp: messageData.timestamp
        });

    } catch (err) {
        logger.error('❌ Ошибка отправки сообщения: %s', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Сохранение FCM токена
app.post("/save-fcm-token", verifyToken, async (req, res) => {
    try {
        const { fcmToken } = req.body;
        const userId = req.user.uid;

        if (!fcmToken) {
            return res.status(400).json({ error: "fcmToken обязателен" });
        }

        logger.debug('💾 Сохранение FCM токена для пользователя: %s', userId);

        await db.ref(`users/${userId}`).update({
            fcmToken,
            fcmTokenUpdated: Date.now()
        });

        logger.debug('✅ FCM токен сохранен');
        res.json({ success: true });

    } catch (err) {
        logger.error('❌ Ошибка сохранения FCM токена: %s', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Отправка уведомления о событии
app.post("/send-event-notification", verifyToken, async (req, res) => {
    logger.info('🟢 Запрос на отправку уведомления о событии');

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
            logger.warn('❌ Недостаточно данных для отправки уведомления');
            return res.status(400).json({
                error: "groupId, eventId, title обязательны"
            });
        }
        logger.debug('🔔 Данные события: %j', { groupId, title, time, date });

        const actualGroupName = await getGroupName(groupId);
        logger.debug('Название группы: %s', actualGroupName);

        const parents = await findParentsByGroupId(groupId);

        if (parents.length === 0) {
            logger.warn('⚠️ Не найдены родители для группы: %s', groupId);
            return res.json({
                success: true,
                message: "Событие создано, но родители не найдены"
            });
        }

        logger.debug('👨‍👩‍👧‍👦 Найдены родители: %d', parents.length);
        parents.forEach((parent, index) => {
            logger.debug('   %d. %s (ребенок: %s)', index + 1, parent.name, parent.childName);
        });

        const parentsWithTokens = parents.filter(parent => parent.fcmToken && parent.fcmToken.trim() !== "");
        logger.debug('📱 Активные токены: %d из %d', parentsWithTokens.length, parents.length);

        const notificationBody = formatEventNotification(title, time, place, actualGroupName);
        logger.debug('📝 Текст уведомления: %s', notificationBody);

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

        logger.info('🎉 Уведомления о событии отправлены для %d родителей', sendResults.successful);

        res.json({
            success: true,
            message: `Уведомления отправлены ${sendResults.successful} родителям`,
            recipients: sendResults.successful,
            totalParents: parents.length,
            parentsWithTokens: sendResults.successful,
            statistics: sendResults
        });

    } catch (err) {
        logger.error('❌ Ошибка отправки уведомления о событии: %s', err.message);
        res.status(500).json({
            error: "Внутренняя ошибка сервера: " + err.message
        });
    }
});

// Информация о сервере
app.get("/info", (req, res) => {
    logger.debug('ℹ️ Запрос информации о сервере');
    res.json({
        service: "Firebase Admin Notification Server",
        version: "2.0.0",
        environment: NODE_ENV,
        firebase: firebaseInitialized ? "connected" : "disconnected",
        endpoints: [
            "POST /deleteUserByName",
            "POST /deleteChild",
            "POST /update-user",
            "POST /news",
            "GET /news",
            "POST /deleteNews",
            "POST /send-message",
            "POST /save-fcm-token",
            "POST /send-event-notification"
        ]
    });
});

// ==================== ОБРАБОТКА ОШИБОК ====================
app.use((req, res) => {
    logger.warn('❌ Маршрут не найден: %s %s', req.method, req.path);
    res.status(404).json({ error: "Маршрут не найден" });
});

app.use((err, req, res, next) => {
    logger.error('💥 Непредвиденная ошибка: %s', err.message);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

// ==================== ЗАПУСК СЕРВЕРА ====================
async function startServer() {
    await initializeFirebase();

    app.listen(PORT, () => {
        logger.info('🚀 Сервер запущен на порту %d', PORT);
        logger.info('📊 Окружение: %s', NODE_ENV);
        logger.info('🔧 Firebase: %s', firebaseInitialized ? '✅' : '❌');
        logger.info('⏰ Время запуска: %s', new Date().toISOString());
    });
}

startServer().catch(error => {
    logger.error('💥 Критическая ошибка запуска сервера: %s', error.message);
    process.exit(1);
});