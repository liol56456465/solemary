// Ticket ratings (schema v14, docs/features-v14.md section 3; services/ticketRatingService.js,
// ticketRatingEffects.js, the ticket_feedback button / comment modal): opener only, one rating per
// ticket, the window, a comment once and only after the stars, staff = claimer else closer (also
// after an unclaim), a reopen keeps the rating, flagged comments shown in a spoiler, no pings, the
// DM-fail fallback in the ticket channel, and the 3-second rules (deferUpdate before any database
// work; no database work before showModal). No database, no Discord: the SQL and the interactions
// are fakes (tests/db/ticketRatings.test.js runs the same statements on PostgreSQL).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cleanComment, commentFieldName, commentFieldValue, createPendingRating, handlingStaffId, isCommentFlagged,
    ratingBadge, ratingSettings, starsText, submitComment, submitRating, weeklyRatingTrend,
} from '../src/services/ticketRatingService.js';
import { editTranscriptLogRating, postLowRatingAlert, channelSurveyPayload } from '../src/services/ticketRatingEffects.js';
import feedbackButtons, { handleDecline, handleRatingClick } from '../src/interactions/buttons/ticket/ticketFeedback.js';
import { handleCommentSubmit } from '../src/interactions/modals/ticket/ticketFeedbackComment.js';
import { closedOpenerAccess, postChannelSurvey, prepareTicketRating, ticketNumberOf } from '../src/services/ticket.js';
import { promptModmailRating } from '../src/services/modmailService.js';
import { renderDm } from '../src/services/botDm/dmRenderers.js';
import { botText, LANG_CODES } from '../src/utils/botText.js';

const G = '123456789012345678';
const C = '323456789012345678';
const OPENER = '223456789012345678';
const STAFF = '423456789012345678';
const OTHER = '523456789012345678';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 86_400_000;

const [ratingButton, commentButton] = feedbackButtons;

function row(over = {}) {
    return {
        id: 1, guild_id: G, kind: 'ticket', ref_id: C, ticket_number: '012', opener_id: OPENER, staff_id: STAFF, closer_id: STAFF,
        priority: 'high', prompted_at: new Date(NOW - DAY), expires_at: new Date(NOW + 6 * DAY), delivery: 'dm',
        rating: null, rated_at: null, comment: null, comment_at: null, comment_flagged: false, ...over,
    };
}

/** A query that answers UPDATE … RETURNING with `updated` and the follow-up SELECT with `found`. */
function fakeDb({ updated = [], found = null } = {}) {
    const seen = [];
    const query = async (text, params) => {
        seen.push({ text, params });
        if (/^\s*UPDATE/.test(text)) return { rows: updated, rowCount: updated.length };
        if (/^\s*SELECT/.test(text)) return { rows: found ? [found] : [] };
        return { rows: [], rowCount: 0 };
    };
    return { query, seen };
}

// ── settings, staff, formatting ───────────────────────────────────────────

test('settings: tickets on, modmail off, 7 days, alert on by default; window clamped to 1–30', () => {
    assert.deepEqual(ratingSettings({}), { ticketsEnabled: true, modmailEnabled: false, windowDays: 7, lowRatingAlert: true });
    assert.deepEqual(ratingSettings({ ticketRatingsEnabled: false, modmailRatingsEnabled: true, ticketRatingWindowDays: 30, ticketLowRatingAlert: false }),
        { ticketsEnabled: false, modmailEnabled: true, windowDays: 30, lowRatingAlert: false });
    for (const bad of [0, 31, 2.5, '7', null]) assert.equal(ratingSettings({ ticketRatingWindowDays: bad }).windowDays, 7, String(bad));
});

test('staff = the claimer at close, else the closer (an unclaim before the close leaves the closer)', () => {
    assert.equal(handlingStaffId({ claimedBy: STAFF }, OTHER), STAFF);
    assert.equal(handlingStaffId({ claimedBy: null }, OTHER), OTHER, 'unclaimed before close');
    assert.equal(handlingStaffId({}, OTHER), OTHER);
    assert.equal(handlingStaffId({ claimedBy: 'garbage' }, OTHER), OTHER);
    assert.equal(handlingStaffId({ userId: OPENER, claimedBy: null }, OPENER), null, 'an opener closing their own ticket is not staff');
});

