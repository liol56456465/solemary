// Custom automod rules (services/automod/customRules.js): matching on the same normalized
// text as the built-in rules, no regex from staff input, validation, plan limits, rules over
// the limit not running, and the pipeline (automodService.actOn) in enforce and monitor mode.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';

const {
    CustomRuleError, cleanCustomRule, cleanCustomRules, cleanWords, compileRules, customGroupLabel, customRuleDefinition, findCustomRuleHit,
    limitForPlan, matchCompiled, matchCustomRules, overLimitIds, resetCustomRulesCache, ruleDefinition, runningRules,
} = await import('../../src/services/automod/customRules.js');
const {
    actOn, applyRuleModes, customHit, evaluateMessage, reasonKeyFor, resetAutomodState, setAutomodDepsForTest, worstHit,
} = await import('../../src/services/automod/automodService.js');
const { automodConfig } = await import('../../src/config/automod.js');
const { normalizeSettings } = await import('../../src/services/automod/automodSettings.js');
const { setGuildOwnerResolver, setPremiumCache } = await import('../../src/services/billing/premiumEffects.js');
const { validateSetting } = await import('../../src/services/settings/settingsRegistry.js');
const { entryFrom } = await import('../../src/services/automod/reviewCards.js');
const { buildCardPayload, cardTitle } = await import('../../src/services/automod/reviewFormat.js');
const { PLANS, COMPARISON } = await import('../../src/config/site/plans.js');
const { translator } = await import('../../src/services/site/i18n.js');

const DAY = 24 * 3600 * 1000;
// The main server: the rules below are pinned on the main-server config (automodConfig.automodCustomRules).
const GUILD = process.env.MAIN_GUILD_ID;
const OWNER = '200000000000000009';
const rule = (fields = {}) => ({ id: 'abcd2345', name: 'Ads', words: ['free nitro'], action: 'warn', muteDuration: null, enabled: true, ...fields });

afterEach(() => {
    automodConfig.automodCustomRules = undefined;
    setPremiumCache([]);
    setGuildOwnerResolver(null);
    setAutomodDepsForTest();
    resetAutomodState();
    resetCustomRulesCache();
});

function withPlan(planId) {
    setGuildOwnerResolver((guildId) => (guildId === GUILD ? OWNER : null));
    setPremiumCache(planId === 'free' ? [] : [{ user_id: OWNER, plan_id: planId, started_at: new Date(), expires_at: new Date(Date.now() + 10 * DAY) }]);
}

// ── matching ──────────────────────────────────────────────────────────────

test('matching: case-insensitive whole words and phrases', () => {
    const rules = [rule({ words: ['badword', 'join my server'] })];
    assert.equal(matchCustomRules('This is a BadWord here', rules)?.word, 'badword');
    assert.equal(matchCustomRules('come JOIN   my server now', rules)?.word, 'join my server');
    assert.equal(matchCustomRules('join-my-server.', rules)?.word, 'join my server', 'punctuation between words still matches');
    assert.equal(matchCustomRules('badwords are fine', rules), null, 'no match inside a longer word');
    assert.equal(matchCustomRules('notbadword', rules), null);
    assert.equal(matchCustomRules('join my', rules), null, 'half a phrase is no match');
    assert.equal(matchCustomRules('', rules), null);
    assert.equal(matchCustomRules('hello', []), null);
});

test('matching: word boundaries ("ass" is not in "class" or "assistant")', () => {
    const rules = [rule({ words: ['ass'] })];
    assert.equal(matchCustomRules('the class was fun', rules), null);
    assert.equal(matchCustomRules('my assistant', rules), null);
    assert.ok(matchCustomRules('you ass!', rules));
    assert.ok(matchCustomRules('(ass)', rules));
});

test('matching: look-alike letters, fancy fonts, leetspeak, zalgo, invisible characters, spelled-out letters', () => {
    const rules = [rule({ words: ['scam'] })];
    for (const text of [
        'ѕсаm',               // Cyrillic s, c, a
        '𝓼𝓬𝓪𝓶',               // fancy font
        'ｓｃａｍ',             // full width
        '5c4m',               // leetspeak
        's̷̢c̴͝a̶m̸',     // zalgo marks
        's​c​a​m', // zero-width spaces
        's c a m',            // spelled out
        's.c.a.m',
        'SCAAAAM',            // repeated letters are folded like the built-in rules (aa)
    ]) {
        const words = text === 'SCAAAAM' ? ['scaam'] : ['scam'];
        assert.ok(matchCustomRules(text, [rule({ words })]), `should match: ${text}`);
    }
    assert.equal(matchCustomRules('scampi', rules), null);
    // Words are normalized the same way: a rule word with leet or look-alikes matches the plain word.
    assert.ok(matchCustomRules('free nitro', [rule({ words: ['fr33 n1tro'] })]));
});

