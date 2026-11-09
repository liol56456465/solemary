// Wave 3 moderator side (audit 3.8–3.10): /purge preview → confirm/cancel/expiry with skipped
// counts; /lock duration (stored, auto-unlock after a restart) and role allows restored exactly;
// modmail pinned reminder and ✅/❌; Moderator role in /help and the dashboard (Remove warn outside
// Mewvo's own servers); the unclaimed-ticket rating notice; the Muted role gaps. Discord and the
// database are faked; nothing leaves the process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import purge from '../src/commands/Moderation/purge.js';
import lock from '../src/commands/Moderation/lock.js';
import unlock from '../src/commands/Moderation/unlock.js';
import { handlePurgeButton } from '../src/interactions/buttons/moderation/purge.js';
import { createPurgePreviewStore, splitByAge } from '../src/services/moderation/purgePreview.js';
import {
    createMemoryLockStore, createDbLockStore, lockChannelWithState, unlockChannelWithState, planLock, runChannelLockExpiry, lockKey,
} from '../src/services/moderation/channelLock.js';
import { postStaffReminder, handleModmailStaffMessage } from '../src/services/modmailService.js';
import { helpViewFor, MODERATOR_HELP_COMMANDS } from '../src/commands/Core/help.js';
import { visibleEntries } from '../src/handlers/help/helpSelectMenus.js';
import { mayRun, moderatorActionTypes, MODERATOR } from '../src/services/dashboard/permissions.js';
import { ratingCountsForCloser, closedReplyText } from '../src/services/ticket.js';
import { mutedRoleGaps, mutedRoleGapNotes } from '../src/services/enforcement/muteService.js';
import { LANG_CODES, botText } from '../src/utils/botText.js';

const GUILD = '400000000000000004';
const CHANNEL = '500000000000000001';
const MOD = '200000000000000001';
const OTHER = '200000000000000002';
const ROLE_VIP = '600000000000000001';
const ROLE_STAFF = '600000000000000002';
const ROLE_PLAIN = '600000000000000003';
const DAY = 86_400_000;
const SEND = PermissionFlagsBits.SendMessages;
const en = botText('en');

// ── fakes ─────────────────────────────────────────────────────────────────

function bits(list = []) {
    return { has: (bit) => list.includes(bit), any: (want) => want.some((b) => list.includes(b)) };
}

/** A guild + text channel whose overwrites hold Send Messages true/false/null per id. */
function makeGuild({ overwrites = {}, failOn = null } = {}) {
    const guild = { id: GUILD, name: 'Test' };
    const state = new Map(Object.entries({ [GUILD]: null, ...overwrites }));
    const edits = [];
    const asOverwrite = (id) => {
        if (!state.has(id)) return undefined;
        const v = state.get(id);
        return { id, type: 0, allow: { has: (b) => b === SEND && v === true }, deny: { has: (b) => b === SEND && v === false } };
    };
    const channel = {
        id: CHANNEL, name: 'general', guild, guildId: GUILD, toString: () => `<#${CHANNEL}>`, parent: null, sent: [],
        permissionOverwrites: {
            cache: { get: (id) => asOverwrite(id), values: () => [...state.keys()].map(asOverwrite)[Symbol.iterator]() },
            edit: async (id, patch) => {
                if (failOn && id === failOn) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
                edits.push({ id, value: patch.SendMessages });
                state.set(id, patch.SendMessages);
            },
        },
        permissionsFor: () => ({ has: (b) => !(b === SEND && state.get(GUILD) === false) }),
        async send(payload) { channel.sent.push(payload); return { id: 'm', ...payload }; },
    };
    guild.roles = { cache: new Map([
        [GUILD, { id: GUILD, name: '@everyone', permissions: bits() }],
        [ROLE_VIP, { id: ROLE_VIP, name: 'VIP', managed: false, permissions: bits() }],
        [ROLE_PLAIN, { id: ROLE_PLAIN, name: 'Plain', managed: false, permissions: bits() }],
        [ROLE_STAFF, { id: ROLE_STAFF, name: 'Mods', managed: false, permissions: bits([PermissionFlagsBits.ManageMessages]) }],
    ]) };
    guild.channels = { cache: new Map([[CHANNEL, channel]]), fetch: async () => null };
    guild.members = { me: { permissionsIn: () => ({ has: () => true }) } };
    guild.client = { user: { id: '300000000000000003' } };
    return { guild, channel, state, edits };
}

