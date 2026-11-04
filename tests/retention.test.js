// Retention job wiring (privacy/retentionService.js) and the case-erase rules (caseErase.js),
// without a database: the daily 03:30 UTC cron and the startup run share one overlap-guarded
// job, the startup run waits 5 minutes after ready, a failing rule does not stop the others,
// the summary log has counts only; which cases are anonymised, deleted or refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    RETENTION_CRON, RETENTION_JOB, RETENTION_STARTUP_DELAY_MS, RETENTION_RULES, runRetention, scheduleRetention,
} = await import('../src/services/privacy/retentionService.js');
const { erasePlan, deleteEvidenceMessages } = await import('../src/services/privacy/caseErase.js');
const { logger } = await import('../src/utils/logger.js');

test('scheduleRetention: daily at 03:30 UTC and once 5 minutes after ready, through the overlap guard', async () => {
    const scheduled = [];
    const timers = [];
    const wrapped = [];
    let ran = 0;
    let readyFn = null;
    const job = scheduleRetention({
        schedule: (expression, fn, options) => scheduled.push({ expression, fn, options }),
        wrap: (name, fn) => { const w = async () => fn(); wrapped.push({ name, w }); return w; },
        run: async () => { ran += 1; },
        whenReady: (fn) => { readyFn = fn; },
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() { this.unrefed = true; } }; },
    });
    assert.equal(RETENTION_CRON, '30 3 * * *');
    assert.deepEqual(wrapped.map((w) => w.name), [RETENTION_JOB], 'one guarded job');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].expression, '30 3 * * *');
    assert.deepEqual(scheduled[0].options, { timezone: 'UTC' });
    assert.equal(scheduled[0].fn, job);
    assert.equal(timers.length, 0, 'nothing runs before ready');
    readyFn();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 5 * 60 * 1000);
    assert.equal(RETENTION_STARTUP_DELAY_MS, 5 * 60 * 1000);
    assert.equal(timers[0].fn, job, 'startup run is the same guarded job');
    await timers[0].fn();
    assert.equal(ran, 1);
});

test('app.js wires the retention job inside setupCronJobs (after the test-mode early return)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
    const start = src.indexOf('setupCronJobs() {');
    const testModeReturn = src.indexOf('return;', src.indexOf('testMode.cronEnabled', start));
    const wiring = src.indexOf('scheduleRetention({', start);
    assert.ok(start > 0 && testModeReturn > start && wiring > testModeReturn, 'cron off in test mode unless TEST_ENABLE_CRON=true');
    assert.match(src.slice(wiring, wiring + 400), /wrap: exclusive/);
    assert.match(src.slice(wiring, wiring + 400), /runRetention\(this\)/);
});

test('runRetention: a failing rule is logged and the others still run; the summary has counts only', async () => {
    const lines = [];
    const origInfo = logger.info;
    const origWarn = logger.warn;
    logger.info = (m) => lines.push(['info', m]);
    logger.warn = (m) => lines.push(['warn', m]);
    try {
        const order = [];
        const rules = [
            ['a', async () => { order.push('a'); return 2; }],
            ['b', async () => { order.push('b'); throw new Error('connection refused'); }],
            ['c', async ({ now }) => { order.push('c'); assert.equal(now, 123); return 0; }],
        ];
        const result = await runRetention(null, { rules, now: 123, query: async () => ({ rowCount: 0 }) });
        assert.deepEqual(order, ['a', 'b', 'c']);
        assert.deepEqual(result, { counts: { a: 2, c: 0 }, failed: ['b'] });
        assert.deepEqual(lines.find(([level]) => level === 'info'), ['info', 'Retention: deleted a=2 c=0 failed=b']);
        assert.ok(lines.some(([level, m]) => level === 'warn' && m.includes('rule b failed')));
    } finally {
        logger.info = origInfo;
        logger.warn = origWarn;
    }
});