test('no regex injection: special characters in words are literal, pathological input stays fast', () => {
    const rules = [rule({ words: ['a.*b', '(x+)+$', '[abc]', 'c++'] })];
    assert.equal(matchCustomRules('axxxb', rules), null, '.* is not a wildcard');
    assert.ok(matchCustomRules('a b', rules), 'the punctuation just separates words');
    assert.equal(matchCustomRules('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx!', rules), null);
    const big = Array.from({ length: 100 }, (_, i) => rule({ id: `r${String(i).padStart(4, '0')}`, name: `R${i}`, words: Array.from({ length: 50 }, (_, j) => `w${i}x${j} aa aa aa aa`) }));
    // Best of 3 rounds: a busy machine during the full test run slows single rounds, but
    // catastrophic backtracking would blow past any round. Compiling 5000 phrases (about
    // 200 ms when idle) happens once per change of a server's rules (compiledForGuild), so it
    // is timed on its own; matching (a few ms when idle) runs per message. Distinct texts:
    // the matcher remembers recent texts.
    const compileRounds = [];
    let compiled = null;
    for (let r = 0; r < 3; r += 1) {
        const start = performance.now();
        compiled = compileRules(big);
        compileRounds.push(Math.round(performance.now() - start));
    }
    assert.ok(Math.min(...compileRounds) < 2000, `compiling 5000 phrases took ${compileRounds.join(' / ')} ms`);
    const rounds = [];
    for (let r = 0; r < 3; r += 1) {
        const start = performance.now();
        for (let i = 0; i < 5; i += 1) matchCompiled(`${'aa '.repeat(1333)}${r}${i}`, compiled);
        rounds.push(Math.round(performance.now() - start));
    }
    assert.ok(Math.min(...rounds) < 500, `5 worst-case checks took ${rounds.join(' / ')} ms`);
    assert.equal(matchCompiled(`${'aa '.repeat(600)} w7x2 aa aa aa aa`, compiled)?.word, 'w7x2 aa aa aa aa');
});

test('matching: the harsher action decides, then the earlier rule', () => {
    const rules = [
        rule({ id: 'aaaa1111', name: 'Del', words: ['foo'], action: 'delete' }),
        rule({ id: 'bbbb2222', name: 'Mute', words: ['bar'], action: 'mute', muteDuration: '1h' }),
        rule({ id: 'cccc3333', name: 'Warn', words: ['foo'], action: 'warn' }),
    ];
    assert.equal(matchCustomRules('foo bar', rules).rule.name, 'Mute');
    assert.equal(matchCustomRules('foo', rules).rule.name, 'Warn');
    assert.equal(matchCustomRules('foo', [rules[0], { ...rules[0], id: 'dddd4444', name: 'Del2' }]).rule.name, 'Del');
});

// ── validation ────────────────────────────────────────────────────────────

test('validation: readable errors for bad input', () => {
    const bad = (input, pattern) => assert.throws(() => cleanCustomRule(input), (error) => error instanceof CustomRuleError && pattern.test(error.userMessage));
    bad({ name: '', action: 'warn', words: 'x1' }, /Give the rule a name/);
    bad({ name: 'x'.repeat(41), action: 'warn', words: 'abc' }, /40 characters or fewer/);
    bad({ name: 'A', action: 'ban', words: 'abc' }, /delete, warn or mute/);
    bad({ name: 'A', action: 'warn', words: '' }, /at least one word/);
    bad({ name: 'A', action: 'warn', words: 'x' }, /at least 2 letters/);
    bad({ name: 'A', action: 'warn', words: 'привет' }, /outside A to Z/);
    bad({ name: 'A', action: 'warn', words: 'y'.repeat(61) }, /longer than 60/);
    bad({ name: 'A', action: 'warn', words: Array.from({ length: 51 }, (_, i) => `word${i}`).join('\n') }, /at most 50/);
    bad({ name: 'A', action: 'mute', words: 'abc', muteDuration: '' }, /needs a duration/);
    bad({ name: 'A', action: 'mute', words: 'abc', muteDuration: 'soon' }, /not a duration/);
    bad({ name: 'A', action: 'mute', words: 'abc', muteDuration: '60d' }, /at most 28 days/);
    assert.throws(() => cleanCustomRules([{ name: 'Same', action: 'warn', words: 'ab' }, { name: 'same', action: 'warn', words: 'cd' }]), /already a custom rule called/);
    assert.throws(() => cleanCustomRules(new Array(101).fill(0).map((_, i) => ({ name: `R${i}`, action: 'warn', words: 'ab' }))), /at most 100/);
});

