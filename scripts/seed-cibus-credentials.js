// scripts/seed-cibus-credentials.js
// Usage: FIREBASE_UID=<your-uid> node scripts/seed-cibus-credentials.js
// Reads cibus credentials from config.jsonc and seeds them into Firestore.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { parse as parseJsonc } from 'jsonc-parser';

const uid = process.env.FIREBASE_UID;
if (!uid) {
  console.error('FIREBASE_UID env var required');
  process.exit(1);
}

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  initializeApp({ credential: cert(JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)) });
} else {
  initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS file or gcloud ADC
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = parseJsonc(readFileSync(join(__dirname, '../config.jsonc'), 'utf8'));
const cibus = config.accounts?.find(a => a.companyId === 'cibus');
if (!cibus) {
  console.error('No cibus account found in config.jsonc');
  process.exit(1);
}

const db = getFirestore();
const ref = db.doc(`users/${uid}/scrapers/cibus`);
const snap = await ref.get();
if (snap.exists) {
  console.error(`Firestore document users/${uid}/scrapers/cibus already exists. Delete it manually first to re-seed.`);
  process.exit(1);
}
await ref.set({
  username: cibus.username,
  password: cibus.password,
  status: 'not_connected',
  updatedAt: FieldValue.serverTimestamp(),
});

console.log(`Seeded cibus credentials for uid=${uid}`);