function fakeInteraction({ guild, channel, userId = MOD, amount = null, duration = null } = {}) {
    const replies = [];
    const followUps = [];
    const interaction = {
        id: '1', deferred: true, replied: false, createdTimestamp: Date.now(), guildId: guild.id, guild, channel, channelId: channel.id,
        locale: 'en-US', user: { id: userId, tag: 'mod#0', username: 'mod' }, client: guild.client,
        options: { getInteger: () => amount, getString: (name) => (name === 'duration' ? duration : null) },
        isRepliable: () => true,
        async editReply(payload) { replies.push(payload); return {}; },
        async followUp(payload) { followUps.push(payload); return {}; },
        async reply(payload) { replies.push({ reply: true, ...payload }); return {}; },
        async deferUpdate() { interaction.updated = true; },
    };
    return { interaction, replies, followUps };
}

const textOf = (payload) => [payload?.content, ...(payload?.embeds || []).map((e) => (e.data || e).description)].filter(Boolean).join('\n');

// ── /purge ────────────────────────────────────────────────────────────────

function purgeChannel(now) {
    const { guild, channel } = makeGuild();
    const msg = (n, age) => ({ id: `80000000000000000${n}`, createdTimestamp: now - age });
    channel.recent = [msg(1, 1000), msg(2, 2000), msg(3, 3000), msg(4, 20 * DAY), msg(5, 30 * DAY)];
    channel.deleted = [];
    channel.messages = {
        fetch: async ({ limit }) => new Map(channel.recent.slice(0, limit).map((m) => [m.id, m])),
        delete: async (id) => { channel.deleted.push(id); },
    };
    channel.bulkDelete = async (ids) => { channel.deleted.push(...ids); return new Map(ids.map((id) => [id, id])); };
    return { guild, channel };
}

test('splitByAge: Discord bulk-deletes only messages under 14 days old', () => {
    const now = Date.now();
    const { fresh, old } = splitByAge([{ id: '1', createdTimestamp: now - 13 * DAY }, { id: '2', createdTimestamp: now - 15 * DAY }], now);
    assert.deepEqual(fresh.map((m) => m.id), ['1']);
    assert.deepEqual(old.map((m) => m.id), ['2']);
});

