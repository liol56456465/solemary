import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automodConfig } from '../../src/config/automod.js';
import {
    buildCardPayload, buttonCodes, cardComponents, cardDescription, cardTier, cardTitle, closedTitle,
    compactLine, isLightAction, ordinal, outcomeLabel, spoilerExcerpt, stepVerb, stripLeadingEmoji,
} from '../../src/services/automod/reviewFormat.js';
import { entryFrom, mergeHit } from '../../src/services/automod/reviewCards.js';
import {
    burstKey, findOpenBurst, markClosed, openCards, registerCard, resetReviewRegistry,
} from '../../src/services/automod/reviewRegistry.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const warn = { type: 'warn' };
const mute = (durationMs) => ({ type: 'mute', durationMs });
const ban = (durationMs) => ({ type: 'ban', durationMs });

const guild = { id: 'g1', client: {} };
const user = { id: '111', username: 'alice' };
const params = (extra = {}) => ({
    guild, rule: 'caps', evidence: 'wrote mostly in capital letters', targetUser: user,
    channelId: '222', messageUrl: 'https://discord.com/channels/g1/222/333', content: 'HELLO THERE EVERYONE',
    step: warn, result: { record: { case_code: 'k3f9a' } }, offence: 1, ...extra,
});

test('light actions: low-severity rule + warn, very low rule + short mute', () => {
    assert.equal(isLightAction('caps', warn), true);
    assert.equal(isLightAction('spam', warn), true);
    assert.equal(isLightAction('mentions', warn), true);
    assert.equal(isLightAction('english', warn), true);
    assert.equal(isLightAction('caps', mute(HOUR)), true);
    assert.equal(isLightAction('spam', mute(HOUR)), false, 'spam mutes are a full card');
    assert.equal(isLightAction('caps', mute(DAY)), false, 'a day or more is serious');
    assert.equal(isLightAction('language', warn), false, 'language is above the threshold');
    assert.equal(isLightAction('nsfw', ban(7 * DAY)), false);
    assert.ok(automodConfig.lowSeverityMax >= 40 && automodConfig.lowSeverityMax < 50);
});

test('tier: compact only for light automatic actions with a case', () => {
    assert.equal(cardTier(entryFrom(params())), 'compact');
    assert.equal(cardTier(entryFrom(params({ rule: 'harassment', step: mute(HOUR) }))), 'full');
    assert.equal(cardTier(entryFrom(params({ rule: 'nsfw', step: ban(7 * DAY) }))), 'full');
    assert.equal(cardTier(entryFrom(params({ result: { error: new Error('Missing permissions') } }))), 'full', 'failed');
    assert.equal(cardTier(entryFrom(params({ monitor: true, suggested: warn, step: undefined, result: undefined }))), 'full', 'monitor');
    assert.equal(cardTier(entryFrom(params({ report: { reporter: 'bob', messageId: '1', removed: false } }))), 'full', 'report');
    assert.equal(cardTier(entryFrom(params({ raid: true, step: { type: 'kick' } }))), 'full', 'raid kick');
    assert.equal(cardTier(entryFrom(params({ result: { record: { case_code: 'a' }, banRecord: { case_code: 'b' } } }))), 'full', 'warn limit ban');
    assert.equal(cardTier(entryFrom(params({ tier: 'full' }))), 'full', 'override');
});

test('titles state the outcome', () => {
    assert.equal(cardTitle(entryFrom(params({ rule: 'nsfw', step: ban(7 * DAY) }))), '🔴 Banned 7 days — NSFW content');
    assert.equal(cardTitle(entryFrom(params({ rule: 'harassment', step: mute(HOUR) }))), '🟠 Muted 1 hour — Harassment');
    assert.equal(cardTitle(entryFrom(params({ rule: 'scam', step: ban(null) }))), '🔴 Permanently banned — Scam or phishing link');
    assert.equal(cardTitle(entryFrom(params({ rule: 'spam', monitor: true, suggested: mute(HOUR) }))), '👀 Monitor: would mute 1 hour — Spam');
    assert.equal(cardTitle(entryFrom(params({ report: { reporter: 'bob', messageId: '1' } }))), '🚩 Member report');
    assert.equal(cardTitle(entryFrom(params({ result: { error: new Error('x') } }))), '❌ Failed to warn — Excessive caps');
    assert.equal(outcomeLabel(warn), 'Warned');
    assert.equal(stepVerb(ban(null)), 'ban permanently');
    assert.equal(ordinal(1), '1st');
    assert.equal(ordinal(2), '2nd');
    assert.equal(ordinal(11), '11th');
    assert.equal(ordinal(23), '23rd');
});

