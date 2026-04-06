import { createLogger } from "../utils/logger.js";
const logger = createLogger("domain-rules");
export class DomainRuleManager {
    company;
    blockByDefault;
    cachedRules = new Map();
    rootDomainTrie = { rule: undefined, children: new Map() };
    /**
     * @param company Company for which this manager should hold rules
     * @param rules Domain rules array. Format: [company] [ALLOW/BLOCK] [domain]
     * @param blockByDefault Whether to block domains by default when no rule is found. Defaults to false.
     */
    constructor(company, rules, blockByDefault = false) {
        this.company = company;
        this.blockByDefault = blockByDefault;
        for (const [, action, domain] of this.parseDomainRules(rules)) {
            this.insertRule(domain, action);
        }
    }
    insertRule(domain, rule) {
        // We store domains reversed in the trie (com.example.api) for efficient parent domain matching
        const parts = domain.split(".").reverse();
        let current = this.rootDomainTrie;
        for (const part of parts) {
            if (!current.children.has(part)) {
                current.children.set(part, { rule: undefined, children: new Map() });
            }
            current = current.children.get(part);
        }
        current.rule = rule;
        logger(`Inserted rule: ${rule} ${domain}`);
    }
    /**
     * Check a URL against the domain rules for this manager's company
     * @param url URL to check
     * @returns "ALLOW" or "BLOCK" if a rule is found
     */
    getRule(url) {
        const defaultRule = this.blockByDefault ? "BLOCK" : "ALLOW";
        const { hostname } = typeof url === "string" ? new URL(url) : url;
        if (!this.cachedRules.has(hostname)) {
            const rule = this.lookupRule(hostname);
            this.cachedRules.set(hostname, rule ?? defaultRule);
        }
        return this.cachedRules.get(hostname);
    }
    isBlocked(url) {
        return this.getRule(url) === "BLOCK";
    }
    hasAnyRule() {
        function hasRule(node) {
            return (node.rule !== undefined ||
                Array.from(node.children.values()).some(hasRule));
        }
        return hasRule(this.rootDomainTrie);
    }
    lookupRule(domain) {
        // We store domains reversed in the trie (com.example.api) for efficient parent domain matching
        const parts = domain.split(".").reverse();
        function findRule(node, index) {
            const currentRule = node.rule;
            if (index >= parts.length || !node.children.has(parts[index])) {
                return currentRule;
            }
            const childNode = node.children.get(parts[index]);
            const childRule = findRule(childNode, index + 1);
            return childRule ?? currentRule;
        }
        return findRule(this.rootDomainTrie, 0);
    }
    parseDomainRules(rules) {
        const ruleRegex = /^(\w+)\s+(ALLOW|BLOCK)\s+(\S+)$/;
        return rules
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"))
            .map((line) => {
            const match = line.match(ruleRegex);
            return match ? [match[1], match[2], match[3]] : null;
        })
            .filter((parts) => parts !== null)
            .filter(([companyId]) => companyId === this.company)
            .map(([companyId, action, domain]) => [
            companyId,
            action,
            domain,
        ]);
    }
}
//# sourceMappingURL=domainRules.js.map