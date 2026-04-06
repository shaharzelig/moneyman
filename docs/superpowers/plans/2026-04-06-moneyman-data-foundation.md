# Moneyman Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make moneyman multi-tenant — each approved Stocky user scrapes their own accounts, with transactions and run logs stored per-user in Firestore instead of Google Sheets and Telegram.

**Architecture:** The scheduled Cloud Function fans out by writing a `scrapeRequest` per user instead of scraping directly. A Firestore trigger on `users/{uid}/moneyman/scrapeRequest` handles each user's scrape in full isolation. `FirestoreStorage` is updated to write to `users/{uid}/transactions/{hash}`. Run logs replace Telegram as the progress/error mechanism.

**Tech Stack:** Node.js 18, Firebase Cloud Functions v2, Firestore, TypeScript (moneyman repo), React + TypeScript (stocky repo)

---

## Repos

- **moneyman:** `/Users/shahar.zelig/workspace/moneyman`
- **stocky:** `/Users/shahar.zelig/workspace/stocky`

## File Map

| Action | File | What changes |
|--------|------|--------------|
| Modify | `moneyman/src/bot/storage/firestore.ts` | Constructor accepts `uid`, writes to `users/${uid}/transactions` |
| Modify | `moneyman/src/bot/storage/index.ts` | Export `resultsToTransactions`; remove `FirestoreStorage` from `storages` array |
| Create | `moneyman/src/bot/storage/firestore.test.ts` | Unit test for per-user path |
| Rewrite | `moneyman/functions/index.js` | New `runMoneymanForUser(uid)`, fan-out scheduler, wildcard trigger, updated HTTP function |
| Modify | `stocky/firestore.rules` | Remove hardcoded-UID rules; add per-user rules using `isApproved()` |
| Modify | `stocky/frontend/src/components/connections/BankConnections.tsx` | Update all Firestore paths; add latest run + next scheduled run display |
| Create | `moneyman/scripts/migrate-to-per-user.mjs` | One-time migration of existing owner data |

---

## Task 1: Update `FirestoreStorage` to write to per-user path

**Files:**
- Create: `moneyman/src/bot/storage/firestore.test.ts`
- Modify: `moneyman/src/bot/storage/firestore.ts`

All work is done from the `moneyman` repo root.

- [ ] **Step 1: Write the failing test**

Create `src/bot/storage/firestore.test.ts`:

```typescript
import { FirestoreStorage } from './firestore.js';
import { transactionRow } from '../../utils/tests.js';
import { TransactionStatuses } from 'israeli-bank-scrapers/lib/transactions.js';

const mockBatch = {
  set: jest.fn(),
  commit: jest.fn().mockResolvedValue(undefined),
};
const mockDocRef = {};
const mockDb = {
  collection: jest.fn().mockReturnValue({
    doc: jest.fn().mockReturnValue(mockDocRef),
  }),
  getAll: jest.fn().mockResolvedValue([{ exists: false }]),
  batch: jest.fn().mockReturnValue(mockBatch),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: { serverTimestamp: jest.fn().mockReturnValue('TIMESTAMP') },
}));

jest.mock('../../utils/logger.js', () => ({
  createLogger: () => jest.fn(),
}));

jest.mock('../saveStats.js', () => ({
  createSaveStats: jest.fn().mockReturnValue({ added: 0, existing: 0, name: 'Firestore' }),
}));

describe('FirestoreStorage', () => {
  const uid = 'user-abc-123';

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.getAll.mockResolvedValue([{ exists: false }]);
  });

  it('writes transactions to users/{uid}/transactions collection', async () => {
    const storage = new FirestoreStorage(uid);
    const tx = transactionRow({ status: TransactionStatuses.Completed });
    await storage.saveTransactions([tx], async () => {});
    expect(mockDb.collection).toHaveBeenCalledWith(`users/${uid}/transactions`);
  });

  it('canSave returns true when FIREBASE_CONFIG is set', () => {
    process.env.FIREBASE_CONFIG = '{}';
    const storage = new FirestoreStorage(uid);
    expect(storage.canSave()).toBe(true);
    delete process.env.FIREBASE_CONFIG;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --testPathPattern=firestore.test
```

Expected: FAIL — `FirestoreStorage` constructor does not accept arguments.

- [ ] **Step 3: Update `FirestoreStorage` to accept `uid`**

Replace the full contents of `src/bot/storage/firestore.ts`:

