import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    compileTrigger, matchFirst, channelAllowed, onCooldown, parseChannelList, REGEX_TRIGGER_MAX,
} = await import('../../src/services/community/tagMatcher.js');
const { setTagsForTests, findTriggeredTag, getTag, useTag } = await import('../../src/services/community/tagService.js');

const G = '100000000000000001';
const C1 = '200000000000000001';
const C2 = '200000000000000002';
const THREAD = '200000000000000009';

test('word triggers: case-insensitive, whole words, phrases with any spacing, escaped', () => {
    const re = compileTrigger('word', 'server ip');
    assert.equal(re.test('what is the SERVER  IP?'), true);
    assert.equal(re.test('serverip'), false);
    assert.equal(re.test('myserver ip'), false);
    const special = compileTrigger('word', 'c++');
    assert.equal(special.test('I love c++ a lot'), true);
    assert.equal(compileTrigger('word', 'café').test('Le CAFÉ est bon'), true);
    assert.equal(compileTrigger('word', 'café').test('cafés'), false);
    assert.throws(() => compileTrigger('word', '  '), /needs/);
    assert.throws(() => compileTrigger('word', 'x'.repeat(101)), /limited/);
});

test('regex triggers: validated, length-capped, catastrophic shapes rejected', () => {
    assert.equal(compileTrigger('regex', 'how (do|can) i (join|apply)').test('How can I apply?'), true);
    assert.throws(() => compileTrigger('regex', '(unclosed'), /not a valid regex/);
    assert.throws(() => compileTrigger('regex', 'a'.repeat(REGEX_TRIGGER_MAX + 1)), /limited/);
    assert.throws(() => compileTrigger('regex', '(a+)+$'), /nested quantifiers/);
    assert.throws(() => compileTrigger('regex', '(.*)*x'), /nested quantifiers/);
    assert.throws(() => compileTrigger('regex', '((ab)+c)*'), /nested quantifiers/);
    assert.throws(() => compileTrigger('regex', '(\\w+\\s?){2,}x'), /nested quantifiers/);
    assert.throws(() => compileTrigger('regex', '(a)\\1'), /Backreferences/);
    assert.throws(() => compileTrigger('regex', 'x*'), /every message/);
    // Escaped parens and classes are not groups.
    assert.ok(compileTrigger('regex', '\\(a+\\)+'));
    assert.ok(compileTrigger('regex', '[(]a+[)]+'));
    // Quantified group without inner quantifier is fine.
    assert.ok(compileTrigger('regex', '(ab)+c'));
});

test('matching is time-boxed: a catastrophic pattern times out instead of blocking', () => {
    const evil = /^(a|a)*$/;
    const started = Date.now();
    assert.equal(matchFirst([evil], `${'a'.repeat(40)}b`, 20), null);
    assert.ok(Date.now() - started < 1000);
    // Plain matches with a generous limit: these check results, not timing (busy test hosts).
    assert.equal(matchFirst([/x/, /hello/i], 'say HELLO', 1000), 1);
    assert.equal(matchFirst([/x/], 'nope', 1000), -1);
    assert.equal(matchFirst([], 'nope'), -1);
});

test('channel rules: deny wins, allow narrows, threads inherit their parent', () => {
    assert.equal(channelAllowed({ allowChannels: [], denyChannels: [] }, C1), true);
    assert.equal(channelAllowed({ allowChannels: [C1], denyChannels: [] }, C2), false);
    assert.equal(channelAllowed({ allowChannels: [C1], denyChannels: [] }, THREAD, C1), true);
    assert.equal(channelAllowed({ allowChannels: [C1], denyChannels: [C1] }, C1), false);
    assert.equal(channelAllowed({ allowChannels: [], denyChannels: [C1] }, THREAD, C1), false);
});

test('cooldown and channel list parsing', () => {
    assert.equal(onCooldown(0, 1000, 60), false);
    assert.equal(onCooldown(1000, 30_000, 60), true);
    assert.equal(onCooldown(1000, 61_001, 60), false);
    assert.deepEqual(parseChannelList(`<#${C1}> ${C2}, <#${C1}>`), [C1, C2]);
    assert.deepEqual(parseChannelList('none'), []);
    assert.deepEqual(parseChannelList('-'), []);
    assert.deepEqual(parseChannelList('#general'), []);
});

