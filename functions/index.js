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

async function runMoneymanForUser(uid, { daysBackOverride } = {}) {
  console.log(`[${uid}] Starting scrape`);
  const db = getFirestore();
  const runId = randomUUID();
  const runRef = db.doc(`users/${uid}/moneyman/config/runs/${runId}`);
  const startTime = Date.now();
  const logs = [];

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
      const patched = { ...account };
      if (sessionDoc.exists) {
        const session = sessionDoc.data();
        if (session.cookie) patched.cookie = session.cookie;
      }
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

  // Enforce 20-run cap: delete oldest if already at 20
  const existingRuns = await db
    .collection(`users/${uid}/moneyman/config/runs`)
    .orderBy('startedAt', 'desc')
    .limit(21)
    .get();
  if (existingRuns.size >= 20) {
    await Promise.all(existingRuns.docs.slice(19).map(doc => doc.ref.delete()));
  }

  // Create run document
  await runRef.set({ status: 'running', startedAt: FieldValue.serverTimestamp() });

  const daysBack = daysBackOverride ?? configData.options?.scraping?.daysBack ?? 90;
  logs.push(`Starting scrape for ${patchedAccounts.length} account(s)`);

  const scraperConfig = {
    accounts: patchedAccounts,
    startDate: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000),
    parallelScrapers: configData.options?.scraping?.maxParallelScrapers ?? 1,
    futureMonthsToScrape: configData.options?.scraping?.futureMonths ?? 1,
    additionalTransactionInformation: configData.options?.scraping?.additionalTransactionInfo ?? false,
    includeRawTransaction: false,
  };

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
    const msg = String(e?.message ?? e);
    logs.push(`scrapeAccounts failed: ${msg}`);
    console.error(`[${uid}] scrapeAccounts threw:`, e?.message);
    await runRef.update({
      status: 'failed',
      completedAt: FieldValue.serverTimestamp(),
      error: msg,
      logs,
    });
    throw e;
  }

  // Log per-account results
  for (const r of results) {
    if (r.result.success) {
      const txnCount = r.result.accounts?.reduce((sum, a) => sum + (a.txns?.length ?? 0), 0) ?? 0;
      logs.push(`[${r.companyId}] OK — ${txnCount} transactions`);
    } else {
      const detail = r.result.errorMessage ? `: ${r.result.errorMessage}` : '';
      logs.push(`[${r.companyId}] FAILED — ${r.result.errorType ?? 'unknown'}${detail}`);
    }
  }

  // Save transactions to users/{uid}/transactions/{hash}
  const txns = resultsToTransactions(results);
  let saveStats = null;
  if (txns.length > 0) {
    try {
      saveStats = await storage.saveTransactions(txns, async (msg) => {
        console.log(`[${uid}] storage: ${msg}`);
      });
      logs.push(`Saved ${txns.length} transactions (${saveStats?.added ?? 0} new, ${saveStats?.existing ?? 0} existing)`);
    } catch (e) {
      const msg = `saveTransactions: ${String(e?.message ?? e)}`;
      logs.push(msg);
      console.error(`[${uid}] saveTransactions failed:`, e?.message);
      await runRef.update({
        status: 'failed',
        completedAt: FieldValue.serverTimestamp(),
        error: msg,
        logs,
      });
      throw e;
    }
  } else {
    logs.push('No transactions to save');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logs.push(`Done in ${elapsed}s`);

  // Build per-account summary
  const accountSummary = results.map((r) => ({
    companyId: r.companyId,
    success: r.result.success,
    txnCount: r.result.accounts?.reduce((sum, a) => sum + (a.txns?.length ?? 0), 0) ?? 0,
    ...(r.result.errorType ? { errorType: r.result.errorType } : {}),
    ...(r.result.errorMessage ? { errorMessage: r.result.errorMessage } : {}),
  }));

  await runRef.update({
    status: 'done',
    completedAt: FieldValue.serverTimestamp(),
    txnCount: txns.length,
    accounts: accountSummary,
    logs,
  });

  // Create re-auth jobs for scrapers that use session-based auth and failed
  for (const r of results) {
    if (!r.result.success && AUTH_FAILURE_ERRORS.includes(r.result.errorType)) {
      const account = patchedAccounts.find((a) => a.companyId === r.companyId);
      if (account?.cookie !== undefined) {
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
      const scrapeRef = db.doc(`users/${uid}/moneyman/scrapeRequest`);
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(scrapeRef);
        if (existing.exists) {
          const status = existing.data().status;
          if (status === 'pending' || status === 'running') {
            console.log(`[${uid}] Skipping fan-out — scrapeRequest already ${status}`);
            return;
          }
        }
        tx.set(scrapeRef, {
          status: 'pending',
          requestedAt: FieldValue.serverTimestamp(),
          triggeredBy: 'schedule',
        });
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
      await runMoneymanForUser(uid, { daysBackOverride: after.data().daysBack });
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