test('/purge: a preview with the count, the 14-day note and Delete/Cancel; nothing deleted yet', async () => {
    const now = Date.now();
    const { guild, channel } = purgeChannel(now);
    const previews = createPurgePreviewStore({ nonce: () => 'n1' });
    const { interaction, replies } = fakeInteraction({ guild, channel, amount: 5 });
    await purge.execute(interaction, {}, guild.client, { previews, now });
    assert.equal(channel.deleted.length, 0, 'the command itself deletes nothing');
    const text = textOf(replies.at(-1));
    assert.match(text, /Delete 3 messages from the last 14 days in <#500000000000000001>\?/);
    assert.match(text, /2 messages are older than 14 days and will be skipped/);
    assert.match(text, /Messages older than 14 days can't be bulk-deleted by Discord/);
    const ids = replies.at(-1).components[0].components.map((b) => (b.data || b).custom_id);
    assert.deepEqual(ids, ['purge:confirm:n1', 'purge:cancel:n1']);
    assert.deepEqual(replies.at(-1).allowedMentions, { parse: [] });
});

test('/purge confirm: deletes exactly the previewed messages, says how many were skipped and why, logs in the server language', async () => {
    const now = Date.now();
    const { guild, channel } = purgeChannel(now);
    const previews = createPurgePreviewStore({ nonce: () => 'n2' });
    const cmd = fakeInteraction({ guild, channel, amount: 5 });
    await purge.execute(cmd.interaction, {}, guild.client, { previews, now });
    channel.recent.unshift({ id: '800000000000000009', createdTimestamp: now }); // posted after the preview
    const click = fakeInteraction({ guild, channel });
    const logs = [];
    await handlePurgeButton(click.interaction, guild.client, ['confirm', 'n2'], { previews, isAdmin: () => true, log: async (e) => logs.push(e), now });
    assert.ok(click.interaction.updated, 'acknowledged first (deferUpdate)');
    assert.deepEqual(channel.deleted.sort(), ['800000000000000001', '800000000000000002', '800000000000000003']);
    const text = textOf(click.replies.at(-1));
    assert.match(text, /Deleted 3 messages/);
    assert.match(text, /Skipped 2: older than 14 days/);
    assert.deepEqual(click.replies.at(-1).components, []);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event.metadata.skippedOld, 2);
    assert.match(logs[0].event.reason, /Deleted 3 messages/);
    // A second click finds the preview gone.
    const again = fakeInteraction({ guild, channel });
    await handlePurgeButton(again.interaction, guild.client, ['confirm', 'n2'], { previews, isAdmin: () => true, log: async () => {}, now });
    assert.match(textOf(again.replies.at(-1)), /This preview expired/);
    assert.equal(channel.deleted.length, 3);
});

test('/purge cancel, expiry, another user, lost Administrator: nothing is deleted', async () => {
    const now = Date.now();
    const { guild, channel } = purgeChannel(now);
    let n = 0;
    const previews = createPurgePreviewStore({ nonce: () => `p${++n}`, ttlMs: 1000 });
    const open = async () => { const c = fakeInteraction({ guild, channel, amount: 3 }); await purge.execute(c.interaction, {}, guild.client, { previews, now }); return `p${n}`; };
    const click = async (args, opts = {}) => {
        const c = fakeInteraction({ guild, channel, userId: opts.userId || MOD });
        await handlePurgeButton(c.interaction, guild.client, args, { previews, isAdmin: () => opts.admin !== false, log: async () => {}, now: opts.now ?? now });
        return c;
    };
    let nonce = await open();
    assert.match(textOf((await click(['cancel', nonce])).replies.at(-1)), /Cancelled. Nothing was deleted/);
    nonce = await open();
    assert.match(textOf((await click(['confirm', nonce], { now: now + 5000 })).replies.at(-1)), /This preview expired. Run \/purge again/);
    nonce = await open();
    const stranger = await click(['confirm', nonce], { userId: OTHER });
    assert.ok(stranger.replies.at(-1).reply && /Only the moderator who ran \/purge/.test(stranger.replies.at(-1).content));
    assert.ok(!stranger.interaction.updated, 'the preview stays for its moderator');
    const noAdmin = await click(['confirm', nonce], { admin: false });
    assert.match(textOf(noAdmin.replies.at(-1)), /Administrator/);
    assert.equal(channel.deleted.length, 0);
});

test('/purge: only old messages → a clear refusal, no preview', async () => {
    const now = Date.now();
    const { guild, channel } = purgeChannel(now);
    channel.recent = channel.recent.slice(3);
    const previews = createPurgePreviewStore();
    const { interaction, replies } = fakeInteraction({ guild, channel, amount: 2 });
    await purge.execute(interaction, {}, guild.client, { previews, now });
    assert.match(textOf(replies.at(-1)), /All 2 messages are older than 14 days/);
    assert.equal(previews.entries.size, 0);
});

// ── /lock ─────────────────────────────────────────────────────────────────

test('lock plan: @everyone plus roles with their own allow; staff roles keep theirs', () => {
    const { guild, channel } = makeGuild({ overwrites: { [ROLE_VIP]: true, [ROLE_STAFF]: true, [ROLE_PLAIN]: null } });
    const plan = planLock(guild, channel);
    assert.deepEqual(plan.changes.map((c) => [c.id, c.prev]), [[GUILD, null], [ROLE_VIP, true]]);
    assert.deepEqual(plan.kept, [ROLE_STAFF]);
});

test('lock → unlock restores exactly what was changed (and leaves a hand-changed overwrite alone)', async () => {
    const { guild, channel, state } = makeGuild({ overwrites: { [GUILD]: true, [ROLE_VIP]: true, [ROLE_PLAIN]: true, [ROLE_STAFF]: true } });
    const store = createMemoryLockStore();
    const result = await lockChannelWithState({ guild, channel, moderatorId: MOD, auditReason: 'test', store });
    assert.deepEqual(result.changed.sort(), [ROLE_PLAIN, ROLE_VIP].sort());
    assert.equal(state.get(GUILD), false);
    assert.equal(state.get(ROLE_VIP), false);
    assert.equal(state.get(ROLE_STAFF), true, 'staff keep their allow');
    assert.ok(store.rows.has(lockKey(GUILD, CHANNEL)));
    state.set(ROLE_PLAIN, null); // someone changed it by hand meanwhile
    const unlocked = await unlockChannelWithState({ guild, channel, auditReason: 'test', store });
    assert.equal(state.get(GUILD), true, '@everyone back to its own allow, not just cleared');
    assert.equal(state.get(ROLE_VIP), true);
    assert.equal(state.get(ROLE_PLAIN), null, 'left as the person set it');
    assert.deepEqual(unlocked.skipped, [ROLE_PLAIN]);
    assert.equal(store.rows.size, 0);
});

test('lock: the record is written before Discord; a database error changes nothing; a Discord refusal is undone', async () => {
    const down = { get: async () => { throw new Error('down'); }, save: async () => {}, remove: async () => {}, due: async () => [] };
    const a = makeGuild({ overwrites: { [ROLE_VIP]: true } });
    await assert.rejects(lockChannelWithState({ guild: a.guild, channel: a.channel, moderatorId: MOD, store: down }), (e) => e.code === 'dbDown');
    assert.equal(a.edits.length, 0);
    const b = makeGuild({ overwrites: { [ROLE_VIP]: true }, failOn: ROLE_VIP });
    const store = createMemoryLockStore();
    await assert.rejects(lockChannelWithState({ guild: b.guild, channel: b.channel, moderatorId: MOD, store }), (e) => e.code === 'partial');
    assert.equal(b.state.get(GUILD), null, '@everyone deny undone');
    assert.equal(store.rows.size, 0);
});

test('lock duration: stored unlock time survives a restart; the expiry job unlocks, posts a notice, logs', async () => {
    const now = Date.now();
    const { guild, channel, state } = makeGuild({ overwrites: { [ROLE_VIP]: true } });
    const store = createMemoryLockStore();
    const result = await lockChannelWithState({ guild, channel, moderatorId: MOD, durationMs: 2 * 3_600_000, store, now });
    assert.equal(result.unlockAt, new Date(now + 2 * 3_600_000).toISOString());
    // "Restart": a new store over the same rows (the database), a fresh client.
    const restarted = createMemoryLockStore([...store.rows.values()]);
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } };
    const notices = [];
    assert.equal(await runChannelLockExpiry(client, { store: restarted, onUnlocked: (g, c, r) => notices.push(r), now: now + 3_600_000 }), 0, 'not due yet');
    assert.equal(state.get(GUILD), false);
    assert.equal(await runChannelLockExpiry(client, { store: restarted, onUnlocked: (g, c, r) => notices.push(r), now: now + 2 * 3_600_000 + 1 }), 1);
    assert.equal(state.get(GUILD), null);
    assert.equal(state.get(ROLE_VIP), true);
    assert.equal(restarted.rows.size, 0);
    assert.deepEqual(notices[0].restored.sort(), [GUILD, ROLE_VIP].sort());
});

