import { CompanyTypes } from "israeli-bank-scrapers";
import { getAccountTransactions } from "./scrape";
import { mock, mockClear } from "jest-mock-extended";
describe("getAccountTransactions", () => {
    const onProgress = jest.fn();
    const browserPage = mock();
    const browserContext = mock({
        newPage: jest.fn().mockResolvedValue(browserPage),
    });
    const account = {
        companyId: CompanyTypes.hapoalim,
        username: "username",
        password: "password",
    };
    const scraperOptions = {
        browserContext,
        startDate: new Date(),
        companyId: account.companyId,
    };
    beforeEach(() => {
        jest.clearAllMocks();
        mockClear(browserContext);
        mockClear(browserPage);
    });
    it("should create a scraper and a page", async () => {
        const result = await getAccountTransactions(account, scraperOptions, onProgress);
        expect(result).toBeDefined();
        expect(result.success).toBeFalsy(); // because we didn't mock the scraper
        expect(browserContext.newPage).toHaveBeenCalledTimes(1);
        expect(browserPage.close).toHaveBeenCalledTimes(1);
        expect(onProgress).toHaveBeenNthCalledWith(1, account.companyId, "START_SCRAPING");
        expect(onProgress).toHaveBeenLastCalledWith(account.companyId, "END_SCRAPING");
    });
});
//# sourceMappingURL=scrape.test.js.map