test('validation: words are trimmed, lower-cased, deduplicated; durations kept only for mute; ids made', () => {
    assert.deepEqual(cleanWords('  Free  Nitro \n,free nitro\nFR33 NITRO\n\nhi there'), ['free nitro', 'hi there']);
    const warn = cleanCustomRule({ name: '  Ads   rule ', action: 'warn', words: 'abc', muteDuration: '1h' });
    assert.equal(warn.name, 'Ads rule');
    assert.equal(warn.muteDuration, null);
    assert.match(warn.id, /^[a-z0-9]{8}$/);
    assert.equal(warn.enabled, true);
    assert.equal(cleanCustomRule({ name: 'M', action: 'mute', words: 'abc', muteDuration: ' 1H ' }).muteDuration, '1h');
    const list = cleanCustomRules([{ id: 'same1234', name: 'A', action: 'warn', words: 'ab' }, { id: 'same1234', name: 'B', action: 'warn', words: 'cd' }]);
    assert.notEqual(list[0].id, list[1].id, 'duplicate ids are replaced');
});

test('setting schema: cleaned rules pass; extra keys, a mute without duration and duplicate ids fail', () => {
    const clean = cleanCustomRules([{ name: 'A', action: 'mute', muteDuration: '1h', words: 'ab' }]);
    assert.equal(validateSetting('automodCustomRules', clean).ok, true);
    assert.equal(validateSetting('automodCustomRules', []).ok, true);
    assert.equal(validateSetting('automodCustomRules', [{ ...clean[0], regex: '.*' }]).ok, false);
    assert.equal(validateSetting('automodCustomRules', [{ ...clean[0], muteDuration: null }]).ok, false);
    assert.equal(validateSetting('automodCustomRules', [clean[0], { ...clean[0], name: 'B' }]).ok, false);
    assert.equal(validateSetting('automodCustomRules', [{ ...clean[0], words: [] }]).ok, false);
});

// ── plans and limits ──────────────────────────────────────────────────────

test('limits by plan: Free 0, Normal 5, Pro 25, Max 100; the pricing row is no longer planned', () => {
    assert.deepEqual(['free', 'normal', 'pro', 'max'].map(limitForPlan), [0, 5, 25, 100]);
    assert.equal(limitForPlan('unknown'), 0);
    assert.deepEqual(PLANS.map((p) => p.limits.customRules), [0, 5, 25, 100]);
    const row = COMPARISON.find((g) => g.key === 'automod').rows.find((r) => r.key === 'customRules');
    assert.equal(row.planned, undefined);
    const { t } = translator('en');
    assert.equal(t('plans.comparison.automod.rows.customRules'), 'Custom automod rules');
    assert.ok(!PLANS.flatMap((p) => p.perks.map((perk) => ({ ...perk, text: t(`plans.${p.id}.perks.${perk.key}`) }))).some((perk) => /custom automod/i.test(perk.text) && perk.planned));
});

test('over the limit: the first N enabled rules run; the rest are kept but do not run', () => {
    const rules = [
        rule({ id: 'r1aaaaaa', name: 'One', enabled: false }),
        rule({ id: 'r2aaaaaa', name: 'Two' }),
        rule({ id: 'r3aaaaaa', name: 'Three' }),
        rule({ id: 'r4aaaaaa', name: 'Four' }),
    ];
    assert.deepEqual(runningRules(rules, 2).map((r) => r.name), ['Two', 'Three']);
    assert.deepEqual(overLimitIds(rules, 2), ['r4aaaaaa']);
    assert.deepEqual(runningRules(rules, 0), []);
    assert.deepEqual(overLimitIds(rules, 10), []);
});