```typescript
import { createLogger } from "../../utils/logger.js";
import { createSaveStats } from "../saveStats.js";
import type { TransactionRow, TransactionStorage } from "../../types.js";
import type { SaveStats } from "../saveStats.js";
import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";

const logger = createLogger("FirestoreStorage");

export class FirestoreStorage implements TransactionStorage {
  constructor(private uid: string) {}

  // FIREBASE_CONFIG is automatically set by the Cloud Functions runtime.
  // It is not present in local/Docker runs, so canSave() returns false there.
  canSave(): boolean {
    return Boolean(process.env.FIREBASE_CONFIG);
  }

  async saveTransactions(
    txns: Array<TransactionRow>,
    onProgress: (status: string) => Promise<void>,
  ): Promise<SaveStats> {
    if (!this.canSave()) {
      throw new Error("FirestoreStorage: Firebase Admin not initialized");
    }

    const { getFirestore, FieldValue } = await import(
      "firebase-admin/firestore"
    );
    const db = getFirestore();
    const collection = `users/${this.uid}/transactions`;
    const stats = createSaveStats("Firestore", collection, txns);

    const settledTxns = txns.filter(
      (tx) => tx.status !== TransactionStatuses.Pending,
    );

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
        } else {
          const doc = Object.fromEntries(
            Object.entries({ ...tx, savedAt: FieldValue.serverTimestamp() }).filter(
              ([, v]) => v !== undefined,
            ),
          );
          batch.set(snap.ref, doc);
          stats.added++;
          batchCount++;
        }
      }

      if (batchCount > 0) {
        await batch.commit();
      }
      await onProgress(
        `Wrote ${Math.min(i + BATCH_SIZE, settledTxns.length)}/${settledTxns.length}`,
      );
    }

    logger(`saved ${stats.added} new, ${stats.existing} existing`);
    return stats;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- --testPathPattern=firestore.test
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/storage/firestore.ts src/bot/storage/firestore.test.ts
git commit -m "feat: make FirestoreStorage per-user, write to users/{uid}/transactions"
```

---

## Task 2: Export `resultsToTransactions`, remove `FirestoreStorage` from storages array

**Files:**
- Modify: `moneyman/src/bot/storage/index.ts`

- [ ] **Step 1: Update `storage/index.ts`**

