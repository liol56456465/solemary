// Recent warnings and errors for the owner Health page (src/utils/recentLogs.js): only
// warn/error, newest first, capped, first line only, secrets masked before they are stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import winston from 'winston';
import { RECENT_LOG_TEXT_MAX, RecentLogTransport, createRecentLogBuffer, maskLogText } from '../src/utils/recentLogs.js';

test('secrets are masked; IDs, paths and plain text stay', () => {
    const token = `${'M'.repeat(26)}.${'G'.repeat(6)}.${'x'.repeat(38)}`;
    assert.equal(maskLogText(`login failed for ${token}`), 'login failed for [token]');
    assert.equal(maskLogText('connect postgresql://neondb_owner:pa55word@ep-x.neon.tech/db failed'), 'connect postgresql://[credentials]@ep-x.neon.tech/db failed');
    assert.equal(maskLogText('header Bearer abcdefghijklmnopqrstuvwxyz012345'), 'header Bearer [secret]');
    assert.equal(maskLogText(`key ${'ab12'.repeat(16)} end`), 'key [secret] end');
    assert.equal(maskLogText(`k ${'Ab9_'.repeat(12)}`), 'k [secret]');
    assert.equal(maskLogText('guild 1527697154926182492 user 1531096173786566697'), 'guild 1527697154926182492 user 1531096173786566697');
    assert.equal(maskLogText('at /home/runner/workspace/src/services/dashboard/ownerRoutes.js:12'), 'at /home/runner/workspace/src/services/dashboard/ownerRoutes.js:12');
    assert.equal(maskLogText('first line\nsecond line'), 'first line');
    assert.equal(maskLogText('a b '.repeat(400)).length, RECENT_LOG_TEXT_MAX + 1);
    assert.equal(maskLogText(undefined), '');
});

test('the buffer keeps the newest lines only, newest first, as copies', () => {
    const buffer = createRecentLogBuffer(3);
    for (let i = 1; i <= 5; i += 1) buffer.push({ level: i % 2 ? 'warn' : 'error', message: `m${i}`, traceId: `trc_${i}` }, i * 1000);
    const list = buffer.list();
    assert.deepEqual(list.map((l) => l.text), ['m5', 'm4', 'm3']);
    assert.deepEqual(list.map((l) => l.level), ['warn', 'error', 'warn']);
    assert.equal(list[0].traceId, 'trc_5');
    list[0].text = 'changed';
    assert.equal(buffer.list()[0].text, 'm5');
});

test('through winston: info is not kept, warn and error are (stack first line, masked)', async () => {
    const buffer = createRecentLogBuffer();
    const log = winston.createLogger({ level: 'debug', format: winston.format.combine(winston.format.errors({ stack: true }), winston.format.json()), transports: [new RecentLogTransport({ buffer })] });
    log.info('just info');
    log.debug('debug');
    log.warn('slow gateway');
    log.error(new Error('db down postgres://u:secretpw@host/db'));
    await new Promise((resolve) => setImmediate(resolve));
    const list = buffer.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].level, 'error');
    assert.equal(list[0].text, 'Error: db down postgres://[credentials]@host/db');
    assert.equal(list[1].text, 'slow gateway');
});