test('findCustomRuleHit follows the owner\'s plan: nothing on Free, the first N on a paid plan', () => {
    const rules = Array.from({ length: 7 }, (_, i) => rule({ id: `rule${i}aaa`, name: `Rule ${i}`, words: [`word${i}`] }));
    automodConfig.automodCustomRules = rules;
    withPlan('free');
    assert.equal(findCustomRuleHit('word0', GUILD), null, 'Free runs none');
    resetCustomRulesCache();
    withPlan('normal');
    assert.equal(findCustomRuleHit('word4', GUILD)?.rule.name, 'Rule 4');
    assert.equal(findCustomRuleHit('word5', GUILD), null, 'the 6th rule is over the Normal limit of 5');
    resetCustomRulesCache();
    withPlan('pro');
    assert.equal(findCustomRuleHit('word6', GUILD)?.rule.name, 'Rule 6');
});

// ── the pipeline ──────────────────────────────────────────────────────────

function fakeMessage(content = 'please free nitro now') {
    return {
        id: 'm1', content, guildId: GUILD, channelId: 'c1', url: 'https://discord.com/channels/1/2/3',
        guild: { id: GUILD, client: {} }, author: { id: 'u1', username: 'amy', createdTimestamp: Date.now() - 400 * DAY },
        mentions: { users: new Map(), roles: new Map() }, attachments: new Map(), client: { user: { id: 'bot' } },
    };
}
const member = { joinedTimestamp: Date.now() - 100 * DAY, permissions: { has: () => false } };

function recordDeps() {
    const calls = [];
    const rec = (name, value) => async (...args) => { calls.push({ name, args }); return value; };
    setAutomodDepsForTest({
        countOffences: rec('countOffences', 0),
        applyStep: rec('applyStep', { record: { case_code: 'abc2345' } }),
        postReviewCard: rec('postReviewCard', null),
        noteRepeatHit: rec('noteRepeatHit', null),
        deleteQuietly: rec('deleteQuietly', null),
        isRaidJoiner: rec('isRaidJoiner', false),
        giveSecondChance: rec('giveSecondChance', false),
        giveHeadsUp: rec('giveHeadsUp', false),
    });
    return calls;
}
const names = (calls) => calls.map((c) => c.name);

test('evaluateMessage reports a custom hit with the rule key, plain reason and the rule name', async () => {
    automodConfig.automodCustomRules = [rule({ id: 'adsr2345', name: 'Ads' })];
    withPlan('pro');
    const hits = await evaluateMessage(fakeMessage('get FREE N1TRO here'), member);
    const hit = hits.find((h) => h.rule === 'custom-adsr2345');
    assert.ok(hit, JSON.stringify(hits.map((h) => h.rule)));
    assert.equal(hit.ruleLabel, 'Ads');
    assert.equal(hit.evidence, 'used a word or phrase from the custom rule "Ads" (hidden)');
    assert.ok(!hit.evidence.includes('nitro'), 'the word is not on the card');
});

test('pipeline, enforce + warn: message deleted, a case with reason key automod:custom:<id>, a card with the rule name', async () => {
    const calls = recordDeps();
    const r = rule({ id: 'adsr2345', name: 'Ads' });
    const [hit] = applyRuleModes([customHit({ rule: r, word: 'free nitro' })], normalizeSettings({ mode: 'enforce' }));
    assert.equal(hit.mode, 'on');
    assert.equal(await actOn(fakeMessage(), member, hit, normalizeSettings({})), true);
    assert.deepEqual(names(calls), ['giveHeadsUp', 'deleteQuietly', 'isRaidJoiner', 'countOffences', 'giveSecondChance', 'applyStep', 'postReviewCard']);
    const step = calls.find((c) => c.name === 'applyStep').args[0];
    assert.deepEqual(step.step, { type: 'warn' });
    assert.equal(step.reason, 'Automod: Ads');
    assert.equal(step.group, 'custom:adsr2345');
    assert.equal(reasonKeyFor(step.rule, step.group), 'automod:custom:adsr2345');
    assert.ok(reasonKeyFor(step.rule, step.group).length <= 50, 'fits mod_cases.reason_key');
    assert.equal(calls.find((c) => c.name === 'countOffences').args[2], 'custom:adsr2345');
    const card = calls.find((c) => c.name === 'postReviewCard').args[0];
    assert.equal(card.ruleLabel, 'Ads');
    assert.equal(card.deleted, true);
    const payload = buildCardPayload(entryFrom(card));
    assert.match(payload.embeds[0].data.title, /^Warned · Ads$/);
});