test('stars, badge, ticket number', () => {
    assert.equal(starsText(4), '★★★★☆');
    assert.equal(starsText(0), '');
    assert.equal(ratingBadge(4.56, 5), '★4.6 (5)');
    assert.equal(ratingBadge(null, 0), '');
    assert.equal(ticketNumberOf({ number: '012' }, { name: 'x' }), '012');
    assert.equal(ticketNumberOf({ id: C }, { name: '🔴 ticket-034' }), '034', 'old tickets: from the channel name, never the channel id');
    assert.equal(ticketNumberOf({ id: C }, { name: 'help' }), null);
});

test('comment: one line, control characters out, max 1000; flagged ones in a labelled spoiler within 1024', () => {
    assert.equal(cleanComment('  good\nhelp\u0007 '), 'good help');
    assert.equal(cleanComment('x'.repeat(1500)).length, 1000);
    assert.equal(commentFieldName(true), 'Comment (flagged)');
    assert.equal(commentFieldValue('fine', false), 'fine');
    assert.equal(commentFieldValue('bad || word', true), '||bad \\|\\| word||');
    const long = commentFieldValue('|'.repeat(1000), true);
    assert.ok(long.length <= 1024 && long.startsWith('||') && long.endsWith('||'));
    assert.ok(!/(^|[^\\])\\\|\|$/.test(long), 'the closing spoiler is never escaped');
});

test('flagged: the automod word or insult list; a failing filter never blocks the comment', async () => {
    const filters = { findBlockedWord: (t) => (t.includes('slur') ? 'slur' : null), findInsult: (t) => (t.includes('idiot') ? 'idiot' : null) };
    assert.equal(await isCommentFlagged('you idiot', G, { filters }), true);
    assert.equal(await isCommentFlagged('a slur here', G, { filters }), true);
    assert.equal(await isCommentFlagged('thanks a lot', G, { filters }), false);
    assert.equal(await isCommentFlagged('x', G, { filters: { findBlockedWord: () => { throw new Error('settings down'); }, findInsult: () => null } }), false);
});

// ── the atomic statements ────────────────────────────────────────────────

test('rating: ONE UPDATE limited to the opener, not rated yet, window open', async () => {
    const db = fakeDb({ updated: [row({ rating: 4 })] });
    const result = await submitRating({ guildId: G, refId: C, userId: OPENER, rating: 4, now: NOW }, db);
    assert.equal(result.ok, true);
    assert.equal(db.seen.length, 1);
    assert.match(db.seen[0].text, /UPDATE ticket_ratings SET rating = \$4, rated_at = \$5/);
    assert.match(db.seen[0].text, /opener_id = \$3 AND rating IS NULL AND expires_at > \$5/);
    assert.deepEqual(db.seen[0].params.slice(0, 4), [G, C, OPENER, 4]);
});

test('rating refused: someone else, already rated, window over, unknown; a bad number never queries', async () => {
    const cases = [
        [row(), OTHER, 'notYours'],
        [row({ opener_id: null }), OPENER, 'notYours'], // the opener ran /wipedata
        [row({ rating: 5 }), OPENER, 'already'],
        [row({ expires_at: new Date(NOW - 1) }), OPENER, 'expired'],
        [null, OPENER, 'missing'],
    ];
    for (const [found, userId, reason] of cases) {
        const db = fakeDb({ found });
        const result = await submitRating({ guildId: G, refId: C, userId, rating: 3, now: NOW }, db);
        assert.deepEqual([result.ok, result.reason], [false, reason], reason);
    }
    const db = fakeDb();
    for (const bad of [0, 6, 2.5, NaN]) assert.equal((await submitRating({ guildId: G, refId: C, userId: OPENER, rating: bad }, db)).reason, 'invalid');
    assert.equal(db.seen.length, 0);
});

test('comment: once, only after a rating, inside the window, by the opener; empty never queries', async () => {
    const ok = fakeDb({ updated: [row({ rating: 2, comment: 'meh', comment_at: new Date(NOW), comment_flagged: true })] });
    const result = await submitComment({ guildId: G, refId: C, userId: OPENER, comment: ' meh ', flagged: true, now: NOW }, ok);
    assert.equal(result.ok, true);
    assert.match(ok.seen[0].text, /opener_id = \$3 AND rating IS NOT NULL\s+AND comment_at IS NULL AND expires_at > \$5/);
    assert.deepEqual(ok.seen[0].params.slice(0, 4), [G, C, OPENER, 'meh']);
    assert.equal(ok.seen[0].params[5], true, 'flagged is stored');
    const cases = [
        [row(), OPENER, 'notRated'],
        [row({ rating: 4, comment_at: new Date(NOW - 1000) }), OPENER, 'already'],
        [row({ rating: 4, expires_at: new Date(NOW - 1) }), OPENER, 'expired'],
        [row({ rating: 4 }), OTHER, 'notYours'],
        [null, OPENER, 'missing'],
    ];
    for (const [found, userId, reason] of cases) {
        assert.equal((await submitComment({ guildId: G, refId: C, userId, comment: 'x', now: NOW }, fakeDb({ found }))).reason, reason, reason);
    }
    const empty = fakeDb();
    assert.equal((await submitComment({ guildId: G, refId: C, userId: OPENER, comment: ' \n ' }, empty)).reason, 'empty');
    assert.equal(empty.seen.length, 0);
});

