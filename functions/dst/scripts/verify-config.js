#!/usr/bin/env node
import "dotenv/config";
import { MoneymanConfigSchema } from "../config.schema.js";
import { parseJsoncConfig } from "../utils/jsonc.js";
try {
    console.log("🔍 Verifying config parsing...");
    const configString = process.env.MONEYMAN_CONFIG;
    if (!configString) {
        console.warn("⚠️ No config provided, using an empty object");
    }
    else {
        const parsedConfig = parseJsoncConfig(configString);
        MoneymanConfigSchema.parse(parsedConfig);
        console.log("✅ Config parsing successful");
    }
}
catch (error) {
    console.error("❌ Config parsing failed:", "errors" in error ? error.errors : error.message);
    process.exit(1);
}
//# sourceMappingURL=verify-config.js.map