export class Timer {
    name;
    duration;
    startTime;
    constructor(name) {
        this.name = name;
        this.startTime = performance.now();
    }
    end() {
        this.duration = performance.now() - this.startTime;
    }
    toString() {
        if (this.duration === undefined) {
            return this.name;
        }
        return `${this.name}, took ${(this.duration / 1000).toFixed(2)}s`;
    }
}
//# sourceMappingURL=Timer.js.map