test('pipeline, enforce + mute: the rule\'s duration', async () => {
    const calls = recordDeps();
    const hit = { ...customHit({ rule: rule({ action: 'mute', muteDuration: '2h' }), word: 'free nitro' }), mode: 'on' };
    await actOn(fakeMessage(), member, hit, normalizeSettings({}));
    assert.deepEqual(calls.find((c) => c.name === 'applyStep').args[0].step, { type: 'mute', durationMs: 2 * 3600 * 1000 });
});

test('pipeline, delete only: message deleted and a card, no case and no offence count', async () => {
    const calls = recordDeps();
    const hit = { ...customHit({ rule: rule({ name: 'Spoilers', action: 'delete' }), word: 'free nitro' }), mode: 'on' };
    assert.equal(await actOn(fakeMessage(), member, hit, normalizeSettings({})), true);
    assert.deepEqual(names(calls), ['giveHeadsUp', 'deleteQuietly', 'isRaidJoiner', 'postReviewCard']);
    const card = calls.at(-1).args[0];
    assert.equal(card.deleted, true);
    assert.equal(card.step, undefined);
    const entry = entryFrom(card);
    assert.equal(cardTitle(entry), 'Automod · Spoilers');
    assert.match(JSON.stringify(buildCardPayload(entry).components), /amreview:apply:custom-abcd2345:u1/, 'staff can still apply a punishment');
});

test('pipeline, global monitor mode: only a card, nothing deleted, no case', async () => {
    const settings = normalizeSettings({ mode: 'monitor' });
    for (const action of ['warn', 'delete']) {
        const calls = recordDeps();
        const [hit] = applyRuleModes([customHit({ rule: rule({ action }), word: 'free nitro' })], settings);
        assert.equal(hit.mode, 'monitor');
        assert.equal(await actOn(fakeMessage(), member, hit, settings), false);
        assert.ok(!names(calls).includes('deleteQuietly') && !names(calls).includes('applyStep'), action);
        const card = calls.find((c) => c.name === 'postReviewCard').args[0];
        assert.equal(card.monitor, true);
        assert.equal(card.deleted, false);
        const title = cardTitle(entryFrom(card));
        assert.equal(title, action === 'warn' ? "Report only (don't delete): would warn · Ads" : "Report only (don't delete): would delete the message · Ads");
    }
});

test('pipeline: the same rule again within the cooldown only counts on the card', async () => {
    const calls = recordDeps();
    const hit = { ...customHit({ rule: rule(), word: 'free nitro' }), mode: 'on' };
    await actOn(fakeMessage(), member, hit, normalizeSettings({}));
    calls.length = 0;
    await actOn(fakeMessage(), member, hit, normalizeSettings({}));
    assert.deepEqual(names(calls), ['giveHeadsUp', 'deleteQuietly', 'noteRepeatHit']);
});

test('severity: custom rules sit between language and disrespect; worstHit picks across both kinds', () => {
    const custom = customHit({ rule: rule(), word: 'x' });
    assert.equal(worstHit([{ rule: 'caps' }, custom]).rule, custom.rule);
    assert.equal(worstHit([custom, { rule: 'scam' }]).rule, 'scam');
    assert.equal(worstHit([{ rule: 'language' }, custom]).rule, 'language');
});

test('rule definitions for cards and reports: stored name, or a generic label once removed', () => {
    automodConfig.automodCustomRules = [rule({ id: 'keep2345', name: 'Kept' })];
    assert.equal(ruleDefinition('custom-keep2345').label, 'Kept');
    assert.equal(ruleDefinition('custom-keep2345').group, 'custom:keep2345');
    assert.equal(ruleDefinition('custom-gone2345').label, 'Custom rule');
    assert.equal(ruleDefinition('caps').label, 'Excessive caps');
    assert.equal(ruleDefinition('report'), null);
    assert.equal(customGroupLabel('custom:keep2345'), 'Kept');
    assert.equal(customGroupLabel('custom:gone2345'), 'Custom rule (removed)');
    assert.equal(customGroupLabel('spam'), null);
    assert.deepEqual(customRuleDefinition(rule({ action: 'delete' })).steps, []);
});
