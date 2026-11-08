import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventLoopMonitor, EVENT_LOOP_WARN_P99_MS } from '../src/utils/eventLoopMonitor.js';

function fakeHistogram(p99Ms, maxMs = p99Ms) {
    return {
        resets: 0,
        count: 100,
        mean: 5e6,
        max: maxMs * 1e6,
        percentile: (p) => (p === 99 ? p99Ms : 10) * 1e6,
        reset() { this.resets += 1; },
        enable() {},
        disable() {},
    };
}

const quietLog = () => {
    const lines = [];
    return { lines, warn: (m) => lines.push(m) };
};

test('warns when p99 is above 500 ms, not at or below', () => {
    assert.equal(EVENT_LOOP_WARN_P99_MS, 500);
    const atLimit = quietLog();
    createEventLoopMonitor({ histogram: fakeHistogram(500), log: atLimit }).sample();
    assert.equal(atLimit.lines.length, 0);

    const slow = quietLog();
    const h = fakeHistogram(812, 1500);
    const monitor = createEventLoopMonitor({ histogram: h, log: slow });
    const result = monitor.sample();
    assert.equal(result.p99Ms, 812);
    assert.equal(result.maxMs, 1500);
    assert.equal(slow.lines.length, 1);
    assert.match(slow.lines[0], /Event loop lag: p99 812 ms/);
    assert.equal(h.resets, 1, 'each sample covers one interval');
    assert.equal(monitor.last().p99Ms, 812);
});

test('samples once per interval after start, and stops cleanly', () => {
    const intervals = [];
    const monitor = createEventLoopMonitor({
        histogram: fakeHistogram(20),
        log: quietLog(),
        setIntervalFn: (fn, ms) => { const t = { fn, ms }; intervals.push(t); return t; },
        clearIntervalFn: (t) => { t.cleared = true; },
    });
    assert.equal(monitor.last(), null);
    monitor.start();
    monitor.start();
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 60_000);
    intervals[0].fn();
    assert.equal(monitor.last().p99Ms, 20);
    monitor.stop();
    assert.equal(intervals[0].cleared, true);
});
