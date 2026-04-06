# Moneyman Data Foundation — Design Spec

**Date:** 2026-04-05
**Sub-project:** 1 of 4 (Data Foundation)
**Depends on:** nothing
**Blocks:** Transactions UI + Run History (sub-project 2), Categorization (sub-project 3), Analytics (sub-project 4)

## Goal

Make moneyman multi-tenant. Each approved Stocky user can scrape their own bank accounts. Transactions land in Firestore per-user. Telegram and Google Sheets are removed as output mechanisms from the Cloud Function. Run logs replace Telegram as the progress/error mechanism.

## Out of Scope

- Transactions UI (sub-project 2)
- Run history UI (sub-project 2)
- Categorization (sub-project 3)
- Analytics (sub-project 4)

---

## Data Model

| Path | Purpose |
|---|---|
| `users/{uid}/moneyman/config` | User's bank accounts + credentials. Moved from global `moneyman/config`. |
| `users/{uid}/moneyman/scrapeRequest` | Manual scrape trigger. Moved from global `moneyman/scrapeRequest`. |
| `users/{uid}/moneyman/config/runs/{runId}` | Run log. Subcollection of the config document. Replaces Telegram progress messages. |
| `users/{uid}/transactions/{hash}` | Scraped transactions. Moved from global `moneymanTransactions` collection. |
| `users/{uid}/scrapers/{scraperId}` | Scraper session state (e.g. Cibus cookie). Already per-user — unchanged. |
| `users/{uid}/jobs/{jobId}` | Extension re-auth jobs. Already per-user — unchanged. |

### Run document schema

```json
{
  "status": "running | done | failed",
  "startedAt": "<timestamp>",
  "completedAt": "<timestamp>",
  "txnCount": 42,
  "accounts": [
    { "companyId": "hapoalim", "success": true, "txnCount": 20 },
    { "companyId": "cibus", "success": false, "errorType": "InvalidPassword" }
  ],
  "error": "<top-level error message if status=failed>"
}
```

---

## Cloud Functions

### 1. `runMoneymanScheduled` (fan-out only)

**Schedule:** `0 0 * * *` (midnight UTC — changed from `"every 24 hours"`)

Does not scrape. Discovers all moneyman users via a Firestore **collection group query** on the `moneyman` collection. The query returns all documents across all users' `moneyman` collections (`config` and `scrapeRequest`); filter in application code to documents where the document ID is `config`. For each user found, extract the `uid` from the document's resource path, then write `{ status: 'pending', requestedAt: serverTimestamp() }` to `users/{uid}/moneyman/scrapeRequest`. This triggers `runMoneymanOnRequest` independently per user.

### 2. `runMoneymanOnRequest` (Firestore trigger)

**Trigger:** `users/{uid}/moneyman/scrapeRequest` (wildcard — fires for any user)

Handles one user's scrape in full isolation. Extracts `uid` from the document path.

**Per-scrape flow:**
1. Check `status === 'pending'` — ignore all other transitions
2. Update scrapeRequest to `status: 'running'`
3. Read `users/{uid}/moneyman/config` — abort if missing
4. Load scraper sessions from `users/{uid}/scrapers/{scraperId}` for each configured scraper
5. Create run doc at `users/{uid}/moneyman/config/runs/{runId}` with `{ status: 'running', startedAt }`
6. Run scraper using that user's config
7. `FirestoreStorage(uid)` writes settled transactions to `users/{uid}/transactions/{hash}` (upsert by hash — no duplicates)
8. Update run doc: `{ status: 'done'/'failed', completedAt, txnCount, accounts }`
9. Update scrapeRequest: `{ status: 'done'/'failed', completedAt }`
10. For scrapers with an extension re-auth flow: on auth failure → create job in `users/{uid}/jobs/{jobId}`

Each invocation is fully isolated — timeout, memory, and config state do not bleed between users.

### 3. `runMoneymanHttp` (admin trigger)

Kept for debugging. Accepts `{ uid }` in the request body. Writes a scrapeRequest for that specific user, triggering the Firestore flow. Auth guard unchanged (requires owner Firebase ID token).

---

## Storage Layer Changes

### `FirestoreStorage`

- Constructor accepts `uid: string`
- Writes to `users/${uid}/transactions/${hash}` instead of global `moneymanTransactions`
- Logic otherwise unchanged (upsert by hash, batch writes, skip pending transactions)

### Sheets and Telegram removed

`GoogleSheetsStorage` and `TelegramStorage` are removed from the active storages list in the Cloud Function context. They remain in the codebase for local/Docker use (where `FIREBASE_CONFIG` is absent and `FirestoreStorage.canSave()` returns false).

### Notifier (`bot/notifier.ts`)

Telegram notifier is not called from the Cloud Function. The Cloud Function writes progress and errors directly to the run doc. `bot/index.ts` (`runWithStorage`) is bypassed in the Cloud Function — the function manages its own run lifecycle.

---

## Firestore Rules

Remove the two hardcoded-UID rules:
```
// REMOVE
match /moneyman/config { allow read, write: if request.auth.uid == "<hardcoded>"; }
match /moneyman/scrapeRequest { allow read, write: if request.auth.uid == "<hardcoded>"; }
```

Add per-user rules under the existing `users/{uid}` block:
```
match /users/{uid}/moneyman/{document=**} {
  allow read, write: if isApproved() && request.auth.uid == uid;
}
match /users/{uid}/transactions/{txId} {
  allow read, write: if isApproved() && request.auth.uid == uid;
}
```

All moneyman data is gated behind `isApproved()` — only users you have approved in Stocky can access it.

---

## Frontend Changes (BankConnections.tsx)

- Config path (reads and writes): `moneyman/config` → `users/{uid}/moneyman/config`
- ScrapeRequest path (reads and writes): `moneyman/scrapeRequest` → `users/{uid}/moneyman/scrapeRequest`
- Show latest run status from `users/{uid}/moneyman/config/runs` (most recent doc, ordered by `startedAt` desc)
- Show next scheduled run: **next midnight UTC** (computed client-side — reliable since schedule is now fixed to `0 0 * * *`)

---

## Migration

The existing owner's data needs a one-time migration:
- Copy `moneyman/config` → `users/{ownerUid}/moneyman/config`
- Copy global `moneymanTransactions/{hash}` → `users/{ownerUid}/transactions/{hash}`

The old global documents can be deleted after migration is verified. Existing `users/{uid}/scrapers/cibus` data is already per-user — no migration needed.
