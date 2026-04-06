import { createLogger } from "../utils/logger.js";
const logger = createLogger("deprecationManager");
const deprecationMessages = {
    ["hashFiledChange"]: `This run is using the old transaction hash field, please update to the new one (it might require manual de-duping of some transactions). See https://github.com/daniel-hauser/moneyman/issues/268 for more details.`,
};
const pendingDeprecations = new Set();
const sentDeprecationMessages = new Set();
let deprecationHandler = null;
function deprecationMessage(messageId) {
    return `⚠️ Deprecation warning:
${deprecationMessages[messageId]}`;
}
/**
 * Request a deprecation message to be sent
 */
export function sendDeprecationMessage(messageId) {
    logger(`Requesting deprecation message: ${messageId}`);
    if (sentDeprecationMessages.has(messageId)) {
        logger(`Deprecation message already sent: ${messageId}`);
        return;
    }
    sentDeprecationMessages.add(messageId);
    const message = deprecationMessage(messageId);
    if (deprecationHandler) {
        // Handler is available, call it immediately
        deprecationHandler(messageId, message);
    }
    else {
        // Handler not set yet, store for later
        pendingDeprecations.add(messageId);
    }
}
/**
 * Assign a handler for deprecation messages
 * Will immediately call the handler for all pending deprecations, then call it for each new one
 */
export function assignDeprecationHandler(handler) {
    deprecationHandler = handler;
    // Call handler for all pending deprecations
    for (const messageId of pendingDeprecations) {
        handler(messageId, deprecationMessage(messageId));
    }
    // Clear the pending set since they've been handled
    pendingDeprecations.clear();
}
//# sourceMappingURL=deprecationManager.js.map