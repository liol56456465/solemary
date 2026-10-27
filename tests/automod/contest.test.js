import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    caseGroup, checkContestTarget, cleanContestReason, contestKey, contestLine, contestLineComponents,
    findCardForCase, markReviewCard, restoredMessageText, CONTEST_MAX_CHARS,
} from '../../src/services/automod/automodContest.js';
import { contestComponents } from '../../src/services/enforcement/dmTemplates.js';
import { buildCardPayload, cardTier, contestField } from '../../src/services/automod/reviewFormat.js';
import { entryFrom, mergeHit } from '../../src/services/automod/reviewCards.js';
import { findCardByCase, findCardForMember, registerCard, resetReviewRegistry } from '../../src/services/automod/reviewRegistry.js';
import { resolveContestCase } from '../../src/handlers/automodContest.js';

const MAIN = 'main1';
const record = (extra = {}) => ({
    case_code: 'k3f9a', guild_id: MAIN, target_user_id: '111', reason_key: 'automod:caps', status: 'active',
    type: 'warn', reason: 'Automod: Excessive caps', created_at: new Date(1_000_000), ...extra,
});

const guild = { id: MAIN, client: {} };
const params = (extra = {}) => ({
    guild, rule: 'caps', evidence: 'wrote mostly in capital letters', targetUser: { id: '111', username: 'alice' },
    channelId: '222', messageUrl: 'https://discord.com/channels/main1/222/333', content: 'HELLO THERE',
    step: { type: 'warn' }, result: { record: { case_code: 'k3f9a' } }, offence: 1, ...extra,
});

beforeEach(() => resetReviewRegistry());

test('only the target of a standing automod case in the main server may contest', () => {
    assert.deepEqual(checkContestTarget(record(), '111', MAIN), { ok: true });
    assert.equal(checkContestTarget(null, '111', MAIN).ok, false);
    assert.equal(checkContestTarget(record({ guild_id: 'other' }), '111', MAIN).ok, false, 'other guild');
    assert.match(checkContestTarget(record(), '999', MAIN).message, /Only the member/);
    assert.match(checkContestTarget(record({ reason_key: 'warn_ladder' }), '111', MAIN).message, /appeal/);
    assert.match(checkContestTarget(record({ status: 'revoked' }), '111', MAIN).message, /already reversed/);
    assert.equal(checkContestTarget(record({ voided_at: new Date() }), '111', MAIN).ok, false);
});

test('resolveContestCase validates the code and the member', async () => {
    const lookup = async (code) => (code === 'k3f9a' ? record({ guild_id: process.env.MAIN_GUILD_ID || record().guild_id }) : null);
    assert.match((await resolveContestCase('111', 'not a code!', lookup)).error, /broken/);
    assert.ok((await resolveContestCase('111', 'zzzzz', lookup)).error, 'unknown code');
    assert.ok((await resolveContestCase('222', 'k3f9a', lookup)).error, 'someone else');
});

test('reason is trimmed and capped; group comes from the reason key', () => {
    assert.equal(cleanContestReason('  ok  '), 'ok');
    assert.equal(cleanContestReason('x'.repeat(900)).length, CONTEST_MAX_CHARS);
    assert.equal(caseGroup(record()), 'caps');
    assert.equal(caseGroup({ reason_key: 'warn_ladder' }), null);
    assert.equal(contestKey('abcde'), 'automod:contest:abcde');
});

test('the DM button carries the case code', () => {
    const [row] = contestComponents('k3f9a');
    const button = row.toJSON().components[0];
    assert.equal(button.custom_id, 'amcontest:open:k3f9a');
    assert.equal(button.label, 'Contest this');
    assert.deepEqual(contestComponents(null), []);
});

test('fallback line quotes and escapes the reason and offers Keep / Undo', () => {
    const line = contestLine(record(), 'it was **fine**\n@everyone', 'https://discord.com/x');
    assert.match(line, /^🙋 \*\*Member disputes\*\* · case `k3f9a` · <@111>/);
    assert.match(line, /> it was \\\*\\\*fine\\\*\\\*/);
    assert.match(line, /> @everyone/);
    assert.match(line, /\[original card\]/);
    const ids = contestLineComponents('k3f9a')[0].toJSON().components.map((c) => c.custom_id);
    assert.deepEqual(ids, ['amreview:keep:k3f9a', 'amreview:undo:k3f9a']);
});

