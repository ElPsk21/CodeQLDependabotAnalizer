const admin = require("firebase-admin");
const path = require("path");

let serviceAccount;
try {
  serviceAccount = require(path.join(__dirname, "service-account.json"));
} catch (e) {
  console.error("Error: No se encontró 'service-account.json' en", __dirname);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const token = process.argv[2] ? process.argv[2].trim() : undefined;
const title = process.argv[3] || "ReportBot";
const messageText = process.argv[4] || "¡El proceso ha finalizado!";

if (!token) {
  console.error("Error: Se requiere un token FCM como argumento.");
  process.exit(1);
}

const message = {
  notification: {
    title: title,
    body: messageText
  },
  token: token
};

admin.messaging().send(message)
  .then((response) => {
    console.log("Notificación enviada exitosamente:", response);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error enviando notificación:", error);
    process.exit(1);
  });
