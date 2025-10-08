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
app.use(express.json());

// Multer для загрузки в память
const upload = multer({ storage: multer.memoryStorage() });

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

// Функция для получения расширения файла по MIME type
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
            // Добавьте другие файлы ребенка если есть
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
    const groupName = child.group; // Это НАЗВАНИЕ группы!
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

    // Ищем ребенка по имени в группе
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
      mediaUrls: news.mediaUrls || [],   // 🔥 только одно поле
      timestamp: news.timestamp || 0
    }));

    newsList.sort((a, b) => b.timestamp - a.timestamp);

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

    const snap = await db.ref(`news/${groupId}/${newsId}`).once('value');
    const data = snap.val();
    if (!data) return res.status(404).json({ error: "Новость не найдена" });

    if (data.authorId !== authorId) return res.status(403).json({ error: "Нет прав" });

    const urls = data.mediaUrls || [];
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
      console.log('Доступ к чату подтвержден для пользователя:', req.user.uid);
    }

    // Генерируем уникальный ключ для файла
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
      expiresAt: Date.now() + 300000 // timestamp истечения
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
       // Для приватных чатов: проверяем участников по chatId
       const parts = chatId.split('_');
       const hasAccess = parts.includes(userId);
       console.log('Приватный чат доступ:', hasAccess, 'участники:', parts);
       return hasAccess;
     } else {
       // Для групповых чатов
       const groupRef = db.ref(`groups/${chatId}`);
       const groupSnap = await groupRef.once('value');

       if (!groupSnap.exists()) {
         console.log('Группа не найдена:', chatId);
         return false;
       }

       const group = groupSnap.val();

       // 1. Если педагог
       if (group.teachers && group.teachers[userId]) {
         console.log('✅ Пользователь является педагогом группы');
         return true;
       }

       // 2. Если явно указан как родитель
       if (group.parents && group.parents[userId]) {
         console.log('✅ Пользователь является родителем группы');
         return true;
       }

       // 3. Если родитель связан с группой через ребёнка
       const userRef = db.ref(`users/${userId}`);
       const userSnap = await userRef.once('value');

       if (userSnap.exists()) {
         const user = userSnap.val();

         if (user.role === "Родитель" && user.children) {
           for (const childId of Object.keys(user.children)) {
             if (
               (group.children && group.children[childId]) || // ребёнок есть в группе
               (user.children[childId].groupId === chatId) || // или по полю groupId
               (user.children[childId].group === chatId)      // legacy
             ) {
               console.log('✅ Родитель связан с группой через ребёнка:', childId);
               return true;
             }
           }
         }
       }

       console.log('⛔ Доступ к группе запрещен для пользователя:', userId);
       return false;
     }
   } catch (error) {
     console.error('Ошибка проверки доступа к чату:', error);
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


// === Отправка сообщения с автоматическим push-уведомлением ===
app.post("/send-message", verifyToken, async (req, res) => {
  try {
    const { chatId, message, messageType = "text", fileUrl, fileName } = req.body;
    const senderId = req.user.uid;

    if (!chatId || !message) {
      return res.status(400).json({ error: "chatId и message обязательны" });
    }

    console.log("💬 Новое сообщение от:", senderId, "в чат:", chatId);

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

    // 3. ✅ ОПРЕДЕЛЯЕМ ТИП ЧАТА И СОХРАНЯЕМ В ПРАВИЛЬНЫЙ ПУТЬ
    let chatRef;

    // Определяем тип чата по chatId
    const isPrivateChat = await isPrivateChatId(chatId);

    if (isPrivateChat) {
      // ✅ ПРИВАТНЫЙ ЧАТ: chats/private/chatId/messages
      chatRef = db.ref(`chats/private/${chatId}/messages/${messageId}`);
      console.log("🔒 Сохраняем в ПРИВАТНЫЙ чат:", chatId);
    } else {
      // ✅ ГРУППОВОЙ ЧАТ: chats/groups/chatId/messages
      chatRef = db.ref(`chats/groups/${chatId}/messages/${messageId}`);
      console.log("👥 Сохраняем в ГРУППОВОЙ чат:", chatId);
    }

    await chatRef.set(messageData);
    console.log("✅ Сообщение сохранено в базу по пути:", chatRef.toString());

    // 4. Отправляем уведомления
    await sendChatNotification({
      chatId,
      senderId,
      senderName,
      message,
      messageType,
      fileUrl,
      fileName,
      isPrivate: isPrivateChat // передаем тип чата
    });

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

// === Функция отправки уведомления о новом сообщении ===
async function sendChatNotification({ chatId, senderId, senderName, message, messageType, fileUrl, fileName, isPrivate }) {
  try {
    console.log("🔔 Отправка уведомления о сообщении...");
    console.log("chatId:", chatId);
    console.log("senderId:", senderId);
    console.log("senderName:", senderName);
    console.log("message:", message);
    console.log("messageType:", messageType);
    console.log("isPrivate:", isPrivate);

    // 1. Определяем получателей
    let recipientIds = [];

    if (isPrivate) {
      const parts = chatId.split('_');
      recipientIds = parts.filter(id => id !== senderId);
      console.log('🔒 Приватный чат, получатели:', recipientIds);
    } else {
      const groupSnap = await db.ref(`groups/${chatId}`).once('value');
      const group = groupSnap.val();

      if (group) {
        if (group.teachers) recipientIds.push(...Object.keys(group.teachers));
        if (group.parents) recipientIds.push(...Object.keys(group.parents));
        recipientIds = recipientIds.filter(id => id !== senderId);
        console.log('👥 Групповой чат, получатели:', recipientIds);
      }
    }

    if (recipientIds.length === 0) {
      console.log("⚠️ Нет получателей для уведомления");
      return;
    }

    // 2. Получаем FCM токены получателей
    const tokens = [];
    for (const recipientId of recipientIds) {
      const userSnap = await db.ref(`users/${recipientId}`).once('value');
      const user = userSnap.val();

      if (user && user.fcmToken) {
        tokens.push(user.fcmToken);
        console.log("✅ Найден токен для:", recipientId);
      } else {
        console.log("⚠️ Нет FCM токена для:", recipientId);
      }
    }

    if (tokens.length === 0) {
      console.log("⚠️ Нет активных FCM токенов для отправки");
      return;
    }

    // 🟢 ВОТ СЮДА вставляем лог перед циклом
    console.log("📱 Кол-во токенов:", tokens.length);
    console.log("Список токенов:", tokens);

    // 3. Формируем текст уведомления
    let notificationBody = message;
    if (messageType === "image") notificationBody = "📷 Фото";
    else if (messageType === "video") notificationBody = "🎥 Видео";
    else if (messageType === "file") notificationBody = `📎 Файл: ${fileName || "файл"}`;
    else if (messageType === "audio") notificationBody = "🎵 Аудио";

// 4. Отправляем уведомления
for (const token of tokens) {
  try {
    console.log("➡️ Отправка push для токена:", token.substring(0, 10) + "...");

    const messagePayload = {
      token,
      data: {
        type: "chat",
        senderName: String(senderName || ""),
        message: String(notificationBody || ""),
        chatId: String(chatId || ""),
        senderId: String(senderId || ""),
        timestamp: String(Date.now()),
        displayName: String(senderName || ""),
        isGroup: isPrivate ? "false" : "true" // ✅ всегда строка
      },
      android: {
        priority: "high"
      },
      apns: {
        payload: {
          aps: { contentAvailable: true }
        }
      }
    };

    console.log("📨 Отправляю FCM payload:", JSON.stringify(messagePayload.data, null, 2));
    const response = await admin.messaging().send(messagePayload);

    console.log("✅ Пуш отправлен для токена:", token.substring(0, 10) + "...", "| response:", response);

  } catch (tokenError) {
    console.error("❌ Ошибка отправки для токена:", token.substring(0, 10) + "...", tokenError.message);

    if (tokenError.code === "messaging/registration-token-not-registered") {
      await removeInvalidToken(token);
    }
  }
}


    console.log(`🎉 Уведомления отправлены для ${tokens.length} получателей`);

  } catch (err) {
    console.error("❌ Ошибка в sendChatNotification:", err.message, err.stack);
  }
}


// === Удаление невалидного FCM токена ===
async function removeInvalidToken(invalidToken) {
  try {
    console.log("🗑️ Удаление невалидного FCM токена:", invalidToken.substring(0, 10) + "...");

    // Ищем пользователя с этим токеном
    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};

    for (const [userId, user] of Object.entries(users)) {
      if (user.fcmToken === invalidToken) {
        await db.ref(`users/${userId}`).update({ fcmToken: null });
        console.log("✅ Токен удален у пользователя:", userId);
        break;
      }
    }
  } catch (err) {
    console.error("❌ Ошибка удаления токена:", err);
  }
}


// === Отправка уведомления о новом событии ===
app.post("/send-event-notification", verifyToken, async (req, res) => {
  try {
    const {
      groupId,
      groupName,
      childId,
      childName,
      eventId,
      title,
      time,
      place,
      comments,
      date
    } = req.body;

    // Валидация обязательных полей
    if (!groupId || !eventId || !title || !childId) {
      return res.status(400).json({
        error: "groupId, eventId, title, childId обязательны"
      });
    }

    console.log("🔔 Запрос на отправку уведомления о событии:");
    console.log("   - Группа:", groupId, groupName);
    console.log("   - Ребенок:", childId, childName);
    console.log("   - Событие:", title, time);

    // 1. Находим родителей ребенка
    const parents = await findParentsByChildId(childId);

    if (parents.length === 0) {
      console.log("⚠️ Не найдены родители для ребенка:", childId);
      return res.json({
        success: true,
        message: "Событие создано, но родители не найдены"
      });
    }

    console.log("👨‍👩‍👧‍👦 Найдены родители:", parents.length);

    // 2. Получаем FCM токены родителей
    const tokens = [];
    for (const parent of parents) {
      if (parent.fcmToken) {
        tokens.push(parent.fcmToken);
        console.log("✅ Токен родителя:", parent.userId, parent.name);
      }
    }

    if (tokens.length === 0) {
      console.log("⚠️ Нет активных FCM токенов у родителей");
      return res.json({
        success: true,
        message: "Событие создано, но нет активных токенов"
      });
    }

    // 3. Формируем текст уведомления
    const notificationBody = formatEventNotification(title, time, place, childName);

    // 4. Отправляем уведомления
    await sendEventNotifications({
      tokens,
      groupId,
      groupName,
      childId,
      childName,
      eventId,
      title,
      time,
      place,
      comments,
      date,
      notificationBody
    });

    console.log(`🎉 Уведомления о событии отправлены для ${tokens.length} родителей`);

    res.json({
      success: true,
      message: `Уведомления отправлены ${tokens.length} родителям`,
      recipients: tokens.length
    });

  } catch (err) {
    console.error("❌ Ошибка отправки уведомления о событии:", err);
    res.status(500).json({
      error: "Внутренняя ошибка сервера: " + err.message
    });
  }
});

// === Поиск родителей по ID ребенка ===
async function findParentsByChildId(childId) {
  try {
    console.log("🔍 Поиск родителей для ребенка:", childId);

    const usersSnap = await db.ref('users').once('value');
    const users = usersSnap.val() || {};
    const parents = [];

    for (const [userId, user] of Object.entries(users)) {
      // Проверяем только пользователей с ролью "Родитель"
      if (user.role === "Родитель" && user.children) {
        // Проверяем, есть ли у этого родителя нужный ребенок
        if (user.children[childId]) {
          parents.push({
            userId,
            name: user.name || "Родитель",
            fcmToken: user.fcmToken || null
          });
          console.log("✅ Найден родитель:", user.name, "для ребенка:", childId);
        }
      }
    }

    return parents;
  } catch (error) {
    console.error("❌ Ошибка поиска родителей:", error);
    return [];
  }
}

// === Форматирование текста уведомления ===
function formatEventNotification(title, time, place, childName) {
  let notification = `📅 ${title}`;

  if (time) {
    notification += ` в ${time}`;
  }

  if (place) {
    notification += ` (${place})`;
  }

  if (childName) {
    notification += ` для ${childName}`;
  }

  return notification;
}

// === Отправка FCM уведомлений о событии ===
async function sendEventNotifications({
  tokens,
  groupId,
  groupName,
  childId,
  childName,
  eventId,
  title,
  time,
  place,
  comments,
  date,
  notificationBody
}) {
  try {
    console.log("📱 Отправка FCM уведомлений для токенов:", tokens.length);

    for (const token of tokens) {
      try {
        console.log("➡️ Отправка уведомления для токена:", token.substring(0, 10) + "...");

        const messagePayload = {
          token,
          data: {
            type: "new_event",
            groupId: String(groupId || ""),
            groupName: String(groupName || ""),
            childId: String(childId || ""),
            childName: String(childName || ""),
            eventId: String(eventId || ""),
            title: String(title || ""),
            time: String(time || ""),
            place: String(place || ""),
            comments: String(comments || ""),
            date: String(date || ""),
            timestamp: String(Date.now())
          },
          notification: {
            title: "📅 Новое событие",
            body: notificationBody,
            // Для Android - важное уведомление
            android: {
              priority: "high",
              notification: {
                sound: "default",
                channel_id: "events_channel"
              }
            },
            // Для iOS
            apns: {
              payload: {
                aps: {
                  sound: "default",
                  badge: 1,
                  'content-available': 1
                }
              }
            }
          }
        };

        console.log("📨 Отправляю FCM payload:", JSON.stringify(messagePayload.data, null, 2));
        const response = await admin.messaging().send(messagePayload);

        console.log("✅ Пуш отправлен для токена:", token.substring(0, 10) + "...", "| response:", response);

      } catch (tokenError) {
        console.error("❌ Ошибка отправки для токена:", token.substring(0, 10) + "...", tokenError.message);

        // Удаляем невалидные токены
        if (tokenError.code === "messaging/registration-token-not-registered") {
          await removeInvalidToken(token);
        }
      }
    }

    console.log(`🎉 Уведомления о событии отправлены для ${tokens.length} получателей`);

  } catch (err) {
    console.error("❌ Ошибка в sendEventNotifications:", err.message, err.stack);
  }
}


// === Проверка сервера ===
app.get("/", (req, res) => res.send("Server is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