test('the rules: one bounded DELETE each, cutoff and limit as parameters', async () => {
    assert.deepEqual(RETENTION_RULES.map(([name]) => name), ['watchlist', 'no_contact', 'raid_reports', 'verification_audit', 'verification_ips']);
    const now = Date.parse('2026-11-04T03:30:00Z');
    for (const [name, rule] of RETENTION_RULES) {
        const seen = [];
        const n = await rule({ query: async (text, params) => { seen.push({ text, params }); return { rowCount: 3 }; }, now, limit: 7 });
        assert.equal(n, 3, name);
        assert.equal(seen.length, 1, `${name}: one statement`);
        assert.match(seen[0].text, /^\s*DELETE FROM/, name);
        assert.match(seen[0].text, /LIMIT \$\d/, `${name}: bounded`);
        assert.ok(seen[0].params.includes(7), `${name}: limit passed`);
        const cutoff = seen[0].params.find((p) => p instanceof Date);
        const days = Math.round((now - cutoff.getTime()) / 86_400_000);
        assert.equal(days, name === 'verification_ips' ? 60 : 365, name);
    }
});

test('erasePlan: active ladder warn → anonymise; everything else → delete; pending appeal / ban or mute in force → refused', () => {
    const now = Date.parse('2026-11-04T00:00:00Z');
    const base = { type: 'warn', status: 'active', is_imported: false, is_test: false, expires_at: null };
    assert.deepEqual(erasePlan(base, { now }), { mode: 'anonymise', refusal: null });
    assert.equal(erasePlan({ ...base, status: 'revoked' }, { now }).mode, 'delete');
    assert.equal(erasePlan({ ...base, status: 'expired' }, { now }).mode, 'delete');
    assert.equal(erasePlan({ ...base, is_imported: true }, { now }).mode, 'delete');
    assert.equal(erasePlan({ ...base, is_test: true }, { now }).mode, 'delete');
    assert.equal(erasePlan({ ...base, type: 'kick' }, { now }).mode, 'delete');
    assert.equal(erasePlan({ ...base, type: 'ban', status: 'expired', expires_at: new Date(now - 1) }, { now }).mode, 'delete');
    assert.match(erasePlan({ ...base, type: 'ban', expires_at: new Date(now - 1) }, { now }).refusal, /still in force/, 'past its end but not lifted yet');
    assert.equal(erasePlan({ ...base, type: 'ban', status: 'revoked' }, { now }).mode, 'delete');
    assert.equal(erasePlan({ ...base, type: 'ban', is_test: true }, { now }).mode, 'delete');
    assert.match(erasePlan({ ...base, type: 'ban' }, { now }).refusal, /ban is still in force/);
    assert.match(erasePlan({ ...base, type: 'mute', expires_at: new Date(now + 1000) }, { now }).refusal, /mute is still in force/);
    assert.match(erasePlan({ ...base, status: 'appeal_pending' }, { now }).refusal, /appeal/);
    assert.match(erasePlan({ ...base, type: 'kick' }, { now, pendingAppeal: true }).refusal, /appeal/);
    assert.match(erasePlan(null).refusal, /no case/);
});

test('deleteEvidenceMessages: best effort; an already deleted message counts as deleted', async () => {
    const deleted = [];
    const client = { channels: { fetch: async (id) => (id === 'gone' ? null : {
        messages: { delete: async (m) => { if (m === 'unknown') { const e = new Error('Unknown Message'); e.code = 10008; throw e; } if (m === 'denied') throw new Error('Missing Access'); deleted.push(m); } },
    }) } };
    const result = await deleteEvidenceMessages(client, [
        { channelId: 'c', messageId: 'm1' }, { channelId: 'c', messageId: 'unknown' }, { channelId: 'c', messageId: 'denied' }, { channelId: 'gone', messageId: 'm2' },
    ]);
    assert.deepEqual(result, { deleted: 2, failed: 2 });
    assert.deepEqual(deleted, ['m1']);
});