test('pending row at close: a re-close after a reopen refreshes it only while unrated (rated → null, no new survey)', async () => {
    const db = fakeDb();
    const result = await createPendingRating({ guildId: G, refId: C, openerId: OPENER, staffId: STAFF, closerId: OTHER, ticketNumber: '012', priority: 'high', windowDays: 7, now: NOW }, db);
    assert.equal(result, null, 'nothing returned = already rated');
    const insert = db.seen.find((s) => /INSERT INTO ticket_ratings/.test(s.text));
    assert.match(insert.text, /ON CONFLICT \(guild_id, kind, ref_id\) DO UPDATE SET[^]*WHERE ticket_ratings\.rating IS NULL/);
    assert.equal(insert.params[9].getTime() - insert.params[8].getTime(), 7 * DAY, 'the window');
    assert.match(db.seen[0].text, /INSERT INTO guilds/, 'the server row first (modmail servers may have none)');
    await assert.rejects(createPendingRating({ guildId: 'x', refId: C, openerId: OPENER }, db), /bad ids/);
    await assert.rejects(createPendingRating({ guildId: G, refId: C, openerId: OPENER, kind: 'other' }, db), /bad kind/);
});

test('trend: 8 Monday weeks, oldest first, empty weeks 0', async () => {
    const query = async () => ({ rows: [{ bucket: 7, avg: 4.5, count: 2 }, { bucket: 0, avg: 1, count: 1 }] });
    const weeks = await weeklyRatingTrend(G, { now: NOW }, { query });
    assert.equal(weeks.length, 8);
    assert.equal(weeks[7].week, '2026-11-09');
    assert.equal(weeks[0].week, '2026-09-21');
    assert.deepEqual([weeks[0].count, weeks[3].count, weeks[7].avg], [1, 0, 4.5]);
});

// ── the handlers: 3-second rules and replies ─────────────────────────────

/** `deferred`: as the handlers leave it after deferUpdate (handleRatingClick runs after the ack). */
function fakeInteraction({ guildId = null, userId = OPENER, deferred = false } = {}) {
    const calls = [];
    const interaction = {
        id: '900000000000000001', createdTimestamp: Date.now(), user: { id: userId }, guildId, client: { id: 'client' },
        deferred, replied: false, calls,
        deferUpdate: async () => { calls.push('deferUpdate'); interaction.deferred = true; },
        deferReply: async () => { calls.push('deferReply'); interaction.deferred = true; },
        editReply: async (payload) => { calls.push({ editReply: payload }); },
        reply: async (payload) => { calls.push({ reply: payload }); interaction.replied = true; },
        followUp: async (payload) => { calls.push({ followUp: payload }); },
        update: async (payload) => { calls.push({ update: payload }); },
        showModal: async (modal) => { calls.push({ showModal: modal }); },
        isRepliable: () => true,
    };
    return interaction;
}
const embedText = (payload) => JSON.stringify(payload.embeds?.map((e) => (e.toJSON ? e.toJSON() : e)));

test('rating button: deferUpdate before any database work; the saved answer keeps only "Add a comment"', async () => {
    const interaction = fakeInteraction();
    const effects = [];
    await ratingButton.execute(interaction, null, [G, C, '5'], {
        submit: async (args) => { interaction.calls.push({ submit: args }); return { ok: true, row: row({ rating: 5 }) }; },
        effects: async (_client, r) => { effects.push(r.rating); },
    });
    assert.equal(interaction.calls[0], 'deferUpdate');
    assert.deepEqual(interaction.calls[1].submit, { guildId: G, refId: C, userId: OPENER, rating: 5 });
    const edit = interaction.calls.find((c) => c.editReply).editReply;
    assert.deepEqual(edit.allowedMentions, { parse: [] });
    const ids = edit.components.flatMap((r) => r.toJSON().components.map((b) => b.custom_id));
    assert.deepEqual(ids, [`ticket_feedback_comment:${G}:${C}`]);
    assert.deepEqual(effects, [5], 'log, transcript edit and alert run once');
});

