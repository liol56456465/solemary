// Beginner audit wave 4, member side (docs/beginner-audit-2026-11-09.md): what a regular member
// reads. Punishment DMs title first and at most 7 lines (4.1), the warn DM's calm "what happens
// next" (4.2), the ban-ended "next warning bans again" line, the admin refusal wording (4.4), ticket
// DMs that name the server and carry the transcript (4.5), giveaway info reply / Leave / winner DM
// (4.7), "warning stage" and /wipedata wording (4.9), report and reminder replies.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID = '100000000000000001';
process.env.SUPPORT_GUILD_ID = '100000000000000002';
const MAIN = process.env.MAIN_GUILD_ID;
const OTHER = '100000000000000777';
const OWN_INVITE = 'https://discord.gg/ourOwn42';

const { LANG_CODES } = await import('../src/services/site/i18n.js');
const { botText } = await import('../src/utils/botText.js');
const { resetSettingsCacheForTests, setSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const { banDm, banEndedDm, kickDm, muteDm, warnDm } = await import('../src/services/enforcement/dmTemplates.js');
const { refusalKey } = await import('../src/services/enforcement/panelAccess.js');
const { getAdminRequiredMessage } = await import('../src/utils/commandGate.js');
const { renderDm, DM_RENDERERS } = await import('../src/services/botDm/dmRenderers.js');
const { dmGiveawayWinners } = await import('../src/services/giveawayService.js');
const { giveawayJoinHandler, giveawayLeaveHandler, giveawayLeaveRow } = await import('../src/handlers/giveawayButtons.js');
const { wipeWarningText } = await import('../src/commands/Utility/wipedata.js');
const { reminderMessage } = await import('../src/services/reminders/reminderService.js');

const saved = { PUBLIC_URL: process.env.PUBLIC_URL, MEMBER_PORTAL_ENABLED: process.env.MEMBER_PORTAL_ENABLED };
afterEach(() => {
    resetSettingsCacheForTests();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const caseOf = (guildId, extra = {}) => ({
    guild_id: guildId, case_code: 'abc2345', moderator_username: 'mod', reason: 'Spam', reason_key: null,
    prebuilt_or_custom: 'custom', created_at: new Date('2026-10-28T10:00:00Z'), type: 'ban',
    expires_at: new Date('2026-11-04T10:00:00Z'), duration_ms: 7 * 86400000, ...extra,
});
const body = (dm) => dm.split('\n').filter((l) => !l.startsWith('-# '));
const TITLE = /^\*\*.+\*\*$/;

// ── 4.1 punishment DMs ────────────────────────────────────────────────

test('4.1 every punishment DM: title first, at most 7 lines before the privacy footer, case code "(you need this to appeal)", in every language', () => {
    // The longest case: another server with its own invite, the member portal on, a privacy link.
    process.env.PUBLIC_URL = 'https://mewvo.example';
    process.env.MEMBER_PORTAL_ENABLED = 'true';
    setSettingsCacheForTests(OTHER, { appealsHome: 'own', appealsInvite: OWN_INVITE });
    const ladder3 = caseOf(OTHER, { is_auto: true, ladder_level_after: 3, appeal_deadline: new Date('2027-05-01T00:00:00Z'), expires_at: null, duration_ms: null });
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const dms = {
            ban: banDm(caseOf(OTHER), { lang, serverName: 'Cat Café' }),
            ladderBan: banDm(ladder3, { lang, serverName: 'Cat Café' }),
            kick: kickDm(caseOf(OTHER, { type: 'kick' }), 'https://discord.gg/one', { lang, serverName: 'Cat Café' }),
            mute: muteDm(caseOf(OTHER, { type: 'mute' }), { lang, serverName: 'Cat Café' }),
            warn: warnDm(caseOf(OTHER, { type: 'warn', expires_at: null }), 1, { lang, serverName: 'Cat Café' }),
        };
        for (const [name, dm] of Object.entries(dms)) {
            const lines = body(dm);
            assert.ok(TITLE.test(lines[0]) && lines[0].includes('Cat Café'), `${lang} ${name}: title first: ${dm}`);
            assert.ok(lines.length <= 7, `${lang} ${name}: ${lines.length} lines\n${dm}`);
            assert.equal(lines.at(-1), tr.t('enforcement.dm.caseCodeAppeal', { code: 'abc2345' }), `${lang} ${name}: case code last`);
            assert.ok(dm.includes(OWN_INVITE) && dm.includes('https://mewvo.example/me/appeal/abc2345'), `${lang} ${name}: both appeal paths on one line`);
            assert.ok(dm.endsWith(tr.t('enforcement.dm.privacy', { url: 'https://mewvo.example/privacy' })), `${lang} ${name}: privacy footer`);
            assert.ok(!/\{[a-zA-Z]+\}/.test(dm) && !dm.includes('undefined'), `${lang} ${name}`);
        }
        assert.match(dms.ban, /<t:\d+:F> \(<t:\d+:R>\)/, `${lang}: ban end time absolute + relative`);
        assert.match(dms.mute, /<t:\d+:F> \(<t:\d+:R>\)/, `${lang}: mute end time`);
        assert.ok(dms.mute.includes(tr.t('enforcement.dm.mute.next')), `${lang}: mute says what it means`);
        assert.ok(dms.kick.includes('https://discord.gg/one'), `${lang}: kick carries its rejoin invite`);
        assert.ok(dms.ladderBan.includes(tr.t('enforcement.dm.ban.autoNote')), `${lang}: ladder ban explains the appeal`);
        assert.ok(!dms.ban.includes(tr.t('enforcement.dm.ban.autoNote')), `${lang}: a manual ban has no ladder note`);
    }
});

test('4.1 order: title, reason, duration, next, appeal, case code; unappealable says so without "(you need this to appeal)"', () => {
    const lines = body(banDm(caseOf(MAIN)));
    assert.equal(lines[0], '**Banned from Mewvo**');
    assert.equal(lines[1], 'Reason: Spam');
    assert.match(lines[2], /^Duration: 7 days, ends <t:\d+:F> \(<t:\d+:R>\)$/);
    assert.match(lines[3], /^\*\*Appeal here:\*\* /);
    assert.equal(lines[4], 'Case code: abc2345 (you need this to appeal)');
    assert.ok(!lines.some((l) => l.startsWith('By:') || l.startsWith('Date:')), 'no moderator or date line');
    const never = body(banDm(caseOf(MAIN, { unappealable: true, expires_at: null, duration_ms: null })));
    assert.deepEqual(never.slice(-2), ['This ban cannot be appealed.', 'Case code: abc2345']);
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const dm = banDm(caseOf(OTHER, { unappealable: true }), { lang });
        assert.ok(dm.includes(tr.t('enforcement.dm.cannotAppeal')) && !dm.includes(tr.t('enforcement.dm.caseCodeAppeal', { code: 'abc2345' })), lang);
    }
});

// ── 4.2 warn DM ───────────────────────────────────────────────────────

test('4.2 counted warn: "warnings don\'t expire" and how many more lead to which ban; uncounted / ladder off: no ban talk', () => {
    const rec = caseOf(MAIN, { type: 'warn', expires_at: null, ladder_level_after: 0 });
    assert.ok(warnDm(rec, 1).includes("Warnings don't expire. 2 more warnings mean an automatic ban for 7 days."));
    assert.ok(warnDm(rec, 2).includes("Warnings don't expire. 1 more warning means an automatic ban for 7 days."));
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const counted = warnDm(rec, 2, { lang });
        assert.ok(counted.includes(tr.tp('enforcement.dm.warn.next', 1, { length: tr.tp('enforcement.duration.day', 7) })), lang);
        const uncounted = warnDm({ ...rec, guild_id: OTHER }, null, { lang });
        assert.ok(uncounted.includes(tr.t('enforcement.dm.warn.notCounted')), lang);
        assert.ok(!uncounted.includes(tr.tp('enforcement.duration.day', 7)), `${lang}: no ban length`);
        assert.ok(body(uncounted)[0] === tr.t('enforcement.dm.warn.titleRecorded', { server: tr.t('enforcement.dm.thisServer') }), `${lang}: title first`);
    }
});