Make two changes:
1. Remove `FirestoreStorage` from the `storages` array (the Cloud Function manages it directly; local runs don't use Firestore).
2. Export `resultsToTransactions` so the Cloud Function can convert scrape results to transaction rows.

Replace the full contents of `src/bot/storage/index.ts`:

```typescript
import { parallel } from "async";
import {
  AccountScrapeResult,
  TransactionRow,
  TransactionStorage,
  SaveContext,
} from "../../types.js";
import { createLogger } from "../../utils/logger.js";
import { loggerContextStore } from "../../utils/asyncContext.js";
import { Timer } from "../../utils/Timer.js";
import { saving } from "../messages.js";
import { editMessage, send, sendError } from "../notifier.js";
import { statsString } from "../saveStats.js";
import { ActualBudgetStorage } from "./actual.js";
import { AzureDataExplorerStorage } from "./azure-data-explorer.js";
import { BuxferStorage } from "./buxfer.js";
import { LocalJsonStorage } from "./json.js";
import { GoogleSheetsStorage } from "./sheets.js";
import { transactionHash, transactionUniqueId } from "./utils.js";
import { WebPostStorage } from "./web-post.js";
import { TelegramStorage } from "./telegram.js";
import { YNABStorage } from "./ynab.js";
import { SqlStorage } from "./sql.js";
import { MoneymanDashStorage } from "./moneyman.js";
import { config } from "../../config.js";

const baseLogger = createLogger("storage");

// FirestoreStorage is excluded here — the Cloud Function creates it directly
// per-user with new FirestoreStorage(uid). Local/Docker runs don't use Firestore.
export const storages = [
  new LocalJsonStorage(config),
  new GoogleSheetsStorage(config),
  new AzureDataExplorerStorage(config),
  new YNABStorage(config),
  new BuxferStorage(config),
  new WebPostStorage(config),
  new TelegramStorage(config),
  new ActualBudgetStorage(config),
  new SqlStorage(config),
  new MoneymanDashStorage(config),
].filter((s) => s.canSave());

export async function saveResults(results: Array<AccountScrapeResult>) {
  if (storages.length === 0) {
    await send("No storages found, skipping save");
    return;
  }

  const txns = resultsToTransactions(results);
  if (txns.length === 0) {
    await send("No transactions found, skipping save");
    return;
  }

  // Build context with per-account scraping results
  const context: SaveContext = {
    accountResults: results.map((r) => ({
      companyId: r.companyId,
      success: r.result.success,
      errorType: r.result.errorType,
      errorMessage: r.result.errorMessage,
      accountCount: r.result.accounts?.length ?? 0,
      txnCount:
        r.result.accounts?.reduce((sum, a) => sum + a.txns.length, 0) ?? 0,
    })),
  };

  await parallel(
    storages.map((storage: TransactionStorage) => async () => {
      const { name } = storage.constructor;
      const logger = baseLogger.extend(name);
      const steps: Array<Timer> = [];

      return loggerContextStore.run({ prefix: `[${name}]` }, async () => {
        try {
          logger(`saving ${txns.length} transactions`);
          const message = await send(saving(name));
          const start = performance.now();
          const stats = await storage.saveTransactions(
            txns,
            async (step) => {
              steps.at(-1)?.end();
              steps.push(new Timer(step));
              await editMessage(message?.message_id, saving(name, steps));
            },
            context,
          );
          const duration = performance.now() - start;
          steps.at(-1)?.end();
          logger(`saved`);
          await editMessage(
            message?.message_id,
            statsString(stats, duration, steps),
          );
        } catch (e) {
          logger(`error saving transactions`, e);
          sendError(e, `saveTransactions::${name}`);
        }
      });
    }),
  );
}

export function resultsToTransactions(
  results: Array<AccountScrapeResult>,
): Array<TransactionRow> {
  const txns: Array<TransactionRow> = [];

  for (let { result, companyId } of results) {
    if (result.success) {
      for (let account of result.accounts ?? []) {
        for (let tx of account.txns) {
          try {
            txns.push({
              ...tx,
              account: account.accountNumber,
              companyId,
              hash: transactionHash(tx, companyId, account.accountNumber),
              uniqueId: transactionUniqueId(
                tx,
                companyId,
                account.accountNumber,
              ),
            });
          } catch (error) {
            sendError(
              error,
              `Failed to process transaction for ${companyId} account ${account.accountNumber}:\n${JSON.stringify(tx, null, 2)}`,
            );
          }
        }
      }
    }
  }

  return txns;
}
```

- [ ] **Step 2: Run all tests to make sure nothing broke**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/storage/index.ts
git commit -m "refactor: export resultsToTransactions, remove FirestoreStorage from local storages array"
```

---

## Task 3: Build TypeScript and sync to `functions/dst`

`functions/dst` is a separate directory (not a symlink) that must be kept in sync with the compiled `dst` output.

- [ ] **Step 1: Build and sync**

```bash
npm run build && rsync -a --delete dst/ functions/dst/
```

Expected: No errors. `functions/dst/bot/storage/firestore.js` should contain the updated class with `constructor(uid)`.

- [ ] **Step 2: Verify the compiled output**

```bash
grep -n "this.uid\|users/" functions/dst/bot/storage/firestore.js | head -5
```

Expected output (approximately):
```
N:        this.uid = uid;
N:        const collection = `users/${this.uid}/transactions`;
```

- [ ] **Step 3: Commit**

```bash
git add functions/dst
git commit -m "build: sync compiled output to functions/dst"
```

---

## Task 4: Rewrite `functions/index.js`

**Files:**
- Rewrite: `moneyman/functions/index.js`

This is the largest change. The entire file is replaced with a new architecture. Replace the full contents of `functions/index.js`:

- [ ] **Step 1: Write the new `functions/index.js`**

```javascript
import { randomUUID } from 'crypto';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import chromium from '@sparticuz/chromium';

if (!getApps().length) initializeApp();

// Error types that indicate a scraper needs re-authentication via the extension flow
const AUTH_FAILURE_ERRORS = [
  'InvalidPassword',
  'ChangePasswordError',
  'AccountBlocked',
  'TWO_FACTOR_RETRIEVER_MISSING',
];

// ── Per-user scrape runner ────────────────────────────────────────────────────

async function runMoneymanForUser(uid) {
  console.log(`[${uid}] Starting scrape`);
  const db = getFirestore();
  const runId = randomUUID();
  const runRef = db.doc(`users/${uid}/moneyman/config/runs/${runId}`);

  // Chromium must be configured before the scraper imports browser.js
  process.env.PUPPETEER_EXECUTABLE_PATH = await chromium.executablePath();

  // Read user's moneyman config from Firestore
  const configDoc = await db.doc(`users/${uid}/moneyman/config`).get();
  if (!configDoc.exists) throw new Error(`No moneyman config for user ${uid}`);
  const configData = configDoc.data();
  const accounts = configData.accounts ?? [];

  // Load saved scraper sessions (e.g. cookies) and register onCookieSaved callbacks
  const patchedAccounts = await Promise.all(
    accounts.map(async (account) => {
      const sessionDoc = await db.doc(`users/${uid}/scrapers/${account.companyId}`).get();
      if (!sessionDoc.exists) return account;
      const session = sessionDoc.data();
      const patched = { ...account };
      if (session.cookie) patched.cookie = session.cookie;
      patched.onCookieSaved = async (newCookie) => {
        await db.doc(`users/${uid}/scrapers/${account.companyId}`).set(
          { cookie: newCookie, cookieSavedAt: FieldValue.serverTimestamp(), status: 'connected' },
          { merge: true },
        );
        console.log(`[${uid}] Saved new session cookie for ${account.companyId}`);
      };
      return patched;
    }),
  );

  // Create run document (replaces Telegram "Starting..." message)
  await runRef.set({ status: 'running', startedAt: FieldValue.serverTimestamp() });

  // Build ScraperConfig directly from Firestore data.
  // Do NOT use the scraperConfig module (it reads MONEYMAN_CONFIG at import time
  // and is cached — unusable in a multi-user context).
  const daysBack = configData.options?.scraping?.daysBack ?? 90;
  const scraperConfig = {
    accounts: patchedAccounts,
    startDate: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000),
    parallelScrapers: configData.options?.scraping?.maxParallelScrapers ?? 1,
    futureMonthsToScrape: configData.options?.scraping?.futureMonths ?? 1,
    additionalTransactionInformation: configData.options?.scraping?.additionalTransactionInfo ?? false,
    includeRawTransaction: false,
  };

  // Dynamic imports are cached per-invocation (each Cloud Function invocation is
  // its own process, so there is no cross-user cache pollution).
  const { scrapeAccounts } = await import('./dst/scraper/index.js');
  const { FirestoreStorage } = await import('./dst/bot/storage/firestore.js');
  const { resultsToTransactions } = await import('./dst/bot/storage/index.js');

  const storage = new FirestoreStorage(uid);

  let results;
  try {
    results = await scrapeAccounts(
      scraperConfig,
      async (status, totalTime) => {
        const line = status.join(' | ');
        console.log(`[${uid}] ${totalTime ? `Done in ${totalTime.toFixed(1)}s` : line}`);
      },
      (e, caller) => {
        console.error(`[${uid}] scraper error [${caller}]:`, e?.message);
      },
    );
  } catch (e) {
    console.error(`[${uid}] scrapeAccounts threw:`, e?.message);
    await runRef.update({
      status: 'failed',
      completedAt: FieldValue.serverTimestamp(),
      error: String(e?.message ?? e),
    });
    throw e;
  }

  // Save transactions to users/{uid}/transactions/{hash}
  const txns = resultsToTransactions(results);
  if (txns.length > 0) {
    await storage.saveTransactions(txns, async (msg) => {
      console.log(`[${uid}] storage: ${msg}`);
    });
  }

  // Build per-account summary for run document
  const accountSummary = results.map((r) => ({
    companyId: r.companyId,
    success: r.result.success,
    txnCount: r.result.accounts?.reduce((sum, a) => sum + (a.txns?.length ?? 0), 0) ?? 0,
    ...(r.result.errorType ? { errorType: r.result.errorType } : {}),
  }));

  // Update run document (replaces Telegram summary message)
  await runRef.update({
    status: 'done',
    completedAt: FieldValue.serverTimestamp(),
    txnCount: txns.length,
    accounts: accountSummary,
  });

  // Create re-auth jobs for scrapers that use session-based auth and failed
  for (const r of results) {
    if (!r.result.success && AUTH_FAILURE_ERRORS.includes(r.result.errorType)) {
      const account = patchedAccounts.find((a) => a.companyId === r.companyId);
      if (account?.cookie !== undefined) {
        // This scraper uses session/cookie auth — create a job for the extension
        await db.collection(`users/${uid}/jobs`).add({
          type: 'auth',
          scraper: r.companyId,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
        });
        await db.doc(`users/${uid}/scrapers/${r.companyId}`).set(
          { status: 'expired' },
          { merge: true },
        );
        console.log(`[${uid}] Created re-auth job for ${r.companyId}`);
      }
    }
  }

  console.log(`[${uid}] Scrape complete. ${txns.length} transactions saved.`);
}

