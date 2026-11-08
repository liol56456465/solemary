// boundedMap.js — a Map (and a Set) with a hard size limit, for in-memory caches and
// counters keyed by guild, channel or member. The bot may be in thousands of servers, so
// every such map must stay bounded even when its time-based pruning has not run yet.
//
// set() of a new key when full drops the oldest entry (insertion order; setting an
// existing key moves it to the end, so busy keys stay). Only use it for state whose loss
// is safe: a cache that is re-read, or a short window counter that simply restarts.

export class BoundedMap extends Map {
    constructor(maxSize, entries = null) {
        super();
        if (!(Number.isInteger(maxSize) && maxSize > 0)) throw new Error('BoundedMap needs a positive integer size');
        this.maxSize = maxSize;
        if (entries) for (const [key, value] of entries) this.set(key, value);
    }

    set(key, value) {
        if (super.has(key)) super.delete(key);
        else if (this.size >= this.maxSize) super.delete(this.keys().next().value);
        return super.set(key, value);
    }
}

export class BoundedSet extends Set {
    constructor(maxSize) {
        super();
        if (!(Number.isInteger(maxSize) && maxSize > 0)) throw new Error('BoundedSet needs a positive integer size');
        this.maxSize = maxSize;
    }

    add(value) {
        if (super.has(value)) super.delete(value);
        else if (this.size >= this.maxSize) super.delete(this.values().next().value);
        return super.add(value);
    }
}