test('triggered tags: first match, channel rules and per-channel cooldown from memory', () => {
    setTagsForTests([
        { id: 1, guild_id: G, name: 'ip', content: 'play.example.com', trigger_kind: 'word', trigger: 'server ip', cooldown_s: 60, allow_channels: [], deny_channels: [C2], created_by: 'x', uses: 0 },
        { id: 2, guild_id: G, name: 'rules', content: 'See #rules', trigger_kind: 'none', trigger: null, cooldown_s: 60, allow_channels: [], deny_channels: [], created_by: 'x', uses: 3 },
        { id: 3, guild_id: G, name: 'broken', content: 'x', trigger_kind: 'regex', trigger: '(a+)+', cooldown_s: 60, allow_channels: [], deny_channels: [], created_by: 'x', uses: 0 },
    ]);
    const msg = (content, channelId = C1) => ({ guild: { id: G }, channel: { id: channelId, isThread: () => false }, content });
    // A plain matcher (no time limit): this test is about cooldowns and channel rules, not timing.
    const plain = (patterns, text) => patterns.findIndex((p) => p.test(text));
    assert.equal(getTag(G, 'broken').pattern, null); // stored unsafe trigger never fires
    assert.equal(findTriggeredTag(msg('what is the server ip'), 1000, plain)?.name, 'ip');
    assert.equal(findTriggeredTag(msg('server ip again'), 2000, plain), null); // cooldown in C1
    assert.equal(findTriggeredTag(msg('server ip', C2), 2000, plain), null); // denied
    assert.equal(findTriggeredTag(msg('server ip', '200000000000000003'), 2000, plain)?.name, 'ip'); // other channel
    assert.equal(findTriggeredTag(msg('server ip'), 62_000, plain)?.name, 'ip');
    assert.equal(findTriggeredTag({ guild: { id: 'other' }, channel: { id: C1 }, content: 'server ip' }, Date.now(), plain), null);
    assert.equal(useTag(G, 'RULES')?.uses, 4);
    assert.equal(useTag(G, 'missing'), null);
});

test('triggered tags: one slow match (busy host) does not switch a tag off; 3 timeouts in 10 min do, even between fast matches', async () => {
    const { TRIGGER_TIMEOUT_STRIKES, TRIGGER_TIMEOUT_WINDOW_MS } = await import('../../src/services/community/tagService.js');
    setTagsForTests([
        { id: 9, guild_id: G, name: 'ip', content: 'play.example.com', trigger_kind: 'word', trigger: 'server ip', cooldown_s: 0, allow_channels: [], deny_channels: [], created_by: 'x', uses: 0 },
    ]);
    const msg = (content) => ({ guild: { id: G }, channel: { id: '200000000000000009', isThread: () => false }, content });
    const timesOut = () => null;
    const plain = (patterns, text) => patterns.findIndex((p) => p.test(text)); // no time limit: deterministic
    assert.equal(findTriggeredTag(msg('server ip'), 1000, timesOut), null);
    assert.equal(findTriggeredTag(msg('server ip'), 2000, plain)?.name, 'ip', 'still active after one timeout');
    // Timeouts far apart never add up.
    assert.equal(findTriggeredTag(msg('server ip'), 1000 + TRIGGER_TIMEOUT_WINDOW_MS + 1, timesOut), null);
    assert.equal(findTriggeredTag(msg('server ip'), 2 * TRIGGER_TIMEOUT_WINDOW_MS + 5000, timesOut), null);
    assert.equal(findTriggeredTag(msg('server ip'), 2 * TRIGGER_TIMEOUT_WINDOW_MS + 6000, plain)?.name, 'ip', 'only 2 timeouts in the window');
    // Fast matches in between do not reset the count.
    const base = 3 * TRIGGER_TIMEOUT_WINDOW_MS;
    for (let i = 0; i < TRIGGER_TIMEOUT_STRIKES; i += 1) {
        findTriggeredTag(msg('server ip'), base + i * 2, timesOut);
        findTriggeredTag(msg('server ip'), base + i * 2 + 1, plain);
    }
    assert.equal(findTriggeredTag(msg('server ip'), base + 100, plain), null, 'switched off after 3 timeouts in 10 min');
});
