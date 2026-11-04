import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD9Sn6ThBAyBDtX99g2t9cslWxRLvp1D_0",
  authDomain: "mitolecule-group.firebaseapp.com",
  projectId: "mitolecule-group",
  storageBucket: "mitolecule-group.firebasestorage.app",
  messagingSenderId: "536537857958",
  appId: "1:536537857958:web:9a9a6531c064b03b129967",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
});