test('4.2 ban ended after a ladder ban: the next warning bans again (real length); not for manual, stage 3, or ladder off', () => {
    setSettingsCacheForTests(OTHER, {});
    const ended = (extra, opts) => banEndedDm(caseOf(OTHER, { is_auto: true, ...extra }), null, { serverName: 'Cat Café', ...opts });
    assert.ok(ended({ ladder_level_after: 1 }).includes("Warnings don't expire, so your next warning here means another automatic ban, for 1 month."));
    assert.ok(ended({ ladder_level_after: 1 }, { early: true }).includes('another automatic ban'), 'an unban does not move the ladder');
    assert.ok(ended({ ladder_level_after: 2 }).includes('an automatic permanent ban'));
    assert.ok(!ended({ ladder_level_after: 3 }).includes('next warning'));
    assert.ok(!ended({ is_auto: false, ladder_level_after: 1 }).includes('next warning'), 'manual ban');
    setSettingsCacheForTests(OTHER, { warnLadderEnabled: false });
    assert.ok(!ended({ ladder_level_after: 1 }).includes('next warning'), 'ladder off');
    resetSettingsCacheForTests();
    // Settings unreadable (another server, cache empty): the DM goes out without the line.
    assert.ok(!ended({ ladder_level_after: 1 }).includes('next warning'));
    for (const lang of LANG_CODES) {
        setSettingsCacheForTests(OTHER, {});
        const dm = ended({ ladder_level_after: 1 }, { lang });
        assert.ok(dm.includes(botText(lang).t('enforcement.dm.banEnded.nextWarn', { length: botText(lang).tp('enforcement.duration.month', 1) })), `${lang}: ${dm}`);
    }
});

