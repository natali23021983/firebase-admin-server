require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');

// 🔽 Декодирование base64
const base64 = process.env.FIREBASE_CONFIG;

if (!base64) {
  throw new Error("FIREBASE_CONFIG_BASE64 переменная не найдена в .env");
}

const decoded = Buffer.from(base64, 'base64').toString('utf8');
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://teremok-1a3ff-default-rtdb.firebaseio.com"
});

const app = express();
app.use(express.json());

const db = admin.database();
const auth = admin.auth();

app.post('/deleteUserByName', async (req, res) => {
  const fullName = req.body.fullName;
  if (!fullName) return res.status(400).send("fullName обязателен");

  try {
    const usersSnapshot = await db.ref('users').once('value');
    const users = usersSnapshot.val();

    let found = false;

    for (const userId in users) {
      const user = users[userId];

      console.log(`Проверяем пользователя: userId=${userId}, name='${user.name}', role='${user.role}'`);

      // === Родитель ===
      if (
        user.name &&
        user.name.trim().toLowerCase() === fullName.trim().toLowerCase() &&
        user.role &&
        user.role.trim().toLowerCase() === 'родитель'
      ) {
        found = true;

        console.log(`Найден родитель: ${user.name} (${userId})`);

        // Удалить детей из групп
        if (user.children) {
          for (const childId in user.children) {
            const child = user.children[childId];
            const groupId = child.group;

            if (groupId) {
              const groupChildrenRef = db.ref(`groups/${groupId}/children`);
              const groupChildrenSnap = await groupChildrenRef.once('value');
              const groupChildren = groupChildrenSnap.val();

              for (const gcId in groupChildren) {
                if (groupChildren[gcId] === child.fullName) {
                  await groupChildrenRef.child(gcId).remove();
                  console.log(`Удалён ребёнок ${child.fullName} из группы ${groupId}`);
                  break;
                }
              }
            }
          }
        }

        // Удалить родителя
        await db.ref(`users/${userId}`).remove();
        await auth.deleteUser(userId);
        console.log(`Родитель ${user.name} удалён из базы и авторизации`);

        return res.send("Родитель и его дети удалены.");
      }

      // === Педагог ===
      if (
        user.name &&
        user.name.trim().toLowerCase() === fullName.trim().toLowerCase() &&
        user.role &&
        user.role.trim().toLowerCase() === 'педагог'
      ) {
        found = true;

        console.log(`Найден педагог: ${user.name} (${userId})`);

        const groupsSnapshot = await db.ref('groups').once('value');
        const groups = groupsSnapshot.val();

        for (const groupId in groups) {
          if (groups[groupId].teachers && groups[groupId].teachers[userId]) {
            await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
            console.log(`Удалён педагог ${user.name} из группы ${groupId}`);
          }
        }

        await db.ref(`users/${userId}`).remove();
        await auth.deleteUser(userId);
        console.log(`Педагог ${user.name} удалён из базы и авторизации`);

        return res.send("Педагог удалён.");
      }

      // === Ребёнок по полному имени ===
      if (user.children) {
        for (const childId in user.children) {
          const child = user.children[childId];
          if (
            child.fullName &&
            child.fullName.trim().toLowerCase() === fullName.trim().toLowerCase()
          ) {
            found = true;

            console.log(`Найден ребёнок: ${child.fullName} (${childId}) у пользователя ${userId}`);

            if (child.group) {
              const groupChildrenRef = db.ref(`groups/${child.group}/children`);
              const groupChildrenSnap = await groupChildrenRef.once('value');
              const groupChildren = groupChildrenSnap.val();

              for (const gcId in groupChildren) {
                if (groupChildren[gcId] === child.fullName) {
                  await groupChildrenRef.child(gcId).remove();
                  console.log(`Удалён ребёнок ${child.fullName} из группы ${child.group}`);
                  break;
                }
              }
            }

            await db.ref(`users/${userId}/children/${childId}`).remove();
            console.log(`Удалён ребёнок ${child.fullName} у родителя ${user.name}`);

            return res.send("Ребёнок удалён.");
          }
        }
      }
    }

    if (!found) {
      console.log(`Пользователь с именем "${fullName}" не найден.`);
      return res.status(404).send("Пользователь не найден.");
    }

  } catch (error) {
    console.error("Ошибка при удалении пользователя:", error);
    return res.status(500).send("Ошибка при удалении.");
  }
});
