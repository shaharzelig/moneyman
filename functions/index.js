import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import chromium from '@sparticuz/chromium';

if (!getApps().length) {
  initializeApp();
}

async function runMoneyman() {
  console.log('[1] Setting chromium executable path');
  process.env.PUPPETEER_EXECUTABLE_PATH = await chromium.executablePath();

  const db = getFirestore();

  console.log('[2] Loading config from Firestore');
  const configDoc = await db.doc('moneyman/config').get();
  if (!configDoc.exists) {
    throw new Error('Firestore document moneyman/config not found.');
  }
  const configData = configDoc.data();
  const uid = configData.uid;
  if (!uid) {
    throw new Error('moneyman/config is missing the "uid" field. Add your Firebase UID.');
  }
  process.env.MONEYMAN_CONFIG = JSON.stringify(configData);
  console.log('[2] MONEYMAN_CONFIG set, uid:', uid, 'accounts:', configData.accounts?.map(a => a.companyId));

  console.log('[3] Loading cibus session cookie from users/{uid}/scrapers/cibus');
  const cibusDoc = await db.doc(`users/${uid}/scrapers/cibus`).get();
  const savedCookie = cibusDoc.exists ? cibusDoc.data().cookie : null;
  const cibusStatus = cibusDoc.exists ? cibusDoc.data().status : 'not_connected';
  console.log('[3] cibus status:', cibusStatus, '| cookie:', savedCookie ? 'found' : 'not found');

  console.log('[4] Dynamically importing moneyman modules');
  const { scraperConfig } = await import('./dst/config.js');
  const { runWithStorage } = await import('./dst/bot/index.js');
  const { scrapeAccounts } = await import('./dst/scraper/index.js');
  const { sendFailureScreenShots } = await import('./dst/utils/failureScreenshot.js');

  console.log('[5] Patching cibus account credentials');
  const cibusAccount = scraperConfig.accounts.find(a => a.companyId === 'cibus');
  if (cibusAccount) {
    if (savedCookie) {
      cibusAccount.cookie = savedCookie;
      console.log('[5] Loaded saved cibus session cookie');
    } else {
      console.log('[5] No cibus session cookie — will attempt credential login (likely to fail on cloud IP)');
    }
    cibusAccount.onCookieSaved = async (newCookie) => {
      await db.doc(`users/${uid}/scrapers/cibus`).set({
        cookie: newCookie,
        cookieSavedAt: FieldValue.serverTimestamp(),
        status: 'connected',
      }, { merge: true });
      console.log('[5] Saved new cibus session cookie to Firestore');
    };
    // No otpCodeRetriever — cookie-based auth is the only cloud-compatible flow
  }

  console.log('[6] Running scraper via runWithStorage');
  let cibusAuthFailed = false;
  await runWithStorage(async (hooks) => {
    try {
      await hooks.onBeforeStart();
      const results = await scrapeAccounts(
        scraperConfig,
        async (status, totalTime) => hooks.onStatusChanged(status, totalTime),
        (e, caller) => {
          console.error('[6] scraper onError:', caller, e?.message);
          if (caller === 'cibus' || e?.message?.includes('cibus') || e?.errorType === 'InvalidPassword') {
            cibusAuthFailed = true;
          }
          hooks.onError(e, caller);
        },
      );
      console.log('[6] scrapeAccounts done:', JSON.stringify(results?.map(r => ({
        companyId: r.companyId, success: r.result?.success, errorType: r.result?.errorType,
      }))));

      // Check if Cibus specifically failed with auth error
      const cibusResult = results?.find(r => r.companyId === 'cibus');
      if (cibusResult && !cibusResult.result?.success) {
        const errorType = cibusResult.result?.errorType;
        if (['InvalidPassword', 'ChangePasswordError', 'AccountBlocked', 'TWO_FACTOR_RETRIEVER_MISSING'].includes(errorType)) {
          cibusAuthFailed = true;
        }
      }

      await Promise.all([
        hooks.onResultsReady(results),
        sendFailureScreenShots(hooks.failureScreenshotsHandler),
      ]);
    } catch (e) {
      console.error('[6] runMoneyman catch:', e?.message);
      await hooks.onError(e, 'runMoneyman');
    }
  });

  // If Cibus auth failed, create a job for the extension and notify user
  if (cibusAuthFailed) {
    console.log('[7] Cibus auth failed — creating extension auth job');
    await db.collection(`users/${uid}/jobs`).add({
      type: 'auth',
      scraper: 'cibus',
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    });
    await db.doc(`users/${uid}/scrapers/cibus`).set(
      { status: 'expired' },
      { merge: true }
    );
    console.log('[7] Auth job created. User should open Stocky to re-authenticate.');
  }

  console.log('[8] runWithStorage complete');
}

export const runMoneymanScheduled = onSchedule(
  {
    schedule: 'every 24 hours',
    memory: '4GiB',
    timeoutSeconds: 540,
    region: 'me-west1',
  },
  runMoneyman,
);

export const runMoneymanHttp = onRequest(
  {
    memory: '4GiB',
    timeoutSeconds: 540,
    region: 'me-west1',
  },
  async (req, res) => {
    try {
      await runMoneyman();
      res.send('OK');
    } catch (e) {
      console.error('runMoneyman failed:', e);
      res.status(500).send(String(e));
    }
  },
);
