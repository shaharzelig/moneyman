// scripts/seed-cibus-credentials.js
// Usage: FIREBASE_UID=<your-uid> node scripts/seed-cibus-credentials.js
// Reads cibus credentials from config.jsonc and seeds them into Firestore.
import { readFileSync } from 'fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { parse as parseJsonc } from 'jsonc-parser';

const uid = process.env.FIREBASE_UID;
if (!uid) {
  console.error('FIREBASE_UID env var required');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '{}')) });
// Falls back to application default credentials if env var not set:
// run `gcloud auth application-default login` first

const config = parseJsonc(readFileSync('config.jsonc', 'utf8'));
const cibus = config.accounts?.find(a => a.companyId === 'cibus');
if (!cibus) {
  console.error('No cibus account found in config.jsonc');
  process.exit(1);
}

const db = getFirestore();
await db.doc(`users/${uid}/scrapers/cibus`).set({
  username: cibus.username,
  password: cibus.password,
  status: 'not_connected',
  updatedAt: FieldValue.serverTimestamp(),
}, { merge: true });

console.log(`Seeded cibus credentials for uid=${uid}`);
