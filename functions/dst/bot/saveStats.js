import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";
import { transactionList } from "./messages.js";
/**
 * Calculate the number of skipped transactions (existing + pending + otherSkipped)
 * @param stats SaveStats object
 * @returns Total number of skipped transactions
 */
export function getSkippedCount(stats) {
    return stats.existing + stats.pending + stats.otherSkipped;
}
/**
 * Generate skipped transactions string with breakdown
 * @param stats SaveStats object
 * @returns Formatted string for skipped transactions or empty string if none
 */
export function skippedString(stats) {
    const skipped = getSkippedCount(stats);
    if (skipped === 0) {
        return "";
    }
    const parts = [];
    if (stats.existing > 0)
        parts.push(`${stats.existing} existing`);
    if (stats.pending > 0)
        parts.push(`${stats.pending} pending`);
    if (stats.otherSkipped > 0)
        parts.push(`${stats.otherSkipped} other`);
    return `${skipped} skipped (${parts.join(", ")})`;
}
/**
 * Create a new SaveStats object with the given name, table and transactions
 * @param name Store name
 * @param table Store elements to be updated (Accounts, budgets, etc ...)
 * @param transactions Scrapped transactions
 * @param stats Optional stats to be added to the new object
 */
export function createSaveStats(name, table, transactions, stats = {}) {
    const total = transactions.length;
    const pending = transactions.filter((tx) => tx.status === TransactionStatuses.Pending).length;
    return {
        name,
        table,
        total,
        added: 0,
        pending,
        existing: 0,
        otherSkipped: 0,
        ...stats,
    };
}
export function statsString(stats, saveDurationMs, steps = []) {
    const header = `📝 ${stats.name}${stats.table ? ` (${stats.table})` : ""}`;
    const stepsString = steps.map((s) => `\t${s}`).join("\n");
    const skippedInfo = skippedString(stats);
    const skippedBreakdown = skippedInfo ? `\t${skippedInfo}\n` : "";
    return `
${header}${stepsString ? "\n" + stepsString : ""}
\t${stats.added} added${skippedBreakdown}
\ttook ${(saveDurationMs / 1000).toFixed(2)}s
${highlightedTransactionsString(stats.highlightedTransactions, 1)}`.trim();
}
export function highlightedTransactionsString(groups, indent = 0) {
    if (!groups || Object.keys(groups).length === 0) {
        return "";
    }
    const indentString = "\t".repeat(indent);
    const groupsString = Object.entries(groups)
        .filter(([_, txns]) => txns.length > 0)
        .map(([name, txns]) => {
        const transactionsString = transactionList(txns, `${indentString}\t`);
        return `${indentString}${name}:\n${transactionsString}`;
    });
    if (groupsString.length === 0) {
        return "";
    }
    return `${indentString}${"-".repeat(5)}\n${groupsString}`;
}
//# sourceMappingURL=saveStats.js.map