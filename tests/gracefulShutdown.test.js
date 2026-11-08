import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGracefulShutdown, shutdownExitCode, waitForIdle } from '../src/utils/gracefulShutdown.js';

const quietLog = () => {
    const lines = [];
    return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
};

function fakes(order, { running = new Set() } = {}) {
    let exitCode = null;
    const log = quietLog();
    const deps = {
        log,
        running,
        stopCrons: () => order.push('stopCrons'),
        destroyClient: async () => order.push('destroyClient'),
        flushers: [['activity', async () => order.push('flushActivity')], ['staff', async () => order.push('flushStaffMessages')]],
        closeHttp: async () => order.push('closeHttp'),
        closeDb: async () => order.push('closeDb'),
        exit: (code) => { order.push(`exit:${code}`); exitCode = code; },
        pollMs: 5,
    };
    return { deps, log, exitCode: () => exitCode };
}

test('shutdown: crons, drain, client, flushes, HTTP, database, then exit 0 on a signal', async () => {
    const order = [];
    const running = new Set(['activity_flush']);
    const { deps } = fakes(order, { running });
    const shutdown = createGracefulShutdown(deps);
    setTimeout(() => { order.push('job finished'); running.clear(); }, 20);
    await shutdown('SIGTERM');
    assert.deepEqual(order, [
        'stopCrons', 'job finished', 'destroyClient', 'flushActivity', 'flushStaffMessages', 'closeHttp', 'closeDb', 'exit:0',
    ]);
});

test('shutdown: runs once; a second call gets the same run', async () => {
    const order = [];
    const { deps } = fakes(order);
    const shutdown = createGracefulShutdown(deps);
    const a = shutdown('SIGINT');
    const b = shutdown('UNCAUGHT_EXCEPTION');
    assert.equal(a, b);
    await a;
    assert.equal(order.filter((s) => s === 'stopCrons').length, 1);
    assert.deepEqual(order.filter((s) => s.startsWith('exit')), ['exit:0']);
});

test('shutdown: exit code 1 when the reason is not a signal', async () => {
    assert.equal(shutdownExitCode('SIGTERM'), 0);
    assert.equal(shutdownExitCode('SIGINT'), 0);
    assert.equal(shutdownExitCode('UNCAUGHT_EXCEPTION'), 1);
    assert.equal(shutdownExitCode('STARTUP_ERROR'), 1);
    const order = [];
    const { deps } = fakes(order);
    await createGracefulShutdown(deps)('UNCAUGHT_EXCEPTION');
    assert.equal(order.at(-1), 'exit:1');
});

test('shutdown: a failing step is logged and the rest still run', async () => {
    const order = [];
    const { deps, log } = fakes(order);
    deps.destroyClient = async () => { throw new Error('gateway gone'); };
    await createGracefulShutdown(deps)('SIGTERM');
    assert.deepEqual(order, ['stopCrons', 'flushActivity', 'flushStaffMessages', 'closeHttp', 'closeDb', 'exit:0']);
    assert.ok(log.lines.some(([level, m]) => level === 'warn' && m.includes('gateway gone')));
});

test('shutdown: the cron wait is capped; the rest still runs', async () => {
    const order = [];
    const { deps, log } = fakes(order, { running: new Set(['stuck_job']) });
    await createGracefulShutdown({ ...deps, cronDrainMs: 30 })('SIGTERM');
    assert.deepEqual(order, ['stopCrons', 'destroyClient', 'flushActivity', 'flushStaffMessages', 'closeHttp', 'closeDb', 'exit:0']);
    assert.ok(log.lines.some(([, m]) => m.includes('stuck_job')));
});

test('shutdown: the hard timeout exits 1 when a step hangs, and exit is called only once', async () => {
    const order = [];
    const { deps } = fakes(order);
    let release;
    deps.closeHttp = () => new Promise((resolve) => { release = resolve; });
    const run = createGracefulShutdown({ ...deps, timeoutMs: 30 })('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(order.filter((s) => s.startsWith('exit')), ['exit:1']);
    release();
    await run;
    assert.deepEqual(order.filter((s) => s.startsWith('exit')), ['exit:1']);
});

test('waitForIdle: true at once for an empty or missing set', async () => {
    assert.equal(await waitForIdle(new Set()), true);
    assert.equal(await waitForIdle(() => undefined), true);
});
