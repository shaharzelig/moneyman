export function addToKeyedSet(map, key, value) {
    if (!map.has(key)) {
        map.set(key, new Set());
    }
    map.get(key).add(value);
}
export function addToKeyedMap(map, key, kv) {
    if (!map.has(key)) {
        map.set(key, new Map());
    }
    map.get(key).set(...kv);
}
//# sourceMappingURL=collections.js.map