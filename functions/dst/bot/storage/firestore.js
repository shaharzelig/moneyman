import { createLogger } from "../../utils/logger.js";
import { createSaveStats } from "../saveStats.js";
import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";
const logger = createLogger("FirestoreStorage");
export class FirestoreStorage {
    uid;
    constructor(uid) {
        this.uid = uid;
    }
    // FIREBASE_CONFIG is automatically set by the Cloud Functions runtime.
    // It is not present in local/Docker runs, so canSave() returns false there.
    canSave() {
        return Boolean(process.env.FIREBASE_CONFIG);
    }
    async saveTransactions(txns, onProgress) {
        if (!this.canSave()) {
            throw new Error("FirestoreStorage: Firebase Admin not initialized");
        }
        const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
        const db = getFirestore();
        const collection = `users/${this.uid}/transactions`;
        const stats = createSaveStats("Firestore", collection, txns);
        const settledTxns = txns.filter((tx) => tx.status !== TransactionStatuses.Pending);
        await onProgress("Writing to Firestore");
        const BATCH_SIZE = 500;
        for (let i = 0; i < settledTxns.length; i += BATCH_SIZE) {
            const chunk = settledTxns.slice(i, i + BATCH_SIZE);
            const refs = chunk.map((tx) => db.collection(collection).doc(tx.hash));
            const snaps = await db.getAll(...refs);
            const batch = db.batch();
            let batchCount = 0;
            for (let j = 0; j < chunk.length; j++) {
                const snap = snaps[j];
                const tx = chunk[j];
                if (snap.exists) {
                    stats.existing++;
                }
                else {
                    const doc = Object.fromEntries(Object.entries({ ...tx, savedAt: FieldValue.serverTimestamp() }).filter(([, v]) => v !== undefined));
                    batch.set(snap.ref, doc);
                    stats.added++;
                    batchCount++;
                }
            }
            if (batchCount > 0) {
                await batch.commit();
            }
            await onProgress(`Wrote ${Math.min(i + BATCH_SIZE, settledTxns.length)}/${settledTxns.length}`);
        }
        logger(`saved ${stats.added} new, ${stats.existing} existing`);
        return stats;
    }
}
//# sourceMappingURL=firestore.js.map