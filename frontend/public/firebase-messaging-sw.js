importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// REEMPLAZA ESTO CON TUS CLAVES PÚBLICAS DE FIREBASE
const firebaseConfig = {
  apiKey: "AIzaSyDuBcYxUDBugPf2sSTXNiwaKYdsoCcjvWs",
  authDomain: "reportbot-b0efe.firebaseapp.com",
  projectId: "reportbot-b0efe",
  storageBucket: "reportbot-b0efe.firebasestorage.app",
  messagingSenderId: "156589703029",
  appId: "1:156589703029:web:37b19a0bbe23e0edde5d3c",
  measurementId: "G-9WHQPQH6VV"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function (payload) {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);

  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/vite.svg'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