test('expiry: a channel that is gone drops its record; a failing unlock is retried later, then given up', async () => {
    const now = Date.now();
    const record = { guildId: GUILD, channelId: '599999999999999999', unlockAt: new Date(now - 1).toISOString(), changes: [{ id: GUILD, prev: null }], attempts: 0 };
    const { guild, channel } = makeGuild({ overwrites: { [GUILD]: false }, failOn: GUILD });
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } };
    const store = createMemoryLockStore([record, { ...record, channelId: CHANNEL }]);
    await runChannelLockExpiry(client, { store, now });
    assert.ok(!store.rows.has(lockKey(GUILD, '599999999999999999')));
    const kept = store.rows.get(lockKey(GUILD, CHANNEL));
    assert.equal(kept.attempts, 1);
    assert.ok(new Date(kept.unlockAt).getTime() > now, 'next try later');
    for (let i = 0; i < 5; i++) await runChannelLockExpiry(client, { store, now: now + (i + 1) * 3_600_000 });
    assert.equal(store.rows.size, 0, 'given up after 5 tries');
    assert.ok(channel);
});

test('expiry: a temporary fetch error or an unavailable server keeps the record (only Unknown Channel drops it)', async () => {
    const now = Date.now();
    const record = { guildId: GUILD, channelId: '599999999999999998', unlockAt: new Date(now - 1).toISOString(), changes: [{ id: GUILD, prev: null }], attempts: 0 };
    const { guild } = makeGuild();
    guild.channels.fetch = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } };
    const store = createMemoryLockStore([record]);
    await runChannelLockExpiry(client, { store, now });
    assert.equal(store.rows.get(lockKey(GUILD, record.channelId)).attempts, 1, 'retried, not dropped');
    guild.channels.fetch = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); };
    await runChannelLockExpiry(client, { store, now: now + 3_600_000 });
    assert.equal(store.rows.size, 0, 'Unknown Channel drops it');
    guild.available = false;
    const kept = createMemoryLockStore([record]);
    await runChannelLockExpiry(client, { store: kept, now });
    assert.equal(kept.rows.get(lockKey(GUILD, record.channelId)).attempts, 0, 'outage: untouched');
});

