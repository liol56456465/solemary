// Owner → Recent errors, recording side (utils/errorEvents.js, services/owner/errorEventStore.js):
// the row holds no user IDs or member text, the in-memory rate limit, a failing insert is
// swallowed with one throttled warning, the insert prunes to the newest 500, and
// handleInteractionError / handleTaskError record system errors only, without changing the reply.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    KEEP_ROWS, MESSAGE_MAX, RATE_LIMIT, cleanErrorMessage, createErrorRecorder, errorEventRow, interactionSource, setErrorEventSink,
} from '../src/utils/errorEvents.js';
import { insertErrorEvent, listErrorGroups, parseErrorSearch } from '../src/services/owner/errorEventStore.js';
import { createError, ErrorTypes, handleInteractionError, handleTaskError } from '../src/utils/errorHandler.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const quietLog = () => {
    const warnings = [];
    return { warnings, warn: (msg) => warnings.push(msg) };
};

test('row: IDs masked, message cut to 300, trace cut to 8, a bad server id dropped', () => {
    const row = errorEventRow({
        errorCode: 'COMMAND_ERROR', errorType: 'unknown', source: 'enf:', guildId: '1527697154926182492',
        traceId: 'int_abcdef0123456789', message: `Unknown member 1531096173786566697\n${'x'.repeat(400)}`,
    });
    assert.equal(row.trace_id, 'int_abcd');
    assert.equal(row.guild_id, '1527697154926182492');
    assert.ok(row.message.startsWith('Unknown member <id> x'));
    assert.ok(!row.message.includes('1531096173786566697'));
    assert.equal(row.message.length, MESSAGE_MAX);
    assert.equal(errorEventRow({ errorCode: 'X', guildId: 'not-an-id' }).guild_id, null);
    assert.equal(errorEventRow({}).error_code, 'UNKNOWN');
    assert.equal(cleanErrorMessage(null), '');
    assert.equal(cleanErrorMessage('invalid input syntax for type bigint: "hello there"'), 'invalid input syntax for type bigint: "…"', 'quoted input masked');
    assert.equal(cleanErrorMessage(`Unexpected token 'h', "hello" is not valid JSON`), 'Unexpected token "…", "…" is not valid JSON');
});

test('source: command name, else the customId prefix (no IDs from the customId)', () => {
    assert.equal(interactionSource({ commandName: 'ban', customId: 'x' }), 'ban');
    assert.equal(interactionSource({ customId: 'enf:confirm:1531096173786566697:1527697154926182492:n0' }), 'enf:');
    assert.equal(interactionSource({}, { command: 'help' }), 'help');
    assert.equal(interactionSource(null), 'interaction');
});

test('rate limit: at most 30 a minute, then a fresh window', async () => {
    let at = 1_000_000;
    const rows = [];
    const rec = createErrorRecorder({ sink: async (row) => rows.push(row), now: () => at, log: quietLog() });
    const accepted = Array.from({ length: 50 }, (_, i) => rec.record({ errorCode: 'E', source: `s${i}` }));
    assert.equal(accepted.filter(Boolean).length, RATE_LIMIT);
    await flush();
    assert.equal(rows.length, RATE_LIMIT);
    assert.deepEqual(rec.stats(), { used: RATE_LIMIT, dropped: 20 });
    at += 60_000;
    assert.equal(rec.record({ errorCode: 'E', source: 'later' }), true);
    await flush();
    assert.equal(rows.length, RATE_LIMIT + 1);
});

test('a failing insert is swallowed: never throws, one warning per 5 minutes', async () => {
    let at = 0;
    const log = quietLog();
    const rec = createErrorRecorder({ sink: async () => { throw new Error('db down'); }, now: () => at, log });
    for (let i = 0; i < 5; i += 1) assert.doesNotThrow(() => rec.record({ errorCode: 'E', source: 's' }));
    await flush();
    assert.equal(log.warnings.length, 1);
    assert.match(log.warnings[0], /db down/);
    at += 5 * 60_000;
    rec.record({ errorCode: 'E', source: 's' });
    await flush();
    assert.equal(log.warnings.length, 2);
    assert.match(log.warnings[1], /5 failed since the last warning/);

    // A sink that throws synchronously, and a logger that throws, still never reach the caller.
    const bad = createErrorRecorder({ sink: () => { throw new Error('sync'); }, log: { warn: () => { throw new Error('log'); } } });
    assert.doesNotThrow(() => bad.record({ errorCode: 'E' }));
    await flush();
});

test('insert: one INSERT, then prune to the newest 500 (keeps 499 + the new one)', async () => {
    const calls = [];
    const query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
    await insertErrorEvent(errorEventRow({ errorCode: 'E', errorType: 'unknown', source: 'ban', guildId: '1527697154926182492', traceId: 'int_ab12', message: 'boom' }), { query });
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /^INSERT INTO error_events \(error_code, error_type, source, guild_id, trace_id, message\)/);
    assert.deepEqual(calls[0].params, ['E', 'unknown', 'ban', '1527697154926182492', 'int_ab12', 'boom']);
    assert.match(calls[1].sql, /^DELETE FROM error_events WHERE id < \(SELECT id FROM error_events ORDER BY id DESC OFFSET \$1 LIMIT 1\)/);
    assert.deepEqual(calls[1].params, [KEEP_ROWS - 1]);
});

