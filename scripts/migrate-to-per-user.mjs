// One-time migration: copy global moneyman data to per-user Firestore paths.
// Run with: GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json node scripts/migrate-to-per-user.mjs
//
// Safe to run multiple times — uses set() with merge: true (no data is overwritten destructively).
// Old global documents are preserved; delete them manually after verifying the migration.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

async function migrate() {
  // Step 1: read owner config to get the uid
  const configDoc = await db.doc('moneyman/config').get();
  if (!configDoc.exists) {
    console.log('No moneyman/config found — nothing to migrate.');
    return;
  }
  const configData = configDoc.data();
  const uid = configData.uid;
  if (!uid) {
    console.error('ERROR: moneyman/config has no "uid" field. Add your Firebase UID to the document first.');
    process.exit(1);
  }
  console.log(`Migrating data for owner uid: ${uid}`);

  // Step 2: copy config to per-user path
  await db.doc(`users/${uid}/moneyman/config`).set(configData, { merge: true });
  console.log('✓ Copied moneyman/config → users/{uid}/moneyman/config');

  // Step 3: copy transactions (global moneymanTransactions → users/{uid}/transactions)
  const txnsSnapshot = await db.collection('moneymanTransactions').get();
  if (txnsSnapshot.empty) {
    console.log('No transactions to migrate.');
  } else {
    console.log(`Migrating ${txnsSnapshot.size} transactions…`);
    const BATCH_SIZE = 500;
    let batch = db.batch();
    let count = 0;

    for (const txDoc of txnsSnapshot.docs) {
      const targetRef = db.collection(`users/${uid}/transactions`).doc(txDoc.id);
      batch.set(targetRef, txDoc.data());
      count++;
      if (count % BATCH_SIZE === 0) {
        await batch.commit();
        batch = db.batch();
        console.log(`  ${count}/${txnsSnapshot.size} migrated`);
      }
    }
    if (count % BATCH_SIZE !== 0) await batch.commit();
    console.log(`✓ Migrated ${count} transactions → users/${uid}/transactions`);
  }

  console.log('\nMigration complete.');
  console.log('Old global documents (moneyman/config, moneymanTransactions) are preserved.');
  console.log('Verify the migration in the Firebase console, then delete them manually.');
}

migrate().catch((e) => { console.error('Migration failed:', e); process.exit(1); });
