import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import chromium from '@sparticuz/chromium';
import { readFileSync } from 'fs';

async function telegramOtpRetriever(apiKey, chatId) {
  const baseUrl = `https://api.telegram.org/bot${apiKey}`;

  // Send OTP request message
  await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: '🔐 Cibus OTP required. Please reply with the code you received via SMS.' }),
  });

  // Get current update offset so we only read new messages
  const offsetRes = await fetch(`${baseUrl}/getUpdates?limit=1&offset=-1`);
  const offsetData = await offsetRes.json();
  let offset = offsetData.result?.length ? offsetData.result[0].update_id + 1 : 0;

  // Poll for reply (up to 4 minutes)
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/getUpdates?offset=${offset}&timeout=20&allowed_updates=["message"]`);
    const data = await res.json();
    for (const update of (data.result || [])) {
      offset = update.update_id + 1;
      const text = update.message?.text?.trim();
      const fromChatId = String(update.message?.chat?.id);
      if (fromChatId === String(chatId) && /^\d{4,8}$/.test(text)) {
        console.log('Received OTP from Telegram');
        return text;
      }
    }
  }
  throw new Error('OTP timeout: no code received within 4 minutes');
}

if (!getApps().length) {
  initializeApp();
}

async function runMoneyman() {
  console.log('[1] Setting chromium executable path');
  process.env.PUPPETEER_EXECUTABLE_PATH = await chromium.executablePath();
  console.log('[1] PUPPETEER_EXECUTABLE_PATH =', process.env.PUPPETEER_EXECUTABLE_PATH);

  const db = getFirestore();

  console.log('[2] Loading config from Firestore');
  const configDoc = await db.doc('moneyman/config').get();
  if (!configDoc.exists) {
    throw new Error('Firestore document moneyman/config not found. Create it with your moneyman config JSON.');
  }
  process.env.MONEYMAN_CONFIG = JSON.stringify(configDoc.data());
  console.log('[2] MONEYMAN_CONFIG set, accounts:', configDoc.data().accounts?.map(a => a.companyId));

  console.log('[3] Loading cibus session cookie');
  const sessionDoc = await db.doc('moneyman/cibus_session').get();
  const savedCookie = sessionDoc.exists ? sessionDoc.data().cookie : null;
  console.log('[3] savedCookie:', savedCookie ? 'found' : 'not found');

  try {
    const cibusJs = readFileSync(new URL('./node_modules/israeli-bank-scrapers/lib/scrapers/cibus.js', import.meta.url), 'utf8');
    const m = cibusJs.match(/waitForSelector\(["']([^"']+)["']/);
    console.log('[DEBUG] cibus isOtpRequired selector in deployed code:', m?.[1] ?? 'NOT FOUND');
  } catch (e) {
    console.log('[DEBUG] could not read cibus.js:', e.message);
  }

  console.log('[4] Dynamically importing moneyman modules');
  const { scraperConfig } = await import('./dst/config.js');
  const { runWithStorage } = await import('./dst/bot/index.js');
  const { scrapeAccounts } = await import('./dst/scraper/index.js');
  const { sendFailureScreenShots } = await import('./dst/utils/failureScreenshot.js');
  console.log('[4] accounts in scraperConfig:', scraperConfig.accounts.map(a => a.companyId));

  console.log('[5] Patching cibus account credentials');
  const cibusAccount = scraperConfig.accounts.find(a => a.companyId === 'cibus');
  if (cibusAccount) {
    if (savedCookie) {
      cibusAccount.cookie = savedCookie;
      console.log('[5] Loaded saved cibus session cookie from Firestore');
    }
    cibusAccount.onCookieSaved = async (newCookie) => {
      await db.doc('moneyman/cibus_session').set({
        cookie: newCookie,
        savedAt: FieldValue.serverTimestamp(),
      });
      console.log('Saved new cibus session cookie to Firestore');
    };
    const tg = configDoc.data()?.options?.notifications?.telegram;
    if (tg?.apiKey && tg?.chatId) {
      cibusAccount.otpCodeRetriever = () => telegramOtpRetriever(tg.apiKey, tg.chatId);
      console.log('[5] otpCodeRetriever configured via Telegram');
    } else {
      console.log('[5] WARNING: no Telegram config found, OTP retrieval will fail');
    }
  } else {
    console.log('[5] WARNING: no cibus account found in scraperConfig');
  }

  console.log('[6] Running scraper via runWithStorage');
  await runWithStorage(async (hooks) => {
    try {
      await hooks.onBeforeStart();
      console.log('[6] scrapeAccounts starting');
      const results = await scrapeAccounts(
        scraperConfig,
        async (status, totalTime) => hooks.onStatusChanged(status, totalTime),
        (e, caller) => { console.error('[6] scraper onError:', caller, e?.message); hooks.onError(e, caller); },
      );
      console.log('[6] scrapeAccounts done:', JSON.stringify(results?.map(r => ({ companyId: r.companyId, success: r.result?.success, errorType: r.result?.errorType, errorMessage: r.result?.errorMessage }))));
      await Promise.all([
        hooks.onResultsReady(results),
        sendFailureScreenShots(hooks.failureScreenshotsHandler),
      ]);
    } catch (e) {
      console.error('[6] runMoneyman catch:', e?.message, e?.stack);
      await hooks.onError(e, 'runMoneyman');
    }
  });
  console.log('[7] runWithStorage complete');
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