test('rating button: an old survey without a row copies its ticket in first, then rates; window over → buttons go', async () => {
    const interaction = fakeInteraction({ deferred: true });
    let attempts = 0;
    const order = [];
    await handleRatingClick(interaction, { guildId: G, refId: C, rating: 4 }, {
        submit: async () => { attempts += 1; order.push('submit'); return attempts === 1 ? { ok: false, reason: 'missing' } : { ok: true, row: row({ rating: 4 }) }; },
        loadTicket: async () => { order.push('load'); return { userId: OPENER, closedAt: new Date(NOW).toISOString() }; },
        loadConfig: async () => ({ ticketRatingWindowDays: 3 }),
        materialize: async (g, ref, ticket, { windowDays }) => { order.push(`materialize:${windowDays}`); return row(); },
        effects: async () => {},
    });
    assert.deepEqual(order, ['submit', 'load', 'materialize:3', 'submit']);

    const late = fakeInteraction({ deferred: true });
    await handleRatingClick(late, { guildId: G, refId: C, rating: 4 }, {
        submit: async () => ({ ok: false, reason: 'expired', row: row() }), effects: async () => assert.fail('no effects'),
    });
    const edit = late.calls.find((c) => c.editReply).editReply;
    assert.deepEqual(edit.components, [], 'rating window closed: buttons removed');
    assert.match(embedText(edit), new RegExp(botText('en').t('ticket.rating.closedTitle')));
});

test('rating button in the ticket channel (O2): another member is told privately, the survey stays', async () => {
    const interaction = fakeInteraction({ guildId: G, userId: OTHER, deferred: true });
    await handleRatingClick(interaction, { guildId: G, refId: C, rating: 1 }, {
        submit: async () => ({ ok: false, reason: 'notYours', row: row() }), effects: async () => assert.fail('no effects'),
    });
    assert.ok(!interaction.calls.some((c) => c.editReply), 'the shared survey is not edited');
    const follow = interaction.calls.find((c) => c.followUp).followUp;
    assert.equal(follow.flags, 64);
    assert.deepEqual(follow.allowedMentions, { parse: [] });
});

test('rating button: a database error says not saved (never "saved")', async () => {
    const interaction = fakeInteraction({ deferred: true });
    await handleRatingClick(interaction, { guildId: G, refId: C, rating: 4 }, { submit: async () => { throw new Error('db down'); } });
    const edit = interaction.calls.find((c) => c.editReply).editReply;
    assert.match(embedText(edit), new RegExp(botText('en').t('ticket.feedback.notSavedTitle')));
});

test('comment button: shows the form at once, with no database work before showModal', async () => {
    const interaction = fakeInteraction();
    assert.equal(commentButton.opensModal, true);
    await commentButton.execute(interaction, null, [G, C]);
    assert.equal(interaction.calls.length, 1);
    const modal = interaction.calls[0].showModal.toJSON();
    assert.equal(modal.custom_id, `ticket_feedback_comment_modal:${G}:${C}`);
    assert.equal(modal.components[0].components[0].max_length, 1000);
});

test('comment form: re-checks everything; refusals do not save; a saved one goes to the log flagged', async () => {
    const form = (value) => ({ ...fakeInteraction(), fields: { getTextInputValue: () => value } });
    const empty = form('   ');
    const r0 = await handleCommentSubmit(empty, [G, C], { submit: async () => assert.fail('no db') });
    assert.equal(r0.reason, 'empty');

    for (const reason of ['notRated', 'already', 'expired', 'notYours']) {
        const i = form('hello');
        const r = await handleCommentSubmit(i, [G, C], { flag: async () => false, submit: async () => ({ ok: false, reason, row: row() }), effects: async () => assert.fail('no log') });
        assert.equal(r.reason, reason);
        assert.ok(i.calls.includes('deferReply'));
    }

    const i = form('you idiot');
    i.message = { edit: async (payload) => { i.calls.push({ messageEdit: payload }); } };
    const logged = [];
    const r = await handleCommentSubmit(i, [G, C], {
        flag: async () => true,
        submit: async (args) => { assert.equal(args.flagged, true); return { ok: true, row: row({ rating: 2, comment: args.comment, comment_flagged: true }) }; },
        effects: async (_c, saved) => { logged.push(saved); },
    });
    assert.equal(r.ok, true);
    assert.equal(logged[0].comment_flagged, true);
    assert.deepEqual(i.calls.find((c) => c.messageEdit).messageEdit.components, [], 'the survey loses its last button');
});

