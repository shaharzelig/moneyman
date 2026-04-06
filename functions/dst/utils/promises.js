/**
 * Creates a promise that rejects when an AbortSignal is aborted
 * @param signal - AbortSignal to listen to
 * @returns A promise that rejects when the signal is aborted
 */
export function waitForAbortSignal(signal) {
    return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
            reject(signal.reason);
        }, { once: true });
    });
}
//# sourceMappingURL=promises.js.map