test('description is a plain sentence with the offence count', () => {
    const entry = entryFrom(params({ rule: 'nsfw', step: ban(7 * DAY), evidence: 'posted a link to an adult site (x.com)', offence: 2 }));
    const text = cardDescription(entry);
    assert.match(text, /^<@111> posted a link to an adult site \(x\.com\) in <#222>\.$/m);
    assert.match(text, /2nd NSFW content offence in 30 days\./);
});

test('message content is spoilered, truncated and cannot break out', () => {
    assert.equal(spoilerExcerpt(''), '(no text)');
    assert.equal(spoilerExcerpt('hi'), '||hi||');
    assert.equal(spoilerExcerpt('a||b'), '||a\\|\\|b||');
    const long = spoilerExcerpt('x'.repeat(1000), 300);
    assert.ok(long.length <= 304);
    assert.ok(long.startsWith('||') && long.endsWith('…||'));
});

test('full card: jump link only while the message exists; buttons keep amreview ids', () => {
    const deleted = buildCardPayload(entryFrom(params({ rule: 'nsfw', step: ban(7 * DAY) })));
    const fields = deleted.embeds[0].data.fields;
    assert.equal(fields[0].name, 'Message (deleted)');
    assert.ok(fields[0].value.startsWith('||'));
    assert.ok(!fields.some((f) => f.name === 'Message link'));
    const ids = deleted.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
    assert.deepEqual(ids, ['amreview:keep:k3f9a', 'amreview:undo:k3f9a', 'amreview:change:k3f9a']);

    const kept = buildCardPayload(entryFrom(params({ rule: 'impersonation', step: warn, channelId: null, messageUrl: 'https://x/y' })));
    assert.ok(kept.embeds[0].data.fields.some((f) => f.name === 'Message link'));

    const monitor = cardComponents(entryFrom(params({ rule: 'spam', monitor: true, suggested: warn })));
    assert.deepEqual(monitor.flatMap((row) => row.components.map((c) => c.data.custom_id)), ['amreview:apply:spam:111', 'amreview:dismiss']);

    const report = cardComponents(entryFrom(params({ report: { reporter: 'bob', messageId: '999', removed: false } })));
    assert.deepEqual(report.flatMap((row) => row.components.map((c) => c.data.custom_id)), ['amreview:apply:report:111', 'amreview:delete:222:999', 'amreview:dismiss']);
});

test('compact line: one line and one Undo button', () => {
    const payload = buildCardPayload(entryFrom(params()));
    assert.equal(payload.embeds.length, 0);
    assert.equal(payload.content, '🟡 **Excessive caps** · <@111> · warned · case `k3f9a` · <#222>');
    assert.equal(payload.components.length, 1);
    assert.equal(payload.components[0].components[0].data.custom_id, 'amreview:undo:k3f9a');
});

test('burst: hits merge into one card, every case on the buttons', () => {
    const now = 1_000_000;
    const entry = entryFrom(params(), now);
    mergeHit(entry, params({ step: undefined, result: undefined, content: 'STILL SHOUTING' }), now + 10_000);
    mergeHit(entry, params({ step: warn, result: { record: { case_code: 'm2b7c' } } }), now + 60_000);
    assert.equal(entry.count, 3);
    assert.equal(buttonCodes(entry), 'k3f9a,m2b7c');
    assert.match(compactLine(entry), /3 messages$/);
    assert.equal(entry.tier, 'compact');

    // A serious action turns the line into a full card, and it stays full.
    mergeHit(entry, params({ step: mute(DAY), result: { record: { case_code: 'p4q8r' } } }), now + 120_000);
    assert.equal(entry.tier, 'full');
    assert.match(cardDescription(entry), /Earlier in this burst: Warned `k3f9a` · Warned `m2b7c`\./);
    assert.match(cardDescription(entry), /\*\*4 messages\*\*/);
    const payload = buildCardPayload(entry);
    assert.equal(payload.components[0].components[1].data.custom_id, 'amreview:undo:k3f9a,m2b7c,p4q8r');
    assert.equal(payload.components[0].components[1].data.label, 'Undo all');
    for (const row of payload.components) for (const c of row.components) assert.ok(c.data.custom_id.length <= 100);
});

test('burst buttons stay under the 100-character customId limit', () => {
    const entry = entryFrom(params({ rule: 'spam', step: mute(HOUR), result: { record: { case_code: 'aaaaaaa' } } }));
    for (let i = 0; i < 20; i += 1) mergeHit(entry, params({ rule: 'spam', step: mute(HOUR), result: { record: { case_code: `bbbbb${String(i).padStart(2, '0')}` } } }));
    const ids = buildCardPayload(entry).components.flatMap((row) => row.components.map((c) => c.data.custom_id));
    for (const id of ids) assert.ok(id.length <= 100, id);
    assert.match(cardDescription(entry), /\/case/);
});

test('registry: grouping by user + rule + kind, within the window, never into a closed card', () => {
    resetReviewRegistry();
    const now = 5_000_000;
    const entry = entryFrom(params(), now);
    registerCard(Object.assign(entry, { messageId: 'm1', url: 'u1' }));
    assert.equal(findOpenBurst(entry.key, now + 60_000), entry);
    assert.equal(findOpenBurst(entry.key, now + automodConfig.burstWindowMs + 1), null, 'window passed');

    const otherUser = entryFrom(params({ targetUser: { id: '999', username: 'bob' } }), now);
    const otherRule = entryFrom(params({ rule: 'spam' }), now);
    const monitor = entryFrom(params({ monitor: true, suggested: warn }), now);
    assert.notEqual(otherUser.key, entry.key);
    assert.notEqual(otherRule.key, entry.key);
    assert.notEqual(monitor.key, entry.key);
    assert.equal(burstKey(entryFrom(params({ report: { reporter: 'x', messageId: '1' } }))), null);
    assert.equal(burstKey(entryFrom(params({ raid: true }))), null);

    markClosed('m1', 'kept');
    assert.equal(findOpenBurst(entry.key, now + 1000), null, 'closed cards are never merged into');
    resetReviewRegistry();
});

test('registry: queue lists open full cards newest first, not compact lines', () => {
    resetReviewRegistry();
    registerCard(Object.assign(entryFrom(params({ rule: 'nsfw', step: ban(DAY) }), 1000), { messageId: 'a', url: 'ua' }));
    registerCard(Object.assign(entryFrom(params({ rule: 'harassment', step: mute(HOUR), targetUser: { id: '2', username: 'b' } }), 2000), { messageId: 'b', url: 'ub' }));
    registerCard(Object.assign(entryFrom(params(), 3000), { messageId: 'c', url: 'uc' }));
    assert.deepEqual(openCards().map((e) => e.messageId), ['b', 'a']);
    markClosed('b', 'undone');
    assert.deepEqual(openCards().map((e) => e.messageId), ['a']);
    resetReviewRegistry();
});

test('closed titles say who reviewed it', () => {
    assert.equal(closedTitle('🟠 Muted 1 hour — Harassment', 'kept', 'Admin'), '✅ Kept by Admin — Muted 1 hour — Harassment');
    assert.equal(closedTitle('🔴 Banned 7 days — NSFW content', 'undone', 'Admin'), '↩️ Undone by Admin — Banned 7 days — NSFW content');
    assert.equal(closedTitle('Verification needs approval', 'approved', 'Admin'), '✅ Approved by Admin — Verification needs approval');
    assert.equal(closedTitle('👀 Monitor: would warn — Spam', 'applied', 'Admin', 'Warn applied'), '✅ Warn applied by Admin — Monitor: would warn — Spam');
    assert.equal(stripLeadingEmoji('🟡 Warned — Spam'), 'Warned — Spam');
    assert.equal(stripLeadingEmoji('⚠️ Not applied'), 'Not applied');
});