// ── 4.4 refusals ──────────────────────────────────────────────────────

test('4.4 admin refusal: "Only server admins"; home keeps its request channel; other servers name the Moderator role on the panel', () => {
    assert.ok(getAdminRequiredMessage(MAIN).startsWith('Only server admins can use this.'));
    const other = getAdminRequiredMessage(OTHER, { stored: () => null });
    assert.equal(other, 'Only server admins can use this. Ask an admin of this server if you need access.');
    const en = botText('en');
    assert.equal(en.t(refusalKey({}, MAIN)), 'Only server admins can use this panel.');
    assert.equal(en.t(refusalKey({}, OTHER)), "Only server admins and members with this server's Moderator role can use this panel.");
    assert.match(en.t(refusalKey({}, OTHER, { forWarn: true })), /Moderator role can warn members/);
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const key of ['errors.access.admin', 'errors.access.adminOther', 'giveaway.button.needAdminEnd', 'tools.countdown.adminOnly']) {
            assert.ok(!/Administrator role|rol de Administrador|Administrator-Rolle|rôle Administrateur|ruolo Amministratore|roli Administrator|cargo de Administrador|роль администратора/.test(tr.t(key)), `${lang} ${key}: ${tr.t(key)}`);
        }
    }
});

// ── 4.5 ticket DMs ────────────────────────────────────────────────────

test('4.5 ticket DMs name the server; the closure DM can carry the transcript; old logged DMs (no serverName) still render', async () => {
    const base = { channelName: 'ticket-0042', reason: 'Solved', closer: 'mod#1', time: 1700000000, ticketId: 42 };
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const closed = (await renderDm('ticket.closed', { ...base, serverName: 'Cat Café', transcript: true }, lang)).embeds[0].toJSON();
        assert.ok(closed.description.includes(tr.t('ticket.dm.inServer', { server: 'Cat Café' })), lang);
        assert.ok(closed.description.endsWith(tr.t('ticket.dm.transcriptAttached')), lang);
        const old = (await renderDm('ticket.closed', base, lang)).embeds[0].toJSON();
        assert.ok(!old.description.includes('Cat Café') && !old.description.includes(tr.t('ticket.dm.transcriptAttached')), lang);
        const survey = await renderDm('ticket.feedback', { channelName: 't', serverName: 'Cat Café', guildId: '1', channelId: '2' }, lang);
        assert.ok(survey.embeds[0].toJSON().description.includes('Cat Café') && survey.components.length === 2, `${lang}: survey keeps its buttons`);
        const transcript = (await renderDm('ticket.transcript', { channelName: 't', serverName: 'Cat Café', ticketId: 1 }, lang)).embeds[0].toJSON();
        assert.ok(transcript.description.includes('Cat Café'), lang);
    }
    // The survey stays its own message: still "current" while its stars are there.
    const survey = await renderDm('ticket.feedback', { channelName: 't', serverName: 'X', guildId: '1', channelId: '2' }, 'en');
    assert.equal(DM_RENDERERS['ticket.feedback'].stillCurrent({ components: survey.components.map((r) => r.toJSON()) }), true);
});

// ── 4.7 giveaways ─────────────────────────────────────────────────────

