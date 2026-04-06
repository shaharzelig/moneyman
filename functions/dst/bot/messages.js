import { TransactionStatuses, TransactionTypes, } from "israeli-bank-scrapers/lib/transactions.js";
import { normalizeCurrency } from "../utils/currency.js";
import { escapers } from "@telegraf/entity";
import { transactionUniqueId } from "./storage/utils.js";
function blockquote(title, lines, expandable = true) {
    const content = lines.join("\n");
    const expandableAttr = expandable ? " expandable" : "";
    return `<blockquote${expandableAttr}>${title}\n${content}</blockquote>`;
}
function getAccountsSummary(results) {
    const successfulAccounts = results
        .filter(({ result }) => result.success)
        .flatMap(({ result, companyId }) => result.accounts?.map((account) => `\t✔️ [${companyId}] ${escapers.HTML(account.accountNumber)}: ${account.txns.length}`))
        .filter((account) => account !== undefined);
    const errorAccounts = results
        .filter(({ result }) => !result.success)
        .map(({ result, companyId }) => `\t❌ [${companyId}] ${result.errorType}${result.errorMessage
        ? `\n\t\t${escapers.HTML(result.errorMessage)}`
        : ""}`);
    if (errorAccounts.length === 0 && successfulAccounts.length === 0) {
        // No accounts at all
        return "Accounts updated:\n\t😶 None";
    }
    else if (errorAccounts.length === 0) {
        // Only successful accounts - use expandable block without duplication
        return blockquote("Accounts updated", successfulAccounts);
    }
    else if (successfulAccounts.length === 0) {
        // Only error accounts - use expandable block
        return blockquote("Accounts updated", errorAccounts);
    }
    else {
        // Mixed - show both in separate blocks (applying comment suggestion)
        const failedBlock = blockquote("Failed Account Updates", errorAccounts);
        const successBlock = blockquote("Successful Account Updates", successfulAccounts);
        return `${failedBlock}\n\n${successBlock}`;
    }
}
function getPendingTransactionsSummary(pending) {
    if (pending.length === 0) {
        return "";
    }
    else {
        const pendingContent = transactionList(pending, "\t");
        return blockquote("Pending txns", [pendingContent]);
    }
}
export function getSummaryMessages(results) {
    const { pending, completed } = transactionsByStatus(results);
    const sections = [
        transactionsString(pending, completed, results),
        getDuplicateUniqueIdSummary(results),
        getAccountsSummary(results),
        getPendingTransactionsSummary(pending),
    ];
    return sections.filter(Boolean).join("\n\n").trim();
}
function transactionsString(pending, completed, results) {
    const total = pending.length + completed.length;
    // Count total accounts from successful results
    const totalAccounts = results.reduce((count, { result }) => {
        if (result.success) {
            return count + (result.accounts?.length || 0);
        }
        return count;
    }, 0);
    const accountText = totalAccounts > 0
        ? ` from ${totalAccounts} account${totalAccounts === 1 ? "" : "s"}`
        : "";
    const summary = `
${total} transactions scraped${accountText}.
${total > 0 ? `(${pending.length} pending, ${completed.length} completed)` : ""}
${foreignTransactionsSummary(completed)}
`.trim();
    return escapers.HTML(summary);
}
function foreignTransactionsSummary(completed) {
    const original = completed.filter((tx) => normalizeCurrency(tx.originalCurrency) !== "ILS").length;
    if (original === 0) {
        return "";
    }
    const charged = completed.filter((tx) => normalizeCurrency(tx.chargedCurrency) !== "ILS").length;
    return `From completed, ${original} not originally in ILS${charged ? ` and ${charged} not charged in ILS` : ""}`;
}
function getDuplicateUniqueIdSummary(results) {
    const seen = new Set();
    const duplicateIds = new Set();
    for (const { result, companyId } of results) {
        if (result.success && result.accounts) {
            for (const account of result.accounts) {
                for (const tx of account.txns) {
                    const uniqueId = transactionUniqueId(tx, companyId, account.accountNumber);
                    if (seen.has(uniqueId)) {
                        duplicateIds.add(uniqueId);
                    }
                    seen.add(uniqueId);
                }
            }
        }
    }
    if (duplicateIds.size === 0) {
        return "";
    }
    const duplicateLines = Array.from(duplicateIds).map((id) => `\t${escapers.HTML(id)}`);
    return blockquote(`⚠️ Duplicate uniqueId detected (${duplicateIds.size} unique keys affected)`, duplicateLines);
}
function transactionAmount(t) {
    switch (t.type) {
        case TransactionTypes.Normal:
            switch (t.status) {
                case TransactionStatuses.Pending:
                    return t.originalAmount;
                case TransactionStatuses.Completed:
                    return t.chargedAmount;
            }
        case TransactionTypes.Installments:
            return t.chargedAmount;
    }
}
function transactionString(t) {
    const amount = transactionAmount(t);
    const sign = amount < 0 ? "-" : "+";
    const absAmount = Math.abs(amount).toFixed(2);
    return `${t?.description}:\t${sign}${absAmount}${t.originalCurrency === "ILS" ? "" : ` ${t.originalCurrency}`}`;
}
export function transactionList(transactions, indent = "\t") {
    const list = transactions
        .map((t) => `${indent}${transactionString(t)}`)
        .join("\n");
    return escapers.HTML(list);
}
export function saving(storage, steps = []) {
    const stepsString = steps.map((s) => `\t${s}`).join("\n");
    return `📝 ${storage} Saving...\n${stepsString}`.trim();
}
function transactionsByStatus(results) {
    const allTxns = results
        .flatMap(({ result }) => result.accounts?.flatMap((account) => account?.txns))
        .filter((t) => t !== undefined);
    const pendingTxns = allTxns.filter((t) => t.status === TransactionStatuses.Pending);
    const scrapedTxns = allTxns.filter((t) => t.status === TransactionStatuses.Completed);
    return {
        pending: pendingTxns,
        completed: scrapedTxns,
    };
}
//# sourceMappingURL=messages.js.map