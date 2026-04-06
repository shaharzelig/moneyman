import { createLogger } from "../../utils/logger.js";
import { format, parseISO } from "date-fns";
import * as ynab from "ynab";
import { hash } from "hash-it";
import { TransactionStatuses } from "israeli-bank-scrapers/lib/transactions.js";
import { sendDeprecationMessage } from "../deprecationManager.js";
import { createSaveStats } from "../saveStats.js";
import assert from "node:assert";
const YNAB_DATE_FORMAT = "yyyy-MM-dd";
const logger = createLogger("YNABStorage");
export class YNABStorage {
    config;
    ynabAPI;
    budgetName;
    accountToYnabAccount;
    constructor(config) {
        this.config = config;
    }
    async init() {
        logger("init");
        const ynabConfig = this.config.storage.ynab;
        assert(ynabConfig, "YNAB configuration not found");
        this.ynabAPI = new ynab.API(ynabConfig.token);
        this.budgetName = await this.getBudgetName(ynabConfig.budgetId);
        this.accountToYnabAccount = new Map(Object.entries(ynabConfig.accounts));
    }
    canSave() {
        return Boolean(this.config.storage.ynab);
    }
    isDateInFuture(date) {
        return new Date(date) > new Date();
    }
    async saveTransactions(txns, onProgress) {
        await Promise.all([onProgress("Initializing"), this.init()]);
        const stats = createSaveStats("YNABStorage", `budget: "${this.budgetName}"`, txns);
        // Initialize an array to store non-pending and non-empty account ID transactions on YNAB format.
        const txToSend = [];
        const missingAccounts = new Set();
        for (let tx of txns) {
            const isPending = tx.status === TransactionStatuses.Pending;
            // YNAB doesn't support future transactions. Will result in 400 Bad Request
            const isDateInFuture = this.isDateInFuture(tx.date);
            if (isPending || isDateInFuture) {
                if (isDateInFuture) {
                    stats.otherSkipped++;
                }
                continue;
            }
            const accountId = this.accountToYnabAccount.get(tx.account);
            if (!accountId) {
                missingAccounts.add(tx.account);
                stats.otherSkipped++;
                continue;
            }
            // Converting to YNAB format.
            const ynabTx = this.convertTransactionToYnabFormat(tx, accountId);
            // Add non-pending and non-empty account ID transactions to the array.
            txToSend.push(ynabTx);
        }
        if (txToSend.length > 0) {
            // Send transactions to YNAB
            logger(`sending to YNAB budget: "${this.budgetName}"`);
            const [resp] = await Promise.all([
                this.ynabAPI.transactions.createTransactions(this.config.storage.ynab.budgetId, {
                    transactions: txToSend,
                }),
                onProgress("Sending"),
            ]);
            logger("transactions sent to YNAB successfully!");
            stats.added = resp.data.transactions?.length ?? 0;
            stats.existing = resp.data.duplicate_import_ids?.length ?? 0;
            if (this.config.options.scraping.transactionHashType !== "moneyman") {
                sendDeprecationMessage("hashFiledChange");
            }
        }
        if (missingAccounts.size > 0) {
            logger(`Accounts missing in YNAB_ACCOUNTS:`, missingAccounts);
        }
        return stats;
    }
    async getBudgetName(budgetId) {
        const budgetResponse = await this.ynabAPI.budgets.getBudgetById(budgetId);
        if (budgetResponse.data) {
            return budgetResponse.data.budget.name;
        }
        else {
            throw new Error(`YNAB_BUDGET_ID does not exist in YNAB: ${budgetId}`);
        }
    }
    convertTransactionToYnabFormat(tx, accountId) {
        const amount = Math.round(tx.chargedAmount * 1000);
        return {
            account_id: accountId,
            date: format(parseISO(tx.date), YNAB_DATE_FORMAT, {}),
            amount,
            payee_id: undefined,
            payee_name: tx.description,
            cleared: tx.status === TransactionStatuses.Completed
                ? ynab.TransactionClearedStatus.Cleared
                : undefined,
            approved: false,
            import_id: hash(this.config.options.scraping.transactionHashType === "moneyman"
                ? tx.uniqueId
                : tx.hash).toString(),
            memo: tx.memo,
        };
    }
}
//# sourceMappingURL=ynab.js.map