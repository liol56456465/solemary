import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    formatPrecedent, precedentHint, loadPrecedent, memberLadderLine, memberLadderHint,
    CUSTOM_REASON_HINT, PRECEDENT_UNAVAILABLE, MEMBER_UNAVAILABLE,
} = await import('../src/services/enforcement/precedentService.js');
const { completeFlowDetails, reasonPatch, startFlow } = await import('../src/services/enforcement/flowBuilder.js');
const { confirmationPayload } = await import('../src/handlers/enforcementPanel.js');

const HOUR = 3600000;

// ── formatter ────────────────────────────────────────────────────────────────

test('consistency hint: counts per action, most common, overturned appeals', () => {
    const text = formatPrecedent('Spam', [
        { type: 'warn', duration_ms: null, count: 15, overturned: 0 },
        { type: 'mute', duration_ms: HOUR, count: 3, overturned: 2 },
        { type: 'mute', duration_ms: 24 * HOUR, count: 2, overturned: 0 },
        { type: 'kick', duration_ms: null, count: 2, overturned: 0 },
        { type: 'ban', duration_ms: null, count: 1, overturned: 0 },
    ]);
    assert.equal(text, 'Similar cases (reason "Spam", last 180 days, 23 cases): 15 warns · 5 mutes · 2 kicks · 1 ban. Most common: warn. 2 overturned on appeal.');
});

test('consistency hint: a mute/ban on top names its usual length; ties go to the lighter action', () => {
    assert.equal(
        formatPrecedent('Spam', [
            { type: 'mute', duration_ms: HOUR, count: 9, overturned: 0 },
            { type: 'mute', duration_ms: 24 * HOUR, count: 2, overturned: 0 },
            { type: 'warn', duration_ms: null, count: 4, overturned: 0 },
        ]),
        'Similar cases (reason "Spam", last 180 days, 15 cases): 4 warns · 11 mutes. Most common: mute, usually 1 hour.',
    );
    assert.equal(
        formatPrecedent('Raiding', [{ type: 'ban', duration_ms: null, count: 1, overturned: 0 }]),
        'Similar cases (reason "Raiding", last 180 days, 1 case): 1 ban. Most common: ban, usually permanent.',
    );
    assert.match(formatPrecedent('X', [
        { type: 'ban', duration_ms: null, count: 2, overturned: 0 },
        { type: 'kick', duration_ms: null, count: 2, overturned: 0 },
    ]), /Most common: kick\.$/);
});

test('consistency hint: empty, capped at the newest 200, short enough for an embed field', () => {
    assert.equal(formatPrecedent('Spam', []), 'Similar cases (reason "Spam", last 180 days): No similar cases yet.');
    const capped = formatPrecedent('Spam', [{ type: 'warn', duration_ms: null, count: 200, overturned: 0 }]);
    assert.equal(capped, 'Similar cases (reason "Spam", last 180 days, newest 200 cases): 200 warns. Most common: warn.');
    const long = formatPrecedent('x'.repeat(100), [
        { type: 'warn', duration_ms: null, count: 50, overturned: 3 },
        { type: 'mute', duration_ms: 3 * 24 * HOUR + 5 * HOUR + 7 * 60000, count: 60, overturned: 4 },
        { type: 'kick', duration_ms: null, count: 40, overturned: 1 },
        { type: 'ban', duration_ms: 30 * 24 * HOUR, count: 50, overturned: 9 },
    ]);
    assert.ok(long.length < 1024, `${long.length} chars`);
});

test('member line: level 0 counts towards 3; higher levels say the next warning bans', () => {
    assert.equal(memberLadderLine({ level: 0, warns_since_level: 1 }), 'This member: 1 of 3 counted warnings, ladder level 0.');
    assert.equal(memberLadderLine({ level: 2, warns_since_level: 0 }), 'This member: 0 counted warnings, ladder level 2 (the next warning bans).');
    assert.equal(memberLadderLine(null), 'This member: 0 of 3 counted warnings, ladder level 0.');
});

// ── query ────────────────────────────────────────────────────────────────────

test('query: one GROUP BY over the newest 200 human cases in the 180-day window', async () => {
    const calls = [];
    const run = async (text, params) => {
        calls.push({ text, params });
        return { rows: [{ type: 'mute', duration_ms: String(HOUR), count: 3, overturned: 1 }, { type: 'warn', duration_ms: null, count: 2, overturned: 0 }] };
    };
    const rows = await loadPrecedent('g1', 'spam', { run });
    assert.equal(calls.length, 1, 'one query');
    const [{ text, params }] = calls;
    assert.deepEqual(params, ['g1', 'spam', 180, 200]);
    for (const part of [
        'c.guild_id = $1', 'c.reason_key = $2', 'make_interval(days => $3)', 'LIMIT $4',
        'c.is_test = FALSE', 'c.voided_at IS NULL', 'c.is_imported = FALSE',
        'ORDER BY c.created_at DESC', 'GROUP BY recent.type, recent.duration_ms', "a.status = 'accepted'",
    ]) assert.ok(text.includes(part), part);
    assert.deepEqual(rows, [
        { type: 'mute', duration_ms: HOUR, count: 3, overturned: 1 },
        { type: 'warn', duration_ms: null, count: 2, overturned: 0 },
    ]);
    await loadPrecedent('g1', 'spam', { run, days: 30, limit: 50 });
    assert.deepEqual(calls[1].params, ['g1', 'spam', 30, 50]);
});

