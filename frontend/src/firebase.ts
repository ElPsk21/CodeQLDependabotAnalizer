import { initializeApp } from "firebase/app";
import { getMessaging, getToken, onMessage } from "firebase/messaging";

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

const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

export const initializeFirebasePush = async (): Promise<string | null> => {
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      console.log('Permiso de notificaciones concedido.');
      // IMPORTANTE: Reemplaza vapidKey con tu llave VAPID pública real (Web Push certificates)
      const token = await getToken(messaging, { vapidKey: 'BMfnKcwcOQZnP7Z-5Sf_qzOWj8k8z1VWQJr92ln1u2oW2o8eqKW69vdB2UnFaGiG-HXncRQeDPLJG6INPFJn33k' });

      if (token) {
        console.log('FCM Token:', token);
        return token;
      } else {
        console.log('No se pudo obtener el token.');
        return null;
      }
    } else {
      console.log('Permiso de notificaciones denegado.');
      return null;
    }
  } catch (error) {
    console.error('Error inicializando Firebase:', error);
    return null;
  }
};

export const listenToMessages = () => {
  onMessage(messaging, (payload) => {
    console.log('Message received. ', payload);
    new Notification(payload.notification?.title || "Notification", {
      body: payload.notification?.body,
    });
  });
};
