const express = require('express');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

const serviceAccount = require('./teremok-1a3ff-firebase-adminsdk-fbsvc-3d34a609b1.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://teremok-1a3ff-firebase-adminsdk-fbsvc-3d34a609b1"
});

const db = admin.database();
const auth = admin.auth();

// 🔄 Удаление пользователя по имени
app.post('/deleteUserByName', async (req, res) => {
  const fullName = req.body.fullName;

  try {
    // Найдём всех пользователей
    const usersSnapshot = await db.ref('users').once('value');
    const users = usersSnapshot.val();

    let found = false;

    for (const userId in users) {
      const user = users[userId];

      // === Удаление родителя ===
      if (user.name === fullName && user.role === 'родитель') {
        found = true;

        // Удаление всех его детей
        if (user.children) {
          for (const childId in user.children) {
            const child = user.children[childId];
            const groupId = child.group;

            // Удалить из группы
            if (groupId) {
              await db.ref(`groups/${groupId}/children/${childId}`).remove();
            }
          }
        }

        // Удалить родителя
        await db.ref(`users/${userId}`).remove();
        await auth.deleteUser(userId); // из Firebase Auth
        return res.send("Родитель и его дети удалены.");
      }

      // === Удаление педагога ===
      if (user.name === fullName && user.role === 'педагог') {
        found = true;

        // Удалить из групп
        const groupsSnapshot = await db.ref('groups').once('value');
        const groups = groupsSnapshot.val();
        for (const groupId in groups) {
          if (groups[groupId].teachers && groups[groupId].teachers[userId]) {
            await db.ref(`groups/${groupId}/teachers/${userId}`).remove();
          }
        }

        await db.ref(`users/${userId}`).remove();
        await auth.deleteUser(userId);
        return res.send("Педагог удалён.");
      }

      // === Проверка детей у родителя ===
      if (user.children) {
        for (const childId in user.children) {
          const child = user.children[childId];
          if (child.fullName === fullName) {
            found = true;

            // Удалить из группы
            if (child.group) {
              await db.ref(`groups/${child.group}/children/${childId}`).remove();
            }

            // Удалить у родителя
            await db.ref(`users/${userId}/children/${childId}`).remove();

            return res.send("Ребёнок удалён.");
          }
        }
      }
    }

    if (!found) {
      return res.status(404).send("Пользователь не найден.");
    }

  } catch (error) {
    console.error(error);
    return res.status(500).send("Ошибка при удалении.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));