test('No thanks: in a DM it closes the survey; in the ticket channel only the opener can', async () => {
    const dm = fakeInteraction();
    assert.equal(await handleDecline(dm, [G, C], { find: async () => assert.fail('no db in a DM') }), true);
    assert.deepEqual(dm.calls[0].update.components, []);

    const stranger = fakeInteraction({ guildId: G, userId: OTHER });
    assert.equal(await handleDecline(stranger, [G, C], { find: async () => row() }), false);
    assert.equal(stranger.calls[0], 'deferUpdate');
    assert.ok(stranger.calls.some((c) => c.followUp) && !stranger.calls.some((c) => c.editReply));

    const opener = fakeInteraction({ guildId: G });
    assert.equal(await handleDecline(opener, [G, C], { find: async () => row() }), true);

    const down = fakeInteraction({ guildId: G });
    assert.equal(await handleDecline(down, [G, C], { find: async () => { throw new Error('db down'); } }), false);
    const told = JSON.stringify(down.calls.find((c) => c.followUp).followUp.embeds.map((e) => e.toJSON()));
    assert.ok(told.includes(botText('en').t('ticket.feedback.notSavedTitle')), 'a database error is said as such, not "not yours"');
});

// ── close flow pieces, effects, no pings ─────────────────────────────────

test('close: ratings off → no row; a database error → no survey (the close goes on)', async () => {
    const channel = { id: C, guild: { id: G } };
    assert.equal(await prepareTicketRating(channel, { userId: OPENER }, { id: STAFF }, { ticketRatingsEnabled: false }, { create: async () => assert.fail('no row') }), null);
    assert.equal(await prepareTicketRating(channel, { userId: OPENER }, { id: STAFF }, {}, { create: async () => { throw new Error('db down'); } }), null);
    let args;
    await prepareTicketRating(channel, { userId: OPENER, claimedBy: OTHER, number: '012', priority: 'high' }, { id: STAFF }, { ticketRatingWindowDays: 14 }, { create: async (a) => { args = a; return row(); } });
    assert.deepEqual([args.staffId, args.closerId, args.ticketNumber, args.priority, args.windowDays, args.kind], [OTHER, STAFF, '012', 'high', 14, 'ticket']);
});

test('DM failed (O2): survey posted in the ticket channel without pings, delivery "channel"; the opener reads only', async () => {
    assert.deepEqual(closedOpenerAccess(true), { ViewChannel: true, ReadMessageHistory: true, SendMessages: false });
    assert.deepEqual(closedOpenerAccess(false), { ViewChannel: false, SendMessages: false });
    const sent = [];
    const edits = [];
    const deliveries = [];
    const channel = { id: C, name: 'ticket-012', guild: { id: G }, send: async (p) => { sent.push(p); return { id: '1' }; }, permissionOverwrites: { edit: async (...a) => edits.push(a) } };
    const delivery = await postChannelSurvey(channel, { userId: OPENER }, row(), { setDelivery: async (id, d) => deliveries.push(d) });
    assert.equal(delivery, 'channel');
    assert.deepEqual(deliveries, ['channel']);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    assert.ok(sent[0].content.includes(`<@${OPENER}>`), 'named, not pinged');
    assert.equal(sent[0].components[0].toJSON().components[0].custom_id, `ticket_feedback:${G}:${C}:1`);
    assert.equal(edits.length, 0);

    const broken = { ...channel, send: async () => { throw new Error('Missing Access'); } };
    const failed = await postChannelSurvey(broken, { userId: OPENER }, row(), { setDelivery: async (id, d) => deliveries.push(d) });
    assert.equal(failed, 'failed');
    assert.deepEqual(edits[0], [OPENER, { ViewChannel: false, SendMessages: false }], 'nothing to read: hidden again');
});

