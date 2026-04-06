import { saveResults, storages } from "./storage/index.js";
import { createLogger, logToPublicLog } from "../utils/logger.js";
import { getSummaryMessages } from "./messages.js";
import { editMessage, send, sendError, sendPhotos, } from "./notifier.js";
import { runContextStore } from "../utils/asyncContext.js";
import { randomUUID } from "crypto";
const logger = createLogger("bot");
export async function runWithStorage(runScraper) {
    const message = await send("Starting...");
    if (!storages.length) {
        logger("No storages found, aborting");
        await editMessage(message?.message_id, "No storages found, aborting");
        return;
    }
    const runId = randomUUID();
    await runContextStore.run({ runId }, async () => {
        await runScraper({
            async onStatusChanged(status, totalTime) {
                const text = status.join("\n");
                await editMessage(message?.message_id, totalTime
                    ? text + `\n\nTotal time: ${totalTime.toFixed(1)} seconds`
                    : text);
            },
            async onResultsReady(results) {
                const summaryMessage = getSummaryMessages(results);
                await send(summaryMessage, "HTML");
                await saveResults(results);
            },
            async onError(e, caller = "unknown") {
                await sendError(e, caller);
            },
            async onBeforeStart() { },
            async failureScreenshotsHandler(photos) {
                await sendPhotos(photos);
            },
        });
        logToPublicLog("Scraping ended", logger);
    });
}
//# sourceMappingURL=index.js.map