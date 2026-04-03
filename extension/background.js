// moneyman/extension/background.js
import { FIREBASE_CONFIG } from './firebase-config.js';

const PLUXEE_URL = 'https://consumers.pluxee.co.il/login';
const PLUXEE_COOKIE_NAME = 'token';
const ALARM_NAME = 'poll-jobs';
const POLL_INTERVAL_MINUTES = 0.5; // 30 seconds

// ── Firebase REST helpers ────────────────────────────────────────────────────

async function getFirebaseIdToken() {
  // Get Google OAuth token from Chrome identity — try silent first, prompt only if needed
  const googleToken = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        // Non-interactive failed — try interactive (shows popup)
        chrome.identity.getAuthToken({ interactive: true }, (token2) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(token2);
        });
      } else {
        resolve(token);
      }
    });
  });

  // Exchange Google OAuth token for Firebase ID token
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `access_token=${googleToken}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnSecureToken: true,
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Firebase signIn failed: ${JSON.stringify(data)}`);
  return { idToken: data.idToken, uid: data.localId };
}

async function firestoreGet(path, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${res.status}`);
  return res.json();
}

async function firestoreQuery(collectionPath, filters, idToken) {
  // Simple equality query via Firestore REST runQuery
  // The URL must be the parent document path (not documents:runQuery at root)
  const segments = collectionPath.split('/');
  const parentPath = segments.slice(0, -1).join('/'); // e.g. "users/{uid}"
  const collectionId = segments[segments.length - 1]; // e.g. "jobs"
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${parentPath}:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: filters.map(([field, value]) => ({
            fieldFilter: {
              field: { fieldPath: field },
              op: 'EQUAL',
              value: { stringValue: value },
            },
          })),
        },
      },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firestore query failed: ${res.status}`);
  const results = await res.json();
  return results.filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    ...firestoreDocToObject(r.document.fields),
  }));
}

async function firestorePatch(path, fields, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${path}`;
  const body = { fields: objectToFirestoreFields(fields) };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firestore PATCH ${path} failed: ${res.status} ${await res.text()}`);
}

function firestoreDocToObject(fields) {
  const result = {};
  for (const [key, val] of Object.entries(fields || {})) {
    if (val.stringValue !== undefined) result[key] = val.stringValue;
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
    else if (val.integerValue !== undefined) result[key] = val.integerValue;
    else if (val.timestampValue !== undefined) result[key] = val.timestampValue;
    else {
      console.warn('[firestoreDocToObject] unhandled field type for key', key, val);
      result[key] = null;
    }
  }
  return result;
}

function objectToFirestoreFields(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') fields[key] = { stringValue: val };
    else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
    else if (typeof val === 'number') fields[key] = { integerValue: String(val) };
  }
  return fields;
}

// ── Cookie helper ────────────────────────────────────────────────────────────

function cookieToSetCookieString(c) {
  let s = `${c.name}=${c.value}`;
  if (c.domain) s += `; Domain=${c.domain}`;
  if (c.path) s += `; Path=${c.path}`;
  if (c.expirationDate) s += `; Expires=${new Date(c.expirationDate * 1000).toUTCString()}`;
  if (c.httpOnly) s += '; HttpOnly';
  if (c.secure) s += '; Secure';
  if (c.sameSite && c.sameSite !== 'unspecified') s += `; SameSite=${c.sameSite}`;
  return s;
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

async function writeHeartbeat(uid, idToken) {
  await firestorePatch(`users/${uid}/extension/status`, {
    lastSeen: new Date().toISOString(),
  }, idToken);
}

// ── Auth flow ────────────────────────────────────────────────────────────────

async function runCibusAuth(jobId, uid, idToken) {
  console.log('[cibus-auth] Starting auth flow for job', jobId);

  // Mark job as in-progress
  await firestorePatch(`users/${uid}/jobs/${jobId}`, { status: 'running' }, idToken);

  // Read credentials
  const scraperDoc = await firestoreGet(`users/${uid}/scrapers/cibus`, idToken);
  if (!scraperDoc) throw new Error('No cibus scraper document found in Firestore');
  const creds = firestoreDocToObject(scraperDoc.fields);
  if (!creds.username || !creds.password) throw new Error('Missing username or password in Firestore');

  // Open Pluxee login tab
  const tab = await new Promise((resolve) => {
    chrome.tabs.create({ url: PLUXEE_URL, active: true }, resolve);
  });

  // Wait for tab to fully load
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tab load timeout')), 30000);
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  // Small delay for React hydration
  await new Promise(r => setTimeout(r, 2000));

  // Inject credentials into login form
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (username, password) => {
      const userInput = document.querySelector('#user');
      const passInput = document.querySelector('#password');
      if (!userInput || !passInput) throw new Error('Login form fields #user / #password not found');
      // Use native input setter to trigger React's synthetic events
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(userInput, username);
      userInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(passInput, password);
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      // Submit
      const form = userInput.closest('form');
      if (form) form.requestSubmit();
      else {
        const btn = document.querySelector('button[type="submit"], input[type="submit"]');
        if (btn) btn.click();
      }
    },
    args: [creds.username, creds.password],
  });

  console.log('[cibus-auth] Credentials injected, waiting for OTP flow and token cookie...');

  // Save running job state so the alarm cycle can poll for the cookie
  await chrome.storage.local.set({
    runningJob: { jobId, uid, tabId: tab.id, deadline: Date.now() + 5 * 60 * 1000 },
  });
  // Return immediately — cookie polling happens in checkRunningJob on the next alarm ticks
}