test('4.7 winner DM: names the prize, the server and the host; no mentions; a failing DM is logged and skipped', async () => {
    const sent = [];
    const client = { guilds: { cache: new Map([[OTHER, { name: 'Cat **Café** @everyone', members: { cache: new Map() } }]]) } };
    const users = { '200000000000000001': { id: '200000000000000001' }, '200000000000000002': { id: '200000000000000002' } };
    const send = async (user, o) => {
        if (user.id === '200000000000000002') throw new Error('Cannot send messages to this user');
        sent.push([user.id, o]);
        return true;
    };
    const delivered = await dmGiveawayWinners(client, {
        guildId: OTHER, giveaway: { prize: 'Nitro', hostId: '300000000000000009' }, winners: ['200000000000000001', '200000000000000002', 'bad'],
        channelId: '400000000000000001', messageId: '500000000000000001',
    }, { send, fetchUser: async (id) => users[id] || null });
    assert.equal(delivered, 1, 'one delivered, the closed DM tolerated');
    assert.equal(sent[0][1].key, 'giveaway.won');
    const { content } = await renderDm('giveaway.won', sent[0][1].params, 'en');
    assert.equal(content, [
        '🎉 You won **Nitro** in **Cat \\*\\*Café\\*\\* @\u200beveryone**!',
        "To get your prize, message the host <@300000000000000009> or ask the server's staff.",
        `Giveaway: https://discord.com/channels/${OTHER}/400000000000000001/500000000000000001`,
    ].join('\n'));
    for (const lang of LANG_CODES) {
        const dm = (await renderDm('giveaway.won', { prize: 'P', serverName: null, hostId: null, url: null }, lang)).content;
        assert.ok(dm.includes(botText(lang).t('giveaway.dm.claimStaff')) && !dm.includes('{'), lang);
    }
    assert.equal(await dmGiveawayWinners(client, { guildId: OTHER, giveaway: {}, winners: [] }), 0);
});

function giveawayWorld({ participants = [], ended = false } = {}) {
    const giveaway = { messageId: '500000000000000001', channelId: '400000000000000001', prize: 'Nitro', hostId: '300000000000000009', winnerCount: 1, participants: [...participants], endsAt: Date.now() + 3600000, ended };
    const replies = [];
    const edits = [];
    const interaction = {
        id: 'i1', customId: 'giveaway_join', guildId: OTHER, user: { id: '200000000000000001', tag: 'u#1' }, locale: 'en-US',
        message: { id: giveaway.messageId, edit: async (p) => edits.push(p) },
        deferred: false, replied: false, createdTimestamp: Date.now(),
        inGuild: () => true,
        deferReply: async function deferReply() { this.deferred = true; },
        editReply: async (p) => { replies.push(p); },
        reply: async function reply(p) { this.replied = true; replies.push(p); },
        followUp: async (p) => replies.push(p),
    };
    return { giveaway, replies, edits, interaction };
}

test('4.7 Leave button: routed by its prefix, carries the giveaway message id; label in the member\'s language', () => {
    const row = giveawayLeaveRow('500000000000000001', botText('de')).toJSON();
    assert.equal(row.components[0].custom_id, 'giveaway_leave:500000000000000001');
    assert.equal(row.components[0].custom_id.split(':')[0], giveawayLeaveHandler.customId);
    assert.equal(row.components[0].label, botText('de').t('giveaway.buttons.leave'));
    assert.ok(row.components[0].label.length <= 80);
    assert.equal(giveawayJoinHandler.customId, 'giveaway_join');
});

/** A client whose key-value store holds this giveaway (no Postgres rows: the store path). */
function storeClient(giveaway, messageEdits = []) {
    const store = new Map([[`guild:${OTHER}:giveaways`, { [giveaway.messageId]: giveaway }]]);
    return {
        store,
        db: { get: async (k, d) => store.get(k) ?? d, set: async (k, v) => { store.set(k, v); return true; } },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async (p) => messageEdits.push(p) }) } }) },
    };
}
const stored = (client, giveaway) => client.store.get(`guild:${OTHER}:giveaways`)[giveaway.messageId];

test('4.7 "already in" is an info reply (not a red error) with the Leave button; Leave removes only the clicker', async () => {
    const ME = '200000000000000001';
    const w = giveawayWorld({ participants: [ME, '200000000000000009'] });
    const client = storeClient(w.giveaway);
    await giveawayJoinHandler.execute(w.interaction, client);
    assert.equal(w.interaction.deferred, true, 'acknowledged before the lock');
    const info = w.replies.at(-1);
    assert.equal(info.embeds[0].data.title, 'Already entered');
    assert.notEqual(info.embeds[0].data.title, 'Error');
    assert.equal(info.components[0].toJSON().components[0].custom_id, `giveaway_leave:${w.giveaway.messageId}`);
    assert.deepEqual(stored(client, w.giveaway).participants, [ME, '200000000000000009'], 'nothing changed');

    const messageEdits = [];
    const leave = giveawayWorld();
    leave.interaction.customId = `giveaway_leave:${w.giveaway.messageId}`;
    // (Another participant: the join click above rate-limits ME on this giveaway for a second.)
    leave.interaction.user = { id: '200000000000000009', tag: 'u#9' };
    const client2 = storeClient(stored(client, w.giveaway), messageEdits);
    await giveawayLeaveHandler.execute(leave.interaction, client2);
    assert.equal(leave.interaction.deferred, true);
    assert.deepEqual(stored(client2, w.giveaway).participants, [ME], 'only the clicker left');
    assert.equal(leave.replies.at(-1).embeds[0].data.title, 'You left the giveaway');
    assert.equal(messageEdits.length, 1, 'the giveaway message shows the new count');

    // A second click: nothing to leave (info), nothing changed.
    const again = giveawayWorld();
    again.interaction.customId = `giveaway_leave:${w.giveaway.messageId}`;
    again.interaction.user = { id: '200000000000000008', tag: 'u#8' };
    await giveawayLeaveHandler.execute(again.interaction, client2);
    assert.match(again.replies.at(-1).embeds[0].data.description, /nothing to leave/);
    assert.deepEqual(stored(client2, w.giveaway).participants, [ME]);
});