// ── never blocks, never breaks ───────────────────────────────────────────────

test('hint: custom reason → no comparison; no reason key → nothing (no database touched)', async () => {
    const load = async () => { throw new Error('must not load'); };
    assert.equal(await precedentHint('1', 'custom', 'x', { load }), CUSTOM_REASON_HINT);
    assert.equal(CUSTOM_REASON_HINT, 'Custom reason: no comparison.');
    assert.equal(await precedentHint('1', null, 'x', { load }), null);
});

test('hint: a database error or a slow query gives "unavailable right now", within the timeout', async () => {
    assert.equal(await precedentHint('1', 'spam', 'Spam', { load: async () => { throw new Error('db down'); } }), PRECEDENT_UNAVAILABLE);
    assert.equal(await precedentHint('1', 'spam', 'Spam', { load: () => { throw new Error('sync throw'); } }), PRECEDENT_UNAVAILABLE);
    const started = Date.now();
    assert.equal(await precedentHint('1', 'spam', 'Spam', { timeoutMs: 30, load: () => new Promise(() => {}) }), PRECEDENT_UNAVAILABLE);
    assert.ok(Date.now() - started < 1000, 'gave up after the timeout');
    assert.equal(PRECEDENT_UNAVAILABLE, 'Similar cases: unavailable right now.');
    assert.match(await precedentHint('1', 'spam', 'Spam', { load: async () => [] }), /No similar cases yet/);
});

test('member hint: uses the given ladder, else loads it; error/timeout → unavailable', async () => {
    const getLadder = async () => { throw new Error('must not load'); };
    assert.equal(await memberLadderHint('g', 'u', { ladder: { level: 1, warns_since_level: 0 }, getLadder }), 'This member: 0 counted warnings, ladder level 1 (the next warning bans).');
    assert.equal(await memberLadderHint('g', 'u', { getLadder: async () => ({ level: 0, warns_since_level: 2 }) }), 'This member: 2 of 3 counted warnings, ladder level 0.');
    assert.equal(await memberLadderHint('g', 'u', { getLadder }), MEMBER_UNAVAILABLE);
    assert.equal(await memberLadderHint('g', 'u', { getLadder: () => new Promise(() => {}), timeoutMs: 20 }), MEMBER_UNAVAILABLE);
});

// ── the panel's confirm step ─────────────────────────────────────────────────

const guild = { id: 'g1', members: { fetch: async () => null } };
const targetUser = { id: '200000000000000002', username: 'target' };
const baseDeps = {
    isNameTaken: async () => false,
    nextDefaultName: async (g, u, name, type) => `${name} ${type} 1`,
    assertBotPermissions: () => {},
    assertCanTarget: () => {},
    getTargetState: async () => ({ ladder: { level: 0, warns_since_level: 1 } }),
    captureLinks: async () => [],
    getLadder: async () => ({ level: 1, warns_since_level: 0 }),
};

async function panelConfirm(type, reasonKey, deps, patch = {}) {
    const flow = Object.assign(startFlow({ type, moderatorId: '1', targetUser }), reasonPatch({ type }, reasonKey));
    const result = await completeFlowDetails({ guild, moderator: {}, targetUser, flow, patch: { durationMs: HOUR, ...patch }, deps: { ...baseDeps, ...deps } });
    assert.equal(result.fatal, null);
    Object.assign(flow, result.patch);
    return confirmationPayload(flow, '1', 'nonce').embeds[0].data.description;
}

test('panel confirm step: similar cases + the member line', async () => {
    const text = await panelConfirm('mute', 'spam', {
        precedentHint: (g, key, label) => precedentHint(g, key, label, { load: async () => [{ type: 'mute', duration_ms: HOUR, count: 2, overturned: 0 }] }),
    });
    assert.match(text, /-# Similar cases \(reason "Spam", last 180 days, 2 cases\): 2 mutes\. Most common: mute, usually 1 hour\./);
    assert.match(text, /-# This member: 0 counted warnings, ladder level 1 \(the next warning bans\)\./, 'mute: ladder loaded with getLadder');
    const warn = await panelConfirm('warn', 'spam', { precedentHint: async () => 'x' });
    assert.match(warn, /This member: 1 of 3 counted warnings, ladder level 0\./, 'warn: the ladder from getTargetState');
});

test('panel confirm step: custom reason says so; database error and timeout degrade to "unavailable", the action stays possible', async () => {
    const custom = await panelConfirm('warn', 'custom', {}, { customReason: 'rude', reason: 'rude' });
    assert.match(custom, /-# Custom reason: no comparison\./);

    const down = await panelConfirm('kick', 'spam', {
        precedentHint: (g, key, label) => precedentHint(g, key, label, { load: async () => { throw new Error('db down'); } }),
        getLadder: async () => { throw new Error('db down'); },
    });
    assert.match(down, /-# Similar cases: unavailable right now\./);
    assert.match(down, /-# This member: ladder unavailable right now\./);

    const started = Date.now();
    const slow = await panelConfirm('kick', 'spam', {
        precedentHint: (g, key, label) => precedentHint(g, key, label, { timeoutMs: 30, load: () => new Promise(() => {}) }),
    });
    assert.ok(Date.now() - started < 1000);
    assert.match(slow, /Similar cases: unavailable right now/);

    // Even a replaced hint function that throws does not break the step.
    const thrown = await panelConfirm('kick', 'spam', { precedentHint: async () => { throw new Error('boom'); } });
    assert.match(thrown, /Similar cases: unavailable right now/);
});