// ── Cloud Function exports ────────────────────────────────────────────────────

// Scheduled: discover all moneyman users and fan out a scrapeRequest per user.
// Each scrapeRequest triggers runMoneymanOnRequest independently.
export const runMoneymanScheduled = onSchedule(
  {
    schedule: '0 0 * * *', // daily at midnight UTC
    memory: '512MiB',
    timeoutSeconds: 60,
    region: 'me-west1',
  },
  async () => {
    const db = getFirestore();
    // Collection group query finds all documents in any 'moneyman' subcollection.
    // Filter in code to those with document ID 'config' (i.e. the config docs, not scrapeRequest).
    const snapshot = await db.collectionGroup('moneyman').get();
    const configDocs = snapshot.docs.filter((doc) => doc.id === 'config');

    console.log(`Fan-out: found ${configDocs.length} moneyman user(s)`);

    for (const configDoc of configDocs) {
      // Path format: users/{uid}/moneyman/config → uid is path segment at index 1
      const uid = configDoc.ref.path.split('/')[1];
      await db.doc(`users/${uid}/moneyman/scrapeRequest`).set({
        status: 'pending',
        requestedAt: FieldValue.serverTimestamp(),
        triggeredBy: 'schedule',
      });
      console.log(`Fan-out: created scrapeRequest for ${uid}`);
    }
  },
);