test('4.7 Leave on an ended giveaway: refused, entries unchanged', async () => {
    const w = giveawayWorld({ participants: ['200000000000000005'], ended: true });
    w.interaction.customId = `giveaway_leave:${w.giveaway.messageId}`;
    w.interaction.user = { id: '200000000000000005', tag: 'u#5' };
    const client = storeClient(w.giveaway);
    await giveawayLeaveHandler.execute(w.interaction, client);
    assert.deepEqual(stored(client, w.giveaway).participants, ['200000000000000005']);
    assert.match(JSON.stringify(w.replies.at(-1)), /already ended/);
});

test('4.7 source: the join handler answers "already in" with infoEmbed + Leave, never replyUserError', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/handlers/giveawayButtons.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('participants.includes(userId)'), src.indexOf('participants.push(userId)'));
    assert.match(block, /infoEmbed\(tr\.t\('giveaway\.button\.alreadyInTitle'\)/);
    assert.match(block, /giveawayLeaveRow\(interaction\.message\.id, tr\)/);
    assert.doesNotMatch(block, /replyUserError/);
    const routes = readFileSync(new URL('../src/interactions/buttons/giveaway/giveaway.js', import.meta.url), 'utf8');
    assert.match(routes, /fromCustomId\(giveawayLeaveHandler\)/);
});

test('4.7 Leave: a bad customId is refused before any work (no defer, no store read)', async () => {
    const { interaction, replies } = giveawayWorld();
    interaction.customId = 'giveaway_leave:not-an-id';
    let read = false;
    await giveawayLeaveHandler.execute(interaction, { get giveaways() { read = true; return null; } });
    assert.equal(read, false);
    assert.equal(interaction.deferred, false);
    assert.ok(replies.length >= 1, 'answered');
});

// ── 4.9 jargon, /wipedata, report, reminder ────────────────────────────

test('4.9 /wipedata: the 9 items stay (8 + personal language, wave G); what is deleted where and what stays (and why), in every language', () => {
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const text = wipeWarningText(tr);
        assert.equal(text.split('\n- ').length, 10, lang);
        assert.ok(text.includes(tr.t('utility.wipedata.body')) && tr.t('utility.wipedata.body').includes('**'), `${lang}: "what stays" in bold`);
        assert.ok(tr.t('utility.wipedata.done', { items: 'x' }).includes('**'), lang);
    }
    assert.match(botText('en').t('utility.wipedata.body'), /What stays:\*\* your warnings, bans, appeals, reports and verification checks/);
});

test('4.9 warning stage wording: no "Level" for warnings in the member DMs and the ban note', () => {
    const en = botText('en');
    assert.equal(en.t('enforcement.dm.ban.autoNote'), 'If your appeal is accepted, the warning that led to this ban is removed too.');
    for (const lang of LANG_CODES) assert.ok(!botText(lang).has('enforcement.dm.warn.limit'), `${lang}: old threat line removed`);
});

test('report and reminder replies: what happens next; "⏰ Reminder you set <t:X:R>: …" in every language', () => {
    assert.match(botText('en').t('utility.report.submitted', { tag: 'x' }), /They'll look into it/);
    assert.equal(botText('en').t('utility.report.submittedTitle'), 'Report sent');
    const row = { created_at: new Date(1000 * 1000), text: 'drink {water}' };
    assert.equal(reminderMessage(row), '⏰ Reminder you set <t:1000:R>: drink {water}');
    for (const lang of LANG_CODES) {
        const msg = reminderMessage(row, lang);
        assert.ok(msg.startsWith('⏰ ') && msg.includes('<t:1000:R>') && msg.endsWith('drink {water}'), `${lang}: ${msg}`);
    }
});
