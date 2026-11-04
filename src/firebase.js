import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD9ilr1AhDZ3tcuvVGOf_L7izmP8LVblHQ",
  authDomain: "mitoleculegroup.firebaseapp.com",
  projectId: "mitoleculegroup",
  storageBucket: "mitoleculegroup.firebasestorage.app",
  messagingSenderId: "366122289514",
  appId: "1:366122289514:web:02d810d7e470245c86bd13",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
