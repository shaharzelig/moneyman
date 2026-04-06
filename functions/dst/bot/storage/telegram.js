import { sendJSON } from "../notifier.js";
import { createLogger } from "../../utils/logger.js";
import { createSaveStats } from "../saveStats.js";
import { systemName } from "../../config.js";
const logger = createLogger("TelegramStorage");
export class TelegramStorage {
    config;
    constructor(config) {
        this.config = config;
    }
    canSave() {
        // First check if telegram notifications are configured (required for sending)
        const hasTelegramNotifications = Boolean(this.config.options.notifications.telegram?.chatId);
        if (!hasTelegramNotifications) {
            return false;
        }
        // If storage.telegram is explicitly configured, use that setting
        if (this.config.storage.telegram !== undefined) {
            return this.config.storage.telegram.enabled;
        }
        // For backward compatibility, default to true if telegram notifications are configured
        return true;
    }
    async saveTransactions(transactions, onProgress) {
        logger("saveTransactions");
        await onProgress("Preparing JSON data");
        const stats = createSaveStats("TelegramStorage", undefined, transactions);
        await sendJSON({
            metadata: {
                ...stats,
                scrapedBy: systemName,
                scrapedAt: new Date().toISOString(),
            },
            transactions,
        }, `transactions.txt`);
        return stats;
    }
}
//# sourceMappingURL=telegram.js.map