test('channel survey text exists in every language with the opener placeholder', async () => {
    for (const lang of LANG_CODES) {
        const text = botText(lang).t('ticket.rating.channelPrompt', { user: '<@1>' });
        assert.ok(text.includes('<@1>'), lang);
    }
    const payload = await channelSurveyPayload({ guildId: G, channelId: C, channelName: 'ticket-1', openerId: OPENER });
    assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('modmail: off by default (no row, no DM); on → the row with the closer as staff, DM, delivery saved', async () => {
    const channel = { id: C, name: 'modmail-x', client: {}, guild: { id: G } };
    const none = await promptModmailRating(channel, { id: OPENER }, OPENER, { id: STAFF }, { loadConfig: async () => ({}), create: async () => assert.fail('off') });
    assert.equal(none, null);
    let created;
    const deliveries = [];
    const sentKeys = [];
    const delivery = await promptModmailRating(channel, { id: OPENER }, OPENER, { id: STAFF }, {
        loadConfig: async () => ({ modmailRatingsEnabled: true }),
        create: async (a) => { created = a; return row({ kind: 'modmail' }); },
        setDelivery: async (id, d) => deliveries.push(d),
        send: async (user, o) => { sentKeys.push([o.key, o.params.kind]); return false; },
    });
    assert.deepEqual([created.kind, created.staffId, created.openerId], ['modmail', STAFF, OPENER]);
    assert.deepEqual(sentKeys, [['ticket.feedback', 'modmail']]);
    assert.equal(delivery, 'failed');
    assert.deepEqual(deliveries, ['failed']);
    const survey = await renderDm('ticket.feedback', { channelName: 'm', guildId: G, channelId: C, kind: 'modmail' }, 'en');
    assert.equal(survey.embeds[0].toJSON().description, botText('en').t('ticket.dm.modmailFeedbackBody'));
});

test('language change: a rated survey (only "Add a comment" left) is never re-rendered with its stars', async () => {
    const { DM_RENDERERS } = await import('../src/services/botDm/dmRenderers.js');
    const { stillCurrent } = DM_RENDERERS['ticket.feedback'];
    const open = await renderDm('ticket.feedback', { channelName: 't', guildId: G, channelId: C }, 'en');
    assert.equal(stillCurrent({ components: open.components.map((r) => r.toJSON()) }), true, 'still open');
    const rated = [{ components: [{ customId: `ticket_feedback_comment:${G}:${C}` }] }];
    assert.equal(stillCurrent({ components: rated }), false, 'rated: moved on');
    assert.equal(stillCurrent({ components: [] }), false, 'answered: moved on');
});

test('transcript log: a Rating field is added to the saved transcript message, no pings', async () => {
    const edits = [];
    const message = { embeds: [{ toJSON: () => ({ title: 'Ticket transcript', fields: [{ name: 'Rating', value: 'old' }] }) }], edit: async (p) => edits.push(p) };
    const client = { channels: { fetch: async () => ({ guildId: G, messages: { fetch: async () => message } }) } };
    const ok = await editTranscriptLogRating(client, row({ rating: 3 }), { loadTicket: async () => ({ transcriptLog: { channelId: '1', messageId: '2' } }) });
    assert.equal(ok, true);
    assert.deepEqual(edits[0].embeds[0].fields, [{ name: 'Rating', value: '★★★☆☆ 3/5', inline: true }]);
    assert.deepEqual(edits[0].allowedMentions, { parse: [] });
    assert.equal(await editTranscriptLogRating(client, row({ kind: 'modmail', rating: 3 })), false, 'modmail has no transcript log id');
});

test('low-rating alert: ≤2 stars, staff as text (no mention), no pings; off or 3+ stars → nothing', async () => {
    const sent = [];
    const channel = { send: async (p) => sent.push(p) };
    const client = { users: { fetch: async () => ({ username: 'helper' }) }, guilds: { cache: { get: () => ({ channels: { cache: { get: () => ({ ...channel, isTextBased: () => true }) } } }) } } };
    // fetchStaffChannel reads the server's alerts channel from settings; give it one through the config path.
    const { setSettingsCacheForTests, resetSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
    setSettingsCacheForTests(G, { alertsChannelId: '623456789012345678' });
    try {
        assert.equal(await postLowRatingAlert(client, row({ rating: 3 }), { config: {} }), false);
        assert.equal(await postLowRatingAlert(client, row({ rating: 2 }), { config: { ticketLowRatingAlert: false } }), false);
        assert.equal(await postLowRatingAlert(client, row({ rating: 1 }), { config: {} }), true);
        assert.deepEqual(sent[0].allowedMentions, { parse: [] });
        const text = JSON.stringify(sent[0].embeds);
        assert.ok(text.includes(`helper (${STAFF})`) && !text.includes('<@'), 'staff shown as text');
    } finally {
        resetSettingsCacheForTests();
    }
});