// Firestore trigger: fires for any user's scrapeRequest (wildcard {uid}).
// Each invocation is fully isolated — separate process, memory, and timeout.
export const runMoneymanOnRequest = onDocumentWritten(
  {
    document: 'users/{uid}/moneyman/scrapeRequest',
    region: 'me-west1',
    memory: '4GiB',
    timeoutSeconds: 540,
    maxInstances: 5,
  },
  async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after;
    if (!after?.exists) return;
    if (after.data().status !== 'pending') return;

    const db = getFirestore();
    await db.doc(`users/${uid}/moneyman/scrapeRequest`).update({
      status: 'running',
      startedAt: FieldValue.serverTimestamp(),
    });

    try {
      await runMoneymanForUser(uid);
      await db.doc(`users/${uid}/moneyman/scrapeRequest`).update({
        status: 'done',
        completedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error(`[${uid}] runMoneymanForUser failed:`, e);
      await db.doc(`users/${uid}/moneyman/scrapeRequest`).update({
        status: 'failed',
        error: String(e?.message ?? e),
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  },
);

// HTTP: admin-only debug trigger. Writes a scrapeRequest for the given uid,
// which triggers runMoneymanOnRequest. Auth guard requires the owner's Firebase ID token.
export const runMoneymanHttp = onRequest(
  {
    memory: '256MiB',
    timeoutSeconds: 60,
    region: 'me-west1',
    maxInstances: 1,
  },
  async (req, res) => {
    // Auth guard — must be first
    const authHeader = req.headers.authorization ?? '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) { res.status(401).send('Unauthorized'); return; }
    if (!process.env.OWNER_UID) {
      console.error('OWNER_UID environment variable is not set');
      res.status(500).send('Internal Server Error');
      return;
    }
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      if (decoded.uid !== process.env.OWNER_UID) { res.status(403).send('Forbidden'); return; }
    } catch (e) {
      console.warn('verifyIdToken failed:', e?.code ?? e?.message);
      res.status(401).send('Unauthorized');
      return;
    }

    const uid = req.body?.uid ?? process.env.OWNER_UID;
    const db = getFirestore();
    await db.doc(`users/${uid}/moneyman/scrapeRequest`).set({
      status: 'pending',
      requestedAt: FieldValue.serverTimestamp(),
      triggeredBy: 'http',
    });
    res.send(`OK — scrapeRequest created for ${uid}`);
  },
);
```

- [ ] **Step 2: Commit**

```bash
git add functions/index.js
git commit -m "feat: rewrite Cloud Function for multi-tenant per-user scraping"
```

---

## Task 5: Update Firestore security rules (stocky repo)

**Files:**
- Modify: `stocky/firestore.rules`

All work from here is done from the `stocky` repo root.

- [ ] **Step 1: Update `firestore.rules`**

In `firestore.rules`, find and replace the two hardcoded-UID moneyman rules at the bottom of the file:

```
// REMOVE these two rules entirely:
match /moneyman/config {
  allow read, write: if request.auth.uid == "imQfcMe7UtNAN2XFSWpe0vP1il42";
}
match /moneyman/scrapeRequest {
  allow read, write: if request.auth.uid == "imQfcMe7UtNAN2XFSWpe0vP1il42";
}
```

Add the following inside the `match /databases/{database}/documents {` block, alongside the other `users/{uid}` rules:

```
// Moneyman — per-user, approved users only
match /users/{uid}/moneyman/{document=**} {
  allow read, write: if isApproved() && request.auth.uid == uid;
}
match /users/{uid}/transactions/{txId} {
  allow read, write: if isApproved() && request.auth.uid == uid;
}
```

The `{document=**}` recursive wildcard covers `config`, `scrapeRequest`, and the `config/runs/{runId}` subcollection.

- [ ] **Step 2: Validate rules locally**

```bash
firebase emulators:start --only firestore &
sleep 5
firebase firestore:rules:validate firestore.rules 2>/dev/null || echo "validate not available — check Firebase console after deploy"
kill %1
```

- [ ] **Step 3: Deploy rules**

```bash
firebase deploy --only firestore:rules
```

Expected: `Deploy complete!`

- [ ] **Step 4: Commit**

```bash
git add firestore.rules
git commit -m "feat: replace hardcoded-UID moneyman rules with per-user isApproved() rules"
```

---

## Task 6: Update `BankConnections.tsx`

**Files:**
- Modify: `stocky/frontend/src/components/connections/BankConnections.tsx`

- [ ] **Step 1: Update all Firestore paths and add latest run + next scheduled run**

Replace the full contents of `frontend/src/components/connections/BankConnections.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot, addDoc, collection, serverTimestamp, updateDoc, setDoc, query, orderBy, limit } from 'firebase/firestore'
import { db } from '../../firebase'
import { useAuth } from '../../context/AuthContext'
import { Wifi, WifiOff, AlertTriangle, Loader2, Plus, Pencil, Trash2, Clock } from 'lucide-react'
import AccountModal from './AccountModal'
import { BANK_DEFS, type AccountConfig } from './bankFields'

type CibusStatus = 'not_connected' | 'connected' | 'expired' | 'connecting'
type ScrapeStatus = 'idle' | 'running' | 'done' | 'failed'

type LatestRun = {
  status: 'running' | 'done' | 'failed'
  startedAt?: { toDate: () => Date }
  completedAt?: { toDate: () => Date }
  txnCount?: number
  accounts?: Array<{ companyId: string; success: boolean; txnCount: number; errorType?: string }>
}

const EXTENSION_STALE_MS = 90 * 1000

function getNextMidnightUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

export default function BankConnections() {
  const { user } = useAuth()

  // Cibus auth state
  const [cibusStatus, setCibusStatus] = useState<CibusStatus>('not_connected')
  const [cookieSavedAt, setCookieSavedAt] = useState<string | null>(null)
  const [extensionLastSeen, setExtensionLastSeen] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [showExtensionWarning, setShowExtensionWarning] = useState(false)
  const unsubJobRef = useRef<(() => void) | null>(null)

  // Accounts state
  const [accounts, setAccounts] = useState<AccountConfig[]>([])
  const [modalAccount, setModalAccount] = useState<AccountConfig | undefined>(undefined)
  const [modalOpen, setModalOpen] = useState(false)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [scrapeStatus, setScrapeStatus] = useState<ScrapeStatus>('idle')
  const [latestRun, setLatestRun] = useState<LatestRun | null>(null)

  useEffect(() => {
    if (!user) return

    const scraperRef = doc(db, `users/${user.uid}/scrapers/cibus`)
    const unsubScraper = onSnapshot(scraperRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data()
        setCibusStatus(data.status as CibusStatus)
        setCookieSavedAt(data.cookieSavedAt ?? null)
      }
    })

    const extRef = doc(db, `users/${user.uid}/extension/status`)
    const unsubExt = onSnapshot(extRef, (snap) => {
      if (snap.exists()) setExtensionLastSeen(snap.data().lastSeen ?? null)
    })

    const configRef = doc(db, `users/${user.uid}/moneyman/config`)
    const unsubConfig = onSnapshot(configRef, (snap) => {
      if (snap.exists()) setAccounts(snap.data().accounts ?? [])
    })

    const scrapeReqRef = doc(db, `users/${user.uid}/moneyman/scrapeRequest`)
    const unsubScrapeReq = onSnapshot(scrapeReqRef, (snap) => {
      if (!snap.exists()) return
      const s = snap.data().status
      if (s === 'pending' || s === 'running') setScrapeStatus('running')
      else if (s === 'done') setScrapeStatus('done')
      else if (s === 'failed') setScrapeStatus('failed')
    })

    // Latest run from runs subcollection
    const runsQuery = query(
      collection(db, `users/${user.uid}/moneyman/config/runs`),
      orderBy('startedAt', 'desc'),
      limit(1),
    )
    const unsubRuns = onSnapshot(runsQuery, (snapshot) => {
      if (!snapshot.empty) setLatestRun(snapshot.docs[0].data() as LatestRun)
    })

    return () => {
      unsubScraper()
      unsubExt()
      unsubConfig()
      unsubScrapeReq()
      unsubRuns()
      unsubJobRef.current?.()
    }
  }, [user])

  async function handleConnect() {
    if (!user) return
    if (extensionLastSeen) {
      const isExtensionAlive = Date.now() - new Date(extensionLastSeen).getTime() < EXTENSION_STALE_MS
      if (!isExtensionAlive) { setShowExtensionWarning(true); return }
    }
    setShowExtensionWarning(false)
    setConnecting(true)
    setJobStatus('pending')
    const jobRef = await addDoc(collection(db, `users/${user.uid}/jobs`), {
      type: 'auth', scraper: 'cibus', status: 'pending', createdAt: serverTimestamp(),
    })
    const EXTENSION_ID = 'ibbhaaciijecgkmeglpipnpdbopkffmk'
    ;(window as any).chrome?.runtime?.sendMessage(EXTENSION_ID, { type: 'poll' })
    unsubJobRef.current = onSnapshot(doc(db, `users/${user.uid}/jobs/${jobRef.id}`), (snap) => {
      if (!snap.exists()) return
      const status = snap.data().status
      setJobStatus(status)
      if (status === 'done' || status === 'failed') {
        setConnecting(false)
        unsubJobRef.current?.()
        unsubJobRef.current = null
      }
    })
  }

  async function handleDisconnect() {
    if (!user) return
    await updateDoc(doc(db, `users/${user.uid}/scrapers/cibus`), { status: 'not_connected' })
  }

  async function handleSaveAccount(account: AccountConfig) {
    const updated = accounts.some(a => a.companyId === account.companyId)
      ? accounts.map(a => a.companyId === account.companyId ? account : a)
      : [...accounts, account]
    try {
      // setDoc with merge:true works for both new users (no config doc yet) and existing users
      await setDoc(doc(db, `users/${user!.uid}/moneyman/config`), { accounts: updated }, { merge: true })
      setModalOpen(false)
      setModalAccount(undefined)
      setSaveError(null)
    } catch {
      setSaveError('Failed to save — try again')
    }
  }

  async function handleRemoveAccount(companyId: string) {
    const updated = accounts.filter(a => a.companyId !== companyId)
    try {
      await setDoc(doc(db, `users/${user!.uid}/moneyman/config`), { accounts: updated }, { merge: true })
      setConfirmRemoveId(null)
      setSaveError(null)
    } catch {
      setSaveError('Failed to remove — try again')
    }
  }

  async function handleRunScrape() {
    if (!user) return
    await setDoc(doc(db, `users/${user.uid}/moneyman/scrapeRequest`), {
      status: 'pending',
      requestedAt: serverTimestamp(),
    })
  }

  const statusLabel = {
    not_connected: 'Not connected',
    connected: `Connected${cookieSavedAt ? ` · last auth ${new Date(cookieSavedAt).toLocaleDateString()}` : ''}`,
    expired: 'Session expired — re-authenticate',
    connecting: 'Connecting…',
  }[cibusStatus] ?? 'Unknown'

  const StatusIcon = cibusStatus === 'connected' ? Wifi : cibusStatus === 'connecting' ? Loader2 : WifiOff

  const nextRun = getNextMidnightUTC()

  return (
    <div className="bg-white shadow rounded-lg p-6 space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">Bank Connections</h2>

      {/* Cibus auth card */}
      <div className="border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-full ${cibusStatus === 'connected' ? 'bg-green-100' : 'bg-gray-100'}`}>
              <StatusIcon
                size={20}
                className={`${cibusStatus === 'connected' ? 'text-green-600' : cibusStatus === 'expired' ? 'text-amber-500' : 'text-gray-400'} ${cibusStatus === 'connecting' ? 'animate-spin' : ''}`}
              />
            </div>
            <div>
              <div className="font-medium text-gray-900">Cibus / Pluxee</div>
              <div className={`text-sm ${cibusStatus === 'connected' ? 'text-green-600' : cibusStatus === 'expired' ? 'text-amber-500' : 'text-gray-500'}`}>
                {connecting ? (jobStatus === 'running' ? 'Opening Pluxee — enter OTP in the tab that opens…' : 'Waiting for extension…') : statusLabel}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            {cibusStatus !== 'connected' ? (
              <button onClick={handleConnect} disabled={connecting}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {connecting ? 'Connecting…' : cibusStatus === 'expired' ? 'Re-authenticate' : 'Connect Cibus'}
              </button>
            ) : (
              <button onClick={handleDisconnect}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">
                Disconnect
              </button>
            )}
          </div>
        </div>
        {showExtensionWarning && (
          <div className="mt-3 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-md">
            <AlertTriangle size={16} className="text-amber-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-amber-700">
              Extension not found — make sure the Moneyman Auth Bridge extension is installed and Chrome is open.
              <a href="chrome://extensions/" className="ml-1 underline">Open extensions page</a>
            </p>
          </div>
        )}
        {jobStatus === 'failed' && (
          <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-700">Authentication failed. Check the extension logs and try again.</p>
          </div>
        )}
      </div>

      {/* Accounts list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Accounts</h3>
          <button
            onClick={() => { setModalAccount(undefined); setModalOpen(true) }}
            className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            <Plus size={14} /> Add Account
          </button>
        </div>

        {accounts.length === 0 ? (
          <p className="text-sm text-gray-500">No accounts configured.</p>
        ) : (
          <ul className="space-y-2">
            {accounts.map(account => {
              const bankDef = BANK_DEFS[account.companyId]
              const identityField = bankDef?.fields.find(f => f !== 'password')
              const identityValue = identityField ? account[identityField] : ''
              return (
                <li key={account.companyId} className="flex items-center justify-between border border-gray-200 rounded-lg px-4 py-3">
                  <div>
                    <div className="font-medium text-gray-900 text-sm">{bankDef?.name ?? account.companyId}</div>
                    <div className="text-xs text-gray-500">{identityValue} / ••••••••</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {confirmRemoveId === account.companyId ? (
                      <>
                        <span className="text-xs text-gray-600">Remove?</span>
                        <button onClick={() => handleRemoveAccount(account.companyId)}
                          className="px-2 py-1 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700">Yes</button>
                        <button onClick={() => setConfirmRemoveId(null)}
                          className="px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => { setModalAccount(account); setModalOpen(true) }}
                          className="p-1.5 text-gray-400 hover:text-blue-600 rounded"
                          aria-label="Edit"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => setConfirmRemoveId(account.companyId)}
                          className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                          aria-label="Remove"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {saveError && <p className="text-sm text-red-600 mt-2">{saveError}</p>}
      </div>

      {/* Scrape trigger + run info */}
      <div className="space-y-3 pt-2 border-t border-gray-100">
        <div className="flex items-center gap-4">
          <button
            onClick={handleRunScrape}
            disabled={scrapeStatus === 'running'}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {scrapeStatus === 'running' ? 'Scraping…' : 'Run Scrape'}
          </button>
          {scrapeStatus === 'done' && <span className="text-sm text-green-600">Done ✓</span>}
          {scrapeStatus === 'failed' && <span className="text-sm text-red-600">Failed — check run log for details</span>}
        </div>

        {/* Latest run summary */}
        {latestRun && (
          <div className="text-sm text-gray-500">
            {latestRun.status === 'done' && latestRun.completedAt && (
              <span>Last run: {latestRun.completedAt.toDate().toLocaleString()} · {latestRun.txnCount ?? 0} transactions</span>
            )}
            {latestRun.status === 'failed' && (
              <span className="text-red-500">Last run failed</span>
            )}
            {latestRun.status === 'running' && (
              <span className="text-blue-500">Scraping in progress…</span>
            )}
          </div>
        )}

        {/* Next scheduled run */}
        <div className="flex items-center gap-1.5 text-sm text-gray-400">
          <Clock size={13} />
          <span>Next scheduled run: {nextRun.toLocaleString()}</span>
        </div>
      </div>

      {modalOpen && (
        <AccountModal
          account={modalAccount}
          onSave={handleSaveAccount}
          onClose={() => { setModalOpen(false); setModalAccount(undefined) }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build the frontend to check for TypeScript errors**

```bash
cd frontend && npm run build
```

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/connections/BankConnections.tsx
git commit -m "feat: update BankConnections to per-user Firestore paths, add run info and next scheduled run"
```

---

## Task 7: Write and run migration script

**Files:**
- Create: `moneyman/scripts/migrate-to-per-user.mjs`

All work from the `moneyman` repo root.

- [ ] **Step 1: Create the migration script**

Create `scripts/migrate-to-per-user.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the migration**

```bash
GOOGLE_APPLICATION_CREDENTIALS=~/.config/gcloud/application_default_credentials.json node scripts/migrate-to-per-user.mjs
```

Expected output:
```
Migrating data for owner uid: <your-uid>
✓ Copied moneyman/config → users/{uid}/moneyman/config
Migrating N transactions…
✓ Migrated N transactions → users/<uid>/transactions
Migration complete.
Old global documents ... are preserved.
```

- [ ] **Step 3: Verify in Firebase console**

Open the Firebase console → Firestore → check that:
- `users/{uid}/moneyman/config` exists with your bank accounts
- `users/{uid}/transactions` collection has your historical transactions

- [ ] **Step 4: Commit the migration script**

```bash
git add scripts/migrate-to-per-user.mjs
git commit -m "chore: add one-time migration script for per-user moneyman data"
```

---

## Task 8: Deploy Cloud Functions and verify end-to-end

- [ ] **Step 1: Deploy Cloud Functions from the moneyman repo**

```bash
firebase deploy --only functions
```

Expected: All three functions (`runMoneymanScheduled`, `runMoneymanOnRequest`, `runMoneymanHttp`) deploy successfully.

- [ ] **Step 2: Trigger a manual scrape via the Stocky UI**

Open Stocky in the browser, go to Bank Connections, click "Run Scrape". Verify:
- `scrapeStatus` changes to `running` then `done` in the UI
- `users/{uid}/moneyman/scrapeRequest` shows `status: done` in Firebase console
- `users/{uid}/moneyman/config/runs/{runId}` doc exists with `status: done`, `txnCount > 0`
- `users/{uid}/transactions` collection has new documents

- [ ] **Step 3: Verify "Next scheduled run" shows in UI**

The accounts page should show a clock icon and "Next scheduled run: [tomorrow midnight local time]".

- [ ] **Step 4: (Optional) Delete old global documents**

Once verified, clean up:
```bash
# In Firebase console or via script — delete:
# - moneyman/config
# - moneyman/scrapeRequest
# - moneymanTransactions/* (all documents)
```
