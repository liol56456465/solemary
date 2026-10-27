import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnowflakeUtil } from 'discord.js';
import {
    DEFAULT_GATE_DAYS, describeJoinGate, evaluateJoinGate, kickNotice, looksGenerated, nameHasLink, normalizeJoinGate,
} from '../../src/services/automod/joinGate.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 27);
const idAged = (days) => String(SnowflakeUtil.generate({ timestamp: now - days * DAY }));

test('join gate: settings default to all off, with the verification guard\'s age', () => {
    assert.equal(DEFAULT_GATE_DAYS, 7);
    assert.deepEqual(normalizeJoinGate(undefined), { avatar: 'off', links: 'off', botname: 'off', age: 'off', ageDays: 7 });
    assert.deepEqual(normalizeJoinGate({ avatar: 'kick', links: 'bogus', ageDays: 999 }),
        { avatar: 'kick', links: 'off', botname: 'off', age: 'off', ageDays: 365 });
});

test('join gate: link names', () => {
    for (const name of ['discord.gg/free', 'join discord.com/invite/abc', 'https://x', 'www.scam', 'nitro.gg/abc', 'free-nitro.com', 't.me/spam']) {
        assert.equal(nameHasLink(name), true, name);
    }
    for (const name of ['john.doe', 'sam_2004', 'Alice', 'mr.cool', null, '']) {
        assert.equal(nameHasLink(name), false, String(name));
    }
});

test('join gate: generated-looking usernames are matched conservatively', () => {
    for (const name of ['alex483920', 'user0000012', 'k3j9x0q2m7pz', 'a1b2c3d4e5f6']) assert.equal(looksGenerated(name), true, name);
    for (const name of ['sam_2004', 'john1990', 'alex12345_', 'coolgamer', 'xx_dark_xx', 'mike.2001', 'abcdefghijklmn']) {
        assert.equal(looksGenerated(name), false, name);
    }
});

test('join gate: only enabled checks hit, the strongest action wins', () => {
    const user = { id: idAged(2), username: 'alex483920', globalName: 'discord.gg/x', avatar: null };
    assert.deepEqual(evaluateJoinGate(user, {}, now), { action: 'off', hits: [] });

    const result = evaluateJoinGate(user, { avatar: 'flag', links: 'kick', botname: 'flag', age: 'flag' }, now);
    assert.equal(result.action, 'kick');
    assert.deepEqual(result.hits.map((hit) => hit.check), ['avatar', 'links', 'botname', 'age']);
    assert.match(result.hits[3].reason, /2 days old \(minimum 7 days\)/);

    const clean = { id: idAged(30), username: 'sam_2004', globalName: 'Sam', avatar: 'abc' };
    assert.equal(evaluateJoinGate(clean, { avatar: 'kick', links: 'kick', botname: 'kick', age: 'kick' }, now).action, 'off');
    assert.equal(evaluateJoinGate(clean, { age: 'flag', ageDays: 60 }, now).action, 'flag');
});

test('join gate: the kick DM explains only the kick reasons and how to come back', () => {
    const text = kickNotice('Meowist', [
        { check: 'avatar', action: 'kick', reason: 'no profile picture' },
        { check: 'botname', action: 'flag', reason: 'generated-looking username' },
    ]);
    assert.match(text, /removed from \*\*Meowist\*\*/);
    assert.match(text, /no profile picture/);
    assert.doesNotMatch(text, /generated/);
    assert.match(text, /not a ban/);
    assert.match(text, /after setting a profile picture/);
    assert.match(describeJoinGate({ age: 'kick', ageDays: 3 }), /New account \(younger than 3 days\): \*\*kick\*\*/);
});
