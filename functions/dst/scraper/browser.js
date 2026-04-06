import puppeteer, { TargetType, } from "puppeteer";
import { createLogger } from "../utils/logger.js";
import { runInLoggerContext, loggerContextStore, } from "../utils/asyncContext.js";
import { initDomainTracking } from "../security/domains.js";
import { solveTurnstile } from "./cloudflareSolver.js";
import { config } from "../config.js";
export const browserArgs = [
    "--disable-dev-shm-usage",
    "--no-sandbox",
    // Reduce easy automation fingerprints used by anti-bot providers.
    "--disable-blink-features=AutomationControlled",
];
export function browserExecutablePath() {
    return (process.env.PUPPETEER_EXECUTABLE_PATH ||
        config.options.scraping.puppeteerExecutablePath ||
        undefined);
}
const logger = createLogger("browser");
export async function createBrowser() {
    const headless = process.env.PUPPETEER_HEADLESS !== "false";
    const options = {
        args: browserArgs,
        executablePath: browserExecutablePath(),
        headless,
        // Hide the "Chrome is being controlled by automated software" marker.
        ignoreDefaultArgs: ["--enable-automation"],
    };
    logger("Creating browser", options);
    return puppeteer.launch(options);
}
export async function createSecureBrowserContext(browser, companyId) {
    const context = await browser.createBrowserContext();
    await initDomainTracking(context, companyId);
    await initCloudflareSkipping(context);
    return context;
}
async function initCloudflareSkipping(browserContext) {
    const activeContext = loggerContextStore.getStore();
    const cfParam = "__cf_chl_rt_tk";
    logger("Setting up Cloudflare skipping");
    browserContext.on("targetcreated", runInLoggerContext(async (target) => {
        if (target.type() === TargetType.PAGE) {
            logger("Target created %o", target.type());
            const page = await target.page();
            if (!page)
                return;
            const userAgent = await page.evaluate(() => navigator.userAgent);
            const newUA = userAgent.replace("HeadlessChrome/", "Chrome/");
            logger("Replacing user agent", { userAgent, newUA });
            await page.setUserAgent(newUA);
            await page.setExtraHTTPHeaders({
                "accept-language": "en-US,en;q=0.9,he;q=0.8",
            });
            await page.evaluateOnNewDocument(() => {
                // Apply lightweight stealth patches before page scripts run.
                Object.defineProperty(navigator, "webdriver", {
                    get: () => undefined,
                });
                Object.defineProperty(navigator, "language", {
                    get: () => "en-US",
                });
                Object.defineProperty(navigator, "languages", {
                    get: () => ["en-US", "en", "he"],
                });
            });
            page.on("framenavigated", runInLoggerContext((frame) => {
                const url = frame.url();
                if (!url || url === "about:blank")
                    return;
                logger("Frame navigated", {
                    url,
                    parentFrameUrl: frame.parentFrame()?.url(),
                });
                if (url.includes(cfParam)) {
                    logger("Cloudflare challenge detected");
                    solveTurnstile(page).then((res) => {
                        logger(`Cloudflare challenge ended with ${res} for ${url}`);
                    }, (error) => {
                        logger(`Cloudflare challenge failed for ${url}`, error);
                    });
                }
            }, activeContext));
        }
    }, activeContext));
}
//# sourceMappingURL=browser.js.map