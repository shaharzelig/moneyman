const symbolToCurrency = {
    $: "USD",
    "€": "EUR",
    "₪": "ILS",
    NIS: "ILS",
};
export function normalizeCurrency(currency) {
    if (!currency)
        return undefined;
    return (symbolToCurrency[currency] ?? currency).toUpperCase();
}
//# sourceMappingURL=currency.js.map