// ── Cookie poll (called on each alarm tick while a job is in flight) ─────────

async function checkRunningJob(runningJob, idToken) {
  const { jobId, uid, tabId, deadline } = runningJob;

  const tokenCookie = await new Promise(resolve => {
    chrome.cookies.get({ url: 'https://consumers.pluxee.co.il', name: PLUXEE_COOKIE_NAME }, resolve);
  });

  if (tokenCookie) {
    console.log('[cibus-auth] Token cookie found');
    const cookieStr = cookieToSetCookieString(tokenCookie);

    await firestorePatch(`users/${uid}/scrapers/cibus`, {
      cookie: cookieStr,
      cookieSavedAt: new Date().toISOString(),
      status: 'connected',
    }, idToken);

    await firestorePatch(`users/${uid}/jobs/${jobId}`, { status: 'done' }, idToken);
    console.log('[cibus-auth] Cookie saved, job done');

    chrome.tabs.remove(tabId).catch(() => {});
    await chrome.storage.local.remove('runningJob');
    return;
  }

  if (Date.now() > deadline) {
    console.warn('[cibus-auth] Timed out waiting for OTP cookie');
    await firestorePatch(`users/${uid}/jobs/${jobId}`, {
      status: 'failed',
      error: String('Timeout waiting for OTP'),
    }, idToken);
    await firestorePatch(`users/${uid}/scrapers/cibus`, { status: 'not_connected' }, idToken);

    chrome.tabs.remove(tabId).catch(() => {});
    await chrome.storage.local.remove('runningJob');
    return;
  }

  console.log('[cibus-auth] Waiting for OTP... next check on next alarm tick');
}

// ── Main poll loop ───────────────────────────────────────────────────────────

async function pollJobs() {
  let idToken, uid;
  try {
    ({ idToken, uid } = await getFirebaseIdToken());
  } catch (e) {
    console.error('[poll] Firebase auth failed:', e.message);
    return;
  }

  try {
    await writeHeartbeat(uid, idToken);
  } catch (e) {
    console.warn('[poll] Heartbeat failed (non-fatal):', e.message);
  }

  // Check if there's an in-progress auth job first
  const { runningJob } = await chrome.storage.local.get('runningJob');
  if (runningJob) {
    try {
      await checkRunningJob(runningJob, idToken);
    } catch (e) {
      console.error('[poll] checkRunningJob failed:', e.message);
      // Clear storage to avoid being stuck
      await chrome.storage.local.remove('runningJob');
    }
    return; // don't start new jobs while one is in flight
  }

  let jobs;
  try {
    jobs = await firestoreQuery(
      `users/${uid}/jobs`,
      [['status', 'pending'], ['scraper', 'cibus']],
      idToken
    );
  } catch (e) {
    console.error('[poll] Firestore query failed:', e.message);
    return;
  }

  for (const job of jobs) {
    try {
      await runCibusAuth(job.id, uid, idToken);
    } catch (e) {
      console.error('[poll] Auth flow failed for job', job.id, e.message);
      try {
        await firestorePatch(`users/${uid}/jobs/${job.id}`, { status: 'failed', error: String(e.message ?? e) }, idToken);
        await firestorePatch(`users/${uid}/scrapers/cibus`, { status: 'not_connected' }, idToken);
      } catch (_) {}
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Cibus auth failed',
        message: e.message,
      });
    }
  }
}

// ── Extension lifecycle ──────────────────────────────────────────────────────

chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0.1,  // first poll after 6 seconds
      periodInMinutes: POLL_INTERVAL_MINUTES,
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollJobs();
});
