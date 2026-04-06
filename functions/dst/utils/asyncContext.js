import { AsyncLocalStorage } from "async_hooks";
export const loggerContextStore = new AsyncLocalStorage();
export const runContextStore = new AsyncLocalStorage();
export function runInLoggerContext(fn, context = loggerContextStore.getStore()) {
    if (!context)
        return fn;
    return ((...args) => loggerContextStore.run(context, () => fn(...args)));
}
//# sourceMappingURL=asyncContext.js.map