test('read: a database error throws (never an empty list); search parses a pasted Ref', async () => {
    await assert.rejects(listErrorGroups({}, { query: async () => { throw new Error('timeout'); } }), /timeout/);
    assert.deepEqual(parseErrorSearch('COMMAND_ERROR · int_AB12cd'), { trace: 'int_ab12', code: 'COMMAND_ERROR' });
    assert.deepEqual(parseErrorSearch('`int_ab`'), { trace: 'int_ab', code: null });
    assert.deepEqual(parseErrorSearch("'; DROP TABLE x; --"), { trace: null, code: 'TABLE' });
    assert.deepEqual(parseErrorSearch(''), { trace: null, code: null });
    assert.deepEqual(parseErrorSearch('TASK_ERROR'), { trace: null, code: 'TASK_ERROR' }, 'a code, not a trace');
    assert.deepEqual(parseErrorSearch('RATE_LIMITED · trc_9f3a'), { trace: 'trc_9f3a', code: 'RATE_LIMITED' });
    const calls = [];
    const query = async (sql, params) => { calls.push({ sql, params }); return { rows: sql.includes('COUNT(*)::int AS n') ? [{ n: 3 }] : [{ error_code: 'E' }] }; };
    const result = await listErrorGroups({ trace: 'int_ab', code: 'E' }, { query });
    assert.deepEqual(result, { groups: [{ error_code: 'E' }], total: 3 });
    assert.deepEqual(calls[0].params, ['int_ab', 'E', 50], 'values only as parameters');
    assert.match(calls[0].sql, /GROUP BY error_code, source/);
});

function fakeInteraction(over = {}) {
    const replies = [];
    return {
        replies, id: '1', commandName: 'ban', guildId: '1527697154926182492', user: { id: '1531096173786566697' },
        traceId: 'int_0123456789abcdef', deferred: false, replied: false,
        isRepliable: () => true, isChatInputCommand: () => true,
        reply: async (payload) => { replies.push(payload); return payload; },
        followUp: async (payload) => { replies.push(payload); return payload; },
        editReply: async (payload) => { replies.push(payload); return payload; },
        ...over,
    };
}
const embedText = (i) => JSON.stringify(i.replies.at(-1)?.embeds?.map((e) => e.data ?? e) ?? '');

test('handleInteractionError: a system error is recorded (no user ID); user errors are not', async (t) => {
    const rows = [];
    setErrorEventSink(async (row) => rows.push(row));
    t.after(() => setErrorEventSink(null));

    const system = fakeInteraction();
    await handleInteractionError(system, new Error('pool exhausted for 1531096173786566697'));
    await flush();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'ban');
    assert.equal(rows[0].guild_id, '1527697154926182492');
    assert.equal(rows[0].trace_id, 'int_0123');
    assert.ok(!JSON.stringify(rows[0]).includes('1531096173786566697'), 'no user ID anywhere in the row');
    assert.match(embedText(system), /Ref: `[A-Z_]+ · int_0123`/, 'the Ref the user saw has the same trace');
    assert.ok(embedText(system).includes(rows[0].error_code));

    await handleInteractionError(fakeInteraction(), createError('bad input', ErrorTypes.VALIDATION, 'Pick a member.'));
    await handleInteractionError(fakeInteraction(), createError('expected', ErrorTypes.DATABASE, 'Try later.', { expected: true }));
    await flush();
    assert.equal(rows.length, 1, 'user / expected errors (no Ref) are not recorded');
});

test('handleInteractionError: a failing record never changes the reply', async (t) => {
    t.after(() => setErrorEventSink(null));
    setErrorEventSink(async () => ({}));
    const ok = fakeInteraction();
    await handleInteractionError(ok, new Error('boom'));
    setErrorEventSink(async () => { throw new Error('insert failed'); });
    const failing = fakeInteraction();
    await assert.doesNotReject(handleInteractionError(failing, new Error('boom')));
    await flush();
    assert.equal(failing.replies.length, 1);
    assert.equal(embedText(failing), embedText(ok));
});

test('handleTaskError records the task name, server and code', async (t) => {
    const rows = [];
    setErrorEventSink(async (row) => rows.push(row));
    t.after(() => setErrorEventSink(null));
    handleTaskError('giveaway_check', new Error('Missing Access'), { guildId: '1527697154926182492' });
    await flush();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'giveaway_check');
    assert.equal(rows[0].guild_id, '1527697154926182492');
    assert.ok(rows[0].error_code);
    assert.equal(rows[0].message, 'Missing Access');
});