test('restored text: quoted, attachment marker dropped, null when empty', () => {
    assert.equal(restoredMessageText('111', ''), null);
    assert.equal(restoredMessageText('111', '[2 attachment(s)]'), null);
    const text = restoredMessageText('111', 'hello\nworld [1 attachment(s)]');
    assert.match(text, /^↩️ Restored message from <@111>/);
    assert.match(text, /\n> hello\n> world$/);
    assert.ok(restoredMessageText('111', 'x'.repeat(5000)).length <= 2000);
});

test('a contested card is full and shows the dispute field', () => {
    const entry = entryFrom(params());
    assert.equal(cardTier(entry), 'compact');
    entry.contest = { caseCode: 'k3f9a', reason: 'I was **quoting**', at: 1 };
    entry.tier = null;
    assert.equal(cardTier(entry), 'full');
    const field = contestField(entry.contest);
    assert.equal(field.name, '🙋 Member disputes · case k3f9a');
    assert.equal(field.value, 'I was \\*\\*quoting\\*\\*');
    entry.tier = 'full';
    const payload = buildCardPayload(entry);
    const fields = payload.embeds[0].toJSON().fields;
    assert.ok(fields.some((f) => f.name.startsWith('🙋 Member disputes')));
    // Keep / Undo stay available.
    const ids = payload.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
    assert.ok(ids.includes('amreview:keep:k3f9a') && ids.includes('amreview:undo:k3f9a'));
    // Further hits keep it full.
    mergeHit(entry, params({ result: { record: { case_code: 'm4n5p' } } }));
    assert.equal(entry.tier, 'full');
});

test('actions keep their own excerpt and channel for restoring', () => {
    const entry = entryFrom(params({ rule: 'language', content: 'first' }));
    mergeHit(entry, params({ rule: 'language', content: 'second', result: { record: { case_code: 'm4n5p' } } }));
    assert.deepEqual(entry.actions.map((a) => [a.caseCode, a.content, a.channelId, a.deleted]), [
        ['k3f9a', 'first', '222', true],
        ['m4n5p', 'second', '222', true],
    ]);
});

test('registry finds cards by case code, then by member + group + time', () => {
    const entry = Object.assign(entryFrom(params(), 1_000_000), { messageId: 'm1' });
    registerCard(entry);
    assert.equal(findCardByCase('k3f9a'), entry);
    assert.equal(findCardByCase('zzzzz'), null);
    const ruleGroup = (rule) => (rule === 'caps' ? 'caps' : 'other');
    assert.equal(findCardForMember({ guildId: MAIN, userId: '111', group: 'caps', at: 1_000_000 + 60_000, ruleGroup }), entry);
    assert.equal(findCardForMember({ guildId: MAIN, userId: '111', group: 'spam', at: 1_000_000, ruleGroup }), null);
    assert.equal(findCardForMember({ guildId: MAIN, userId: '222', group: 'caps', at: 1_000_000, ruleGroup }), null);
    assert.equal(findCardForMember({ guildId: MAIN, userId: '111', group: 'caps', at: 1_000_000 + 3_600_000, ruleGroup }), null, 'too late');
    assert.equal(findCardForCase(record({ case_code: 'qqqqq', reason_key: 'automod:spam' })), entry, 'fallback by member');
    assert.equal(findCardForCase(record({ case_code: 'qqqqq', reason_key: 'automod:nsfw' })), null, 'other group');
});

test('markReviewCard raises an open card to full with the dispute', async () => {
    const edits = [];
    const entry = Object.assign(entryFrom(params()), {
        messageId: 'm1', url: 'u', message: { edit: async (payload) => { edits.push(payload); return true; } },
    });
    registerCard(entry);
    const result = await markReviewCard({}, record(), { caseCode: 'k3f9a', reason: 'context', at: 1 });
    assert.equal(result, 'card');
    assert.equal(entry.tier, 'full');
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].allowedMentions, { parse: [] });
    assert.ok(edits[0].embeds[0].toJSON().fields.some((f) => f.value === 'context'));
});
