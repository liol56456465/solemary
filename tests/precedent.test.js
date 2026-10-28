import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatPrecedent, precedentHint } = await import('../src/services/enforcement/precedentService.js');

const HOUR = 3600000;

test('precedent: top buckets by count, durations, overturned appeals', () => {
    const text = formatPrecedent('Spam', [
        { type: 'warn', duration_ms: null, count: 4, overturned: 0 },
        { type: 'mute', duration_ms: HOUR, count: 9, overturned: 2 },
        { type: 'ban', duration_ms: null, count: 1, overturned: 0 },
    ]);
    assert.equal(text, 'Similar cases (reason "Spam", last 180 days): 14 — usually Mute 1 hour (9), Warn (4), Ban (permanent) (1); 2 overturned on appeal.');
});

test('precedent: no cases, nothing overturned, only three buckets', () => {
    assert.equal(formatPrecedent('Spam', []), 'Similar cases (reason "Spam", last 180 days): none yet.');
    const text = formatPrecedent('NSFW content', [
        { type: 'ban', duration_ms: 7 * 24 * HOUR, count: 2, overturned: 0 },
        { type: 'kick', duration_ms: null, count: 2, overturned: 0 },
        { type: 'warn', duration_ms: null, count: 1, overturned: 0 },
        { type: 'mute', duration_ms: HOUR, count: 1, overturned: 0 },
    ]);
    assert.equal(text, 'Similar cases (reason "NSFW content", last 180 days): 6 — usually Ban 7 days (2), Kick (2), Mute 1 hour (1); none overturned on appeal.');
});

test('precedent hint: skipped for custom reasons and missing keys (no database touched)', async () => {
    assert.equal(await precedentHint('1', 'custom', 'x'), null);
    assert.equal(await precedentHint('1', null, 'x'), null);
});
