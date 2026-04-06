import assert from "node:assert";
import { createLogger } from "../../utils/logger.js";
import { GoogleSpreadsheet, } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";
import { sendError } from "../notifier.js";
import { sendDeprecationMessage } from "../deprecationManager.js";
import { createSaveStats } from "../saveStats.js";
import { tableRow } from "../transactionTableRow.js";
const logger = createLogger("GoogleSheetsStorage");
export class GoogleSheetsStorage {
    config;
    worksheetName;
    constructor(config) {
        this.config = config;
        this.worksheetName =
            this.config.storage.googleSheets?.worksheetName || "_moneyman";
    }
    canSave() {
        return Boolean(this.config.storage.googleSheets);
    }
    async saveTransactions(txns, onProgress) {
        const [doc] = await Promise.all([this.getDoc(), onProgress("Getting doc")]);
        await onProgress(`Getting sheet ${this.worksheetName}`);
        const sheet = doc.sheetsByTitle[this.worksheetName];
        assert(sheet, `Sheet ${this.worksheetName} not found`);
        const [headerRowResult] = await Promise.allSettled([
            sheet.loadHeaderRow(),
            onProgress(`Loading header row`),
        ]);
        if (headerRowResult.status === "rejected") {
            logger("Error loading header row", headerRowResult.reason);
            sendError(headerRowResult.reason, "GoogleSheetsStorage::loadHeaderRow");
            await onProgress(`Loading header row failed: ${headerRowResult.reason}`);
            throw new Error(`Failed to load header row: ${headerRowResult.reason}`);
        }
        logger(`Loaded header row: ${sheet.headerValues}`);
        const existingHashes = await this.loadHashes(sheet, onProgress);
        logger(`Loaded ${existingHashes.size} existing hashes from sheet`);
        // Build a map from date-stripped suffix → dates already in sheet, to detect
        // settlement date shifts. Bank transaction dates can shift 1-3 days between scrapes
        // (e.g. authorized Mar 3, cleared Mar 4). The uniqueId includes the date so the two
        // hashes differ. We match by suffix (companyId+account+amount+identifier) but only
        // when the existing date is within MAX_DATE_SHIFT_DAYS — so monthly recurring charges
        // with the same identifier are NOT collapsed.
        // Only applied when tx.identifier is set; description/memo fallback is not stable enough.
        const MAX_DATE_SHIFT_DAYS = 7;
        const suffixToExistingDates = new Map();
        for (const h of existingHashes) {
            if (h.length > 11) {
                const dateStr = h.substring(0, 10);
                const suffix = h.substring(11);
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                    if (!suffixToExistingDates.has(suffix))
                        suffixToExistingDates.set(suffix, []);
                    suffixToExistingDates.get(suffix).push(date);
                }
            }
        }
        // Deduplicate within the current batch (scraper may return same tx twice e.g. in pending+history overlap)
        const seenInBatch = new Set();
        const stats = createSaveStats("Google Sheets", this.worksheetName, txns, {
            highlightedTransactions: {
                Added: [],
            },
        });
        const newTxns = txns.filter((tx) => {
            if (this.config.options.scraping.transactionHashType === "moneyman") {
                // Use the new uniqueId as the unique identifier for the transactions if the hash type is moneyman
                if (existingHashes.has(tx.uniqueId)) {
                    stats.existing++;
                    return false;
                }
            }
            if (existingHashes.has(tx.hash)) {
                if (this.config.options.scraping.transactionHashType === "moneyman") {
                    logger(`Skipping, old hash ${tx.hash} is already in the sheet`);
                }
                // To avoid double counting, skip if the new hash is already in the sheet
                if (!existingHashes.has(tx.uniqueId)) {
                    stats.existing++;
                }
                return false;
            }
            // Check if the same transaction exists under a nearby date (bank settlement date shift).
            // Only skip if an existing entry has the same suffix AND its date is within
            // MAX_DATE_SHIFT_DAYS — this prevents collapsing legitimate recurring monthly charges.
            if (tx.identifier) {
                const suffix = tx.uniqueId.substring(11); // strip "YYYY-MM-DD_"
                const txDate = new Date(tx.uniqueId.substring(0, 10));
                const existingDates = suffixToExistingDates.get(suffix);
                if (existingDates) {
                    const isNearby = existingDates.some((d) => Math.abs(d.getTime() - txDate.getTime()) <=
                        MAX_DATE_SHIFT_DAYS * 24 * 60 * 60 * 1000);
                    if (isNearby) {
                        logger(`Skipping date-shifted duplicate (identifier match): ${tx.uniqueId}`);
                        stats.existing++;
                        return false;
                    }
                }
            }
            if (seenInBatch.has(tx.uniqueId)) {
                logger(`Skipping in-batch duplicate: ${tx.uniqueId}`);
                return false;
            }
            seenInBatch.add(tx.uniqueId);
            return tx.status !== TransactionStatuses.Pending;
        });
        const hasRawColumn = sheet.headerValues.includes("raw");
        const rows = newTxns.map((tx) => tableRow(tx, hasRawColumn));
        if (rows.length) {
            stats.highlightedTransactions.Added.push(...newTxns);
            stats.added = rows.length;
            const [addRowsResult] = await Promise.allSettled([
                sheet.addRows(rows),
                onProgress(`Saving ${rows.length} rows`),
            ]);
            if (this.config.options.scraping.transactionHashType !== "moneyman") {
                sendDeprecationMessage("hashFiledChange");
            }
            if (addRowsResult.status === "rejected") {
                logger("Error saving rows", addRowsResult.reason);
                sendError(addRowsResult.reason, "GoogleSheetsStorage::saveTransactions");
                await onProgress(`recovering stats after saving failed: ${addRowsResult.reason}`);
                try {
                    const hashes = await this.loadHashes(sheet, onProgress);
                    const notSaved = newTxns.filter(({ hash, uniqueId }) => !hashes.has(hash) && !hashes.has(uniqueId));
                    stats.added -= notSaved.length;
                    stats.otherSkipped = notSaved.length;
                }
                catch (e) {
                    logger("Error loading hashes", e);
                    sendError(e, "GoogleSheetsStorage::saveTransactions");
                }
            }
        }
        return stats;
    }
    async getDoc() {
        const googleSheetsConfig = this.config.storage.googleSheets;
        assert(googleSheetsConfig, "Google Sheets configuration not found");
        const authClient = new JWT({
            email: googleSheetsConfig.serviceAccountEmail,
            key: googleSheetsConfig.serviceAccountPrivateKey,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        const doc = new GoogleSpreadsheet(googleSheetsConfig.sheetId, authClient);
        await doc.loadInfo();
        return doc;
    }
    /**
     * Load hashes from the "hash" column, assuming the first row is a header row
     */
    async loadHashes(sheet, onProgress) {
        const column = sheet.headerValues.indexOf("hash");
        assert(column !== -1, "Hash column not found");
        assert(column < 26, "Currently only supports single letter columns");
        const columnLetter = String.fromCharCode(65 + column);
        const range = `${columnLetter}2:${columnLetter}`;
        const [columns] = await Promise.allSettled([
            sheet.getCellsInRange(range, {
                majorDimension: "COLUMNS",
            }),
            onProgress(`Loading hashes (${range})`),
        ]);
        if (columns.status === "rejected") {
            logger("Failed to load hashes", columns.reason);
            await onProgress(`Loading hashes failed: ${columns.reason}`);
            throw new Error(`Loading hashes failed: ${columns.reason}`);
        }
        if (!Array.isArray(columns.value)) {
            logger(`getCellsInRange returned non-array: ${JSON.stringify(columns.value)}`);
            return new Set();
        }
        logger(`getCellsInRange returned ${columns.value[0]?.length ?? 0} rows for range ${range}`);
        return new Set(columns.value[0]);
    }
}
//# sourceMappingURL=sheets.js.map