test('unlock: a failed record delete after Discord was unlocked is not a failure; a half unlock says so', async () => {
    const a = makeGuild({ overwrites: { [ROLE_VIP]: true } });
    const store = createMemoryLockStore();
    await lockChannelWithState({ guild: a.guild, channel: a.channel, moderatorId: MOD, store });
    const flaky = { ...store, remove: async () => { throw new Error('db down'); } };
    const result = await unlockChannelWithState({ guild: a.guild, channel: a.channel, store: flaky });
    assert.equal(result.recordKept, true);
    assert.equal(a.state.get(GUILD), null);
    const b = makeGuild({ overwrites: { [ROLE_VIP]: true } });
    const store2 = createMemoryLockStore();
    await lockChannelWithState({ guild: b.guild, channel: b.channel, moderatorId: MOD, store: store2 });
    const realEdit = b.channel.permissionOverwrites.edit;
    b.channel.permissionOverwrites.edit = async (id, patch) => {
        if (id === ROLE_VIP) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        return realEdit(id, patch);
    };
    await assert.rejects(unlockChannelWithState({ guild: b.guild, channel: b.channel, store: store2 }), (e) => e.code === 'partialUnlock' && e.params.done === 1 && e.params.total === 2);
    assert.ok(store2.rows.size === 1, 'record kept for a second try');
    assert.match(en.t('moderation.unlock.partial', { done: 1, total: 2, channel: '<#1>' }), /1 of 2 permissions restored/);
});

test('db lock store: upsert into temp_data, due query, delete', async () => {
    const calls = [];
    const store = createDbLockStore({ table: 'temp_data', query: async (text, params) => { calls.push({ text, params }); return { rows: [] }; } });
    await store.save({ guildId: GUILD, channelId: CHANNEL, unlockAt: '2026-11-10T00:00:00.000Z', changes: [] });
    await store.due(new Date(), 10);
    await store.remove(GUILD, CHANNEL);
    assert.match(calls[0].text, /INSERT INTO temp_data .* ON CONFLICT \(key\) DO UPDATE/s);
    assert.equal(calls[0].params[0], `channel_lock:${GUILD}:${CHANNEL}`);
    assert.match(calls[1].text, /key LIKE 'channel_lock:%'/);
    assert.match(calls[2].text, /DELETE FROM temp_data WHERE key = \$1/);
});

test('/lock duration: bad input refused (translated), good input shows the end time and tells the moderator about roles', async () => {
    const { guild, channel } = makeGuild({ overwrites: { [ROLE_VIP]: true, [ROLE_STAFF]: true } });
    const store = createMemoryLockStore();
    const bad = fakeInteraction({ guild, channel, duration: '45d' });
    await lock.execute(bad.interaction, {}, guild.client, { lockStore: store, log: async () => {} });
    assert.match(textOf(bad.replies.at(-1)), /That duration isn't valid/);
    assert.equal(store.rows.size, 0);
    const ok = fakeInteraction({ guild, channel, duration: '2h' });
    await lock.execute(ok.interaction, {}, guild.client, { lockStore: store, log: async () => {} });
    assert.match(textOf(ok.replies.at(-1)), /is locked until <t:\d+:F> \(<t:\d+:R>\)/);
    assert.match(ok.followUps[0].content, /Also locked for 1 role .*<@&600000000000000001>/);
    assert.match(ok.followUps[0].content, /Not locked for 1 staff role .*<@&600000000000000002>/);
    assert.deepEqual(ok.followUps[0].allowedMentions, { parse: [] });
    const again = fakeInteraction({ guild, channel });
    await lock.execute(again.interaction, {}, guild.client, { lockStore: store, log: async () => {} });
    assert.match(textOf(again.replies.at(-1)), /already locked/);
    const open = fakeInteraction({ guild, channel });
    await unlock.execute(open.interaction, {}, guild.client, { lockStore: store, log: async () => {} });
    assert.match(textOf(open.replies.at(-1)), /is unlocked/);
    assert.equal(store.rows.size, 0);
});

// ── Modmail ───────────────────────────────────────────────────────────────

test('modmail: the reminder is posted without pings and pinned; a pin refusal is tolerated', async () => {
    const sent = [];
    let pinned = false;
    const channel = { id: '1', send: async (p) => { sent.push(p); return { pin: async () => { pinned = true; } }; } };
    await postStaffReminder(channel, en);
    assert.equal(sent[0].content, 'Messages here go to the member. Start with `//` for a staff-only note.');
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    assert.ok(pinned);
    const noPin = { id: '2', send: async () => ({ pin: async () => { throw new Error('Missing Permissions'); } }) };
    assert.ok(await postStaffReminder(noPin, en));
});

test('modmail staff message: ✅ when relayed, ❌ + short reply when the DM fails, notes (//) not relayed', async () => {
    const make = (content, dmFails = false) => {
        const reactions = [];
        const replies = [];
        const dms = [];
        const message = {
            content, guildId: GUILD, attachments: new Map(), author: { username: 'mod' }, member: { displayName: 'Mod' }, channel: { id: 'c' },
            client: { users: { fetch: async () => ({ send: async (p) => { if (dmFails) throw new Error('Cannot send'); dms.push(p); } }) } },
            react: async (e) => { reactions.push(e); }, reply: async (p) => { replies.push(p); },
        };
        return { message, reactions, replies, dms };
    };
    const userIdOf = async () => '700000000000000001';
    const ok = make('hello');
    assert.equal(await handleModmailStaffMessage(ok.message, '!', { userIdOf }), true);
    assert.deepEqual(ok.reactions, ['✅']);
    assert.deepEqual(ok.dms[0].allowedMentions, { parse: [] });
    const fail = make('hello', true);
    await handleModmailStaffMessage(fail.message, '!', { userIdOf });
    assert.deepEqual(fail.reactions, ['❌']);
    assert.equal(fail.replies.length, 1);
    assert.deepEqual(fail.replies[0].allowedMentions, { parse: [] });
    const note = make('// internal');
    await handleModmailStaffMessage(note.message, '!', { userIdOf });
    assert.equal(note.dms.length + note.reactions.length, 0);
});

// ── Moderator role: /help and the dashboard ───────────────────────────────

test('/help: the Moderator role outside Mewvo\'s own servers sees /enforcements; members and home servers do not', async () => {
    const interaction = { guildId: '900000000000000009', member: { id: OTHER } };
    const modAccess = async () => ({ level: 'moderator' });
    const view = await helpViewFor(interaction, null, { canSeeAdmin: () => false, isHome: () => false, access: modAccess });
    assert.ok(view instanceof Set && view.has('enforcements'));
    assert.deepEqual([...view], [...MODERATOR_HELP_COMMANDS]);
    assert.equal(await helpViewFor(interaction, null, { canSeeAdmin: () => false, isHome: () => true, access: modAccess }), false);
    assert.equal(await helpViewFor(interaction, null, { canSeeAdmin: () => false, isHome: () => false, access: async () => ({ level: null }) }), false);
    assert.equal(await helpViewFor(interaction, null, { canSeeAdmin: () => false, isHome: () => false, access: async () => { throw new Error('slow'); } }), false);
    assert.equal(await helpViewFor(interaction, null, { canSeeAdmin: () => true }), true);
    const entries = [{ baseName: 'enforcements', displayName: 'enforcements user' }, { baseName: 'ban', displayName: 'ban' }, { baseName: 'help', displayName: 'help' }];
    assert.deepEqual(visibleEntries(entries, view).map((e) => e.baseName), ['enforcements', 'help'], 'everyone commands + /enforcements, never /ban');
    assert.deepEqual(visibleEntries(entries, false).map((e) => e.baseName), ['help']);
    assert.deepEqual(visibleEntries(entries, true).length, 3);
});

test('dashboard: Remove warn for the Moderator level only outside Mewvo\'s own servers', () => {
    const moderator = { allowed: true, role: MODERATOR, canAct: false };
    assert.equal(mayRun(moderator, 'action:removewarn'), false, 'default (home) unchanged');
    assert.equal(mayRun(moderator, 'action:removewarn', { home: true }), false);
    assert.equal(mayRun(moderator, 'action:removewarn', { home: false }), true);
    assert.equal(mayRun(moderator, 'action:ban', { home: false }), false);
    assert.equal(mayRun(moderator, 'action:unban', { home: false }), false);
    assert.ok(!moderatorActionTypes().includes('removewarn'));
    assert.deepEqual(moderatorActionTypes({ home: false }).sort(), ['kick', 'mute', 'removewarn', 'unmute', 'warn']);
    assert.equal(mayRun({ allowed: true, role: 'manager', canAct: false }, 'action:removewarn', { home: false }), false);
});

// ── Tickets ───────────────────────────────────────────────────────────────

test('ticket close: unclaimed → the closer is told the rating counts for them; never for claimed tickets or the opener', () => {
    const opener = '710000000000000001';
    assert.equal(ratingCountsForCloser({ userId: opener, claimedBy: null }, MOD, true), true);
    assert.equal(ratingCountsForCloser({ userId: opener, claimedBy: OTHER }, MOD, true), false);
    assert.equal(ratingCountsForCloser({ userId: opener, claimedBy: null }, opener, true), false);
    assert.equal(ratingCountsForCloser({ userId: opener, claimedBy: null }, MOD, false), false, 'no survey, no note');
    const closed = Object.defineProperty({}, 'ratingCountsForCloser', { value: true });
    assert.equal(closedReplyText(en, closed), "This ticket is closed.\nNobody claimed this ticket, so the member's rating will count for you.");
    assert.equal(closedReplyText(en, {}), 'This ticket is closed.');
    assert.ok(!Object.keys(closed).includes('ratingCountsForCloser'), 'not saved with the ticket');
});

// ── Muted role ────────────────────────────────────────────────────────────

test('muted role gaps: a role allow on a channel beats the deny (whatever the role order); Administrator is never muted', () => {
    const MUTED = '600000000000000099';
    const ch = (id, name, ows) => ({ id, name, type: 0, permissionOverwrites: { cache: new Map(Object.entries(ows).map(([k, v]) => [k, { allow: bits(v.allow || []), deny: bits(v.deny || []) }])) }, permissionsFor: () => bits([PermissionFlagsBits.ViewChannel]) });
    const guild = { id: GUILD, channels: { cache: new Map([
        ['1', ch('1', 'vip-chat', { [ROLE_VIP]: { allow: [SEND] }, [MUTED]: { deny: [SEND] } })],
        ['2', ch('2', 'general', { [MUTED]: { deny: [SEND] } })],
        ['3', ch('3', 'own-deny', { [ROLE_VIP]: { allow: [SEND] }, '710000000000000001': { deny: [SEND] } })],
    ]) } };
    const member = { id: '710000000000000001', permissions: bits(), roles: { cache: new Map([[ROLE_VIP, {}], [MUTED, {}]]) } };
    const gaps = mutedRoleGaps(guild, member, MUTED);
    assert.deepEqual(gaps.channels.map((c) => c.name), ['vip-chat']);
    assert.match(mutedRoleGapNotes(en, gaps, 'sam')[0], /sam can still talk in 1 channel: #vip-chat/);
    const admin = mutedRoleGaps(guild, { ...member, permissions: bits([PermissionFlagsBits.Administrator]) }, MUTED);
    assert.ok(admin.admin);
    assert.match(mutedRoleGapNotes(en, admin, 'sam')[0], /Administrator/);
    assert.deepEqual(mutedRoleGapNotes(en, { admin: false, channels: [] }, 'sam'), []);
});

// ── i18n ──────────────────────────────────────────────────────────────────

test('new moderator texts exist in all 8 languages and keep their placeholders', () => {
    const keys = [
        ['moderation.purge.preview', 3, ['<#1>']], ['moderation.purge.previewOld', 2, []], ['moderation.purge.skippedOld', 5, []],
        ['moderation.purge.allTooOld', 21, []], ['moderation.lock.rolesLocked', 2, ['<@&9>']], ['moderation.unlock.skipped', 4, []],
        ['staff.enfCheck.note.muteLeak', 3, ['#a']],
    ];
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const [key, n, must] of keys) {
            const text = tr.tp(key, n, { channel: '<#1>', roles: '<@&9>', name: 'sam', channels: '#a' });
            assert.ok(text.includes(String(n)) && must.every((m) => text.includes(m)), `${lang} ${key}: ${text}`);
        }
        for (const key of ['moderation.purge.previewNote', 'moderation.lock.badDuration', 'moderation.unlock.autoDone', 'staff.modmail.reminder',
            'ticket.reply.ratingCountsForYou', 'core.help.menu.accessModerator', 'staff.enfCheck.note.warnUncounted', 'moderation.lock.cmd.duration']) {
            assert.notEqual(tr.t(key, { channel: '<#1>' }), key, `${lang} ${key}`);
        }
        assert.ok(tr.t('moderation.lock.cmd.duration').length <= 100, `${lang}: option description fits Discord`);
    }
});
