import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { createLogger } from "./logger.js";
const logger = createLogger("failureScreenshot");
const tempFolder = path.join(fs.realpathSync(os.tmpdir()), "moneyman");
export function getFailureScreenShotPath(companyId) {
    const companyDir = path.join(tempFolder, companyId);
    if (!fs.existsSync(companyDir)) {
        fs.mkdirSync(companyDir, { recursive: true });
    }
    const filePath = path.join(companyDir, `${companyId}-${Date.now()}.png`);
    logger("getFailureScreenShotPath %o", filePath);
    return filePath;
}
export async function sendFailureScreenShots(sendPhotos) {
    try {
        const photos = await glob(`${tempFolder}/**/*.png`, { absolute: true });
        logger("Sending failure screenshots", { photos });
        await sendPhotos(photos.map((photoPath) => ({
            photoPath,
            caption: `[${path.basename(path.dirname(photoPath))}] Failure screenshot`,
        })));
        fs.rmSync(tempFolder, { recursive: true, force: true });
    }
    catch (e) {
        logger("Failed to send failure screenshots", e);
    }
}
//# sourceMappingURL=failureScreenshot.js.map