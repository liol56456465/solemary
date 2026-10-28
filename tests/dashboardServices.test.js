// Shared write services used by commands and the web dashboard: validation and
// locked read-modify-writes, with fake stores (no database, no Discord).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db as dbWrapper } from '../src/utils/database/wrapper.js';
import {
    getAutomodSettings, getTrustedRoleProblem, setChannelRuleMode, setExemptChannel, setJoinGateCheck,
    setPanic, setRuleMode, setTrusted,
} from '../src/services/automod/automodSettings.js';
import { setLogChannel, setLoggingEnabled, toggleEventLogging } from '../src/services/loggingService.js';
import { disableCategory, disableCommand, enableCommand } from '../src/services/commandAccessService.js';
import { setModmailBlocked } from '../src/services/modmailService.js';
import { addPanelRole, getPanelRoleProblem, removePanelRole } from '../src/services/reactionRoleService.js';
import { endGiveawayNow, rerollGiveaway } from '../src/services/giveawayService.js';
import { giveawayKey } from '../src/utils/giveaways.js';
import { getGuildConfigKey, getReactionRoleKey } from '../src/utils/database/keys.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

/**
 * A key-value store whose update() serializes per key like the Postgres row lock,
 * with a pause between read and write so unlocked writers would interleave.
 */
function fakeStore(initial = {}) {
    const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
    const chains = new Map();
    const store = {
        data,
        updates: 0,
        async get(key, fallback = null) {
            return data.has(key) ? structuredClone(data.get(key)) : fallback;
        },
        async set(key, value) {
            data.set(key, structuredClone(value));
            return true;
        },
        async delete(key) {
            return data.delete(key);
        },
        async update(key, mutator, defaultValue = null) {
            const run = async () => {
                store.updates += 1;
                const current = data.has(key) ? structuredClone(data.get(key)) : structuredClone(defaultValue);
                await tick();
                const next = await mutator(current);
                await tick();
                data.set(key, structuredClone(next));
                return next;
            };
            const prev = chains.get(key) || Promise.resolve();
            const result = prev.catch(() => {}).then(run);
            chains.set(key, result.catch(() => {}));
            return result;
        },
    };
    return store;
}

let guildCounter = 0;
const nextGuildId = () => `3000000000000000${String(++guildCounter).padStart(2, '0')}`;

function useAutomodStore() {
    const store = fakeStore();
    dbWrapper.db = store;
    return store;
}

// ── automod ───────────────────────────────────────────────────────────────────

test('setExemptChannel toggles inside the lock: concurrent toggles cancel out', async () => {
    useAutomodStore();
    const guildId = nextGuildId();
    const channelId = '400000000000000001';
    const [first, second] = await Promise.all([
        setExemptChannel(guildId, channelId, 'toggle'),
        setExemptChannel(guildId, channelId, 'toggle'),
    ]);
    assert.equal(first.exempt, true);
    assert.equal(second.exempt, false);
    assert.deepEqual(second.settings.exemptChannelIds, []);

    const added = await setExemptChannel(guildId, channelId, true);
    assert.equal(added.exempt, true);
    assert.deepEqual(added.settings.exemptChannelIds, [channelId]);
    const again = await setExemptChannel(guildId, channelId, true);
    assert.deepEqual(again.settings.exemptChannelIds, [channelId]);
    const removed = await setExemptChannel(guildId, channelId, false);
    assert.deepEqual(removed.settings.exemptChannelIds, []);
});

test('setExemptChannel rejects a bad channel id or exempt value', async () => {
    useAutomodStore();
    await assert.rejects(setExemptChannel(nextGuildId(), 'abc', true), (e) => Boolean(e.userMessage));
    await assert.rejects(setExemptChannel(nextGuildId(), '400000000000000001', 'yes'), (e) => Boolean(e.userMessage));
});

test('setRuleMode validates the rule and mode, and default removes the override', async () => {
    const store = useAutomodStore();
    const guildId = nextGuildId();
    await assert.rejects(setRuleMode(guildId, 'nope', 'on'), { userMessage: 'Unknown rule.' });
    await assert.rejects(setRuleMode(guildId, 'caps', 'loud'), { userMessage: 'Unknown mode.' });
    await assert.rejects(setRuleMode(guildId, 'toString', 'on'), { userMessage: 'Unknown rule.' });
    assert.equal(store.updates, 0, 'invalid input never reaches the store');

    const saved = await setRuleMode(guildId, 'caps', 'monitor');
    assert.equal(saved.ruleModes.caps, 'monitor');
    const reset = await setRuleMode(guildId, 'caps', 'default');
    assert.equal('caps' in reset.ruleModes, false);
});

test('concurrent rule and channel edits both survive', async () => {
    useAutomodStore();
    const guildId = nextGuildId();
    const channelId = '400000000000000002';
    await Promise.all([
        setRuleMode(guildId, 'caps', 'off'),
        setChannelRuleMode(guildId, channelId, 'english', 'off'),
        setPanic(guildId, { enabled: false }),
    ]);
    const settings = await getAutomodSettings(guildId);
    assert.equal(settings.ruleModes.caps, 'off');
    assert.equal(settings.channelRules[channelId].english, 'off');
    assert.equal(settings.panic.enabled, false);
    await assert.rejects(setChannelRuleMode(guildId, channelId, 'english', 'on'), { userMessage: 'Unknown mode.' });
});

test('setTrusted keeps undefined fields, validates bounds, clear wipes both', async () => {
    useAutomodStore();
    const guildId = nextGuildId();
    await assert.rejects(setTrusted(guildId, {}), { userMessage: 'Give a role, a minimum level, or clear: true.' });
    await assert.rejects(setTrusted(guildId, { minLevel: 1001 }), (e) => Boolean(e.userMessage));
    await assert.rejects(setTrusted(guildId, { minLevel: 2.5 }), (e) => Boolean(e.userMessage));
    await assert.rejects(setTrusted(guildId, { roleId: 'x' }), (e) => Boolean(e.userMessage));

    let saved = await setTrusted(guildId, { roleId: '500000000000000001' });
    assert.deepEqual(saved.trusted, { roleId: '500000000000000001', minLevel: 0 });
    saved = await setTrusted(guildId, { minLevel: 10 });
    assert.deepEqual(saved.trusted, { roleId: '500000000000000001', minLevel: 10 });
    saved = await setTrusted(guildId, { roleId: null });
    assert.deepEqual(saved.trusted, { roleId: null, minLevel: 10 });
    saved = await setTrusted(guildId, { clear: true });
    assert.deepEqual(saved.trusted, { roleId: null, minLevel: 0 });
});

test('getTrustedRoleProblem refuses @everyone and managed roles', () => {
    const guild = { id: '600000000000000001' };
    assert.match(getTrustedRoleProblem(guild, { id: guild.id }), /not @everyone/);
    assert.match(getTrustedRoleProblem(guild, { id: '600000000000000002', managed: true }), /bot role/);
    assert.equal(getTrustedRoleProblem(guild, { id: '600000000000000002', managed: false }), null);
});

test('setJoinGateCheck and setPanic validate their bounds', async () => {
    useAutomodStore();
    const guildId = nextGuildId();
    await assert.rejects(setJoinGateCheck(guildId, 'nope', 'flag'), { userMessage: 'Unknown check.' });
    await assert.rejects(setJoinGateCheck(guildId, 'age', 'ban'), { userMessage: 'Unknown action.' });
    await assert.rejects(setJoinGateCheck(guildId, 'age', 'flag', 366), (e) => Boolean(e.userMessage));
    const saved = await setJoinGateCheck(guildId, 'age', 'kick', 30);
    assert.equal(saved.joinGate.age, 'kick');
    assert.equal(saved.joinGate.ageDays, 30);

    await assert.rejects(setPanic(guildId, { enabled: true, hours: 25 }), (e) => Boolean(e.userMessage));
    await assert.rejects(setPanic(guildId, { enabled: 'yes' }), (e) => Boolean(e.userMessage));
    let panic = await setPanic(guildId, { enabled: true, hours: 5 });
    assert.deepEqual(panic.panic, { enabled: true, hours: 5 });
    panic = await setPanic(guildId, { enabled: false });
    assert.deepEqual(panic.panic, { enabled: false, hours: 5 });
});

// ── guild config (logging, command access, modmail) ──────────────────────────

test('concurrent setLogChannel + setLoggingEnabled + toggleEventLogging all survive', async () => {
    const guildId = nextGuildId();
    const client = { db: fakeStore() };
    const results = await Promise.all([
        setLogChannel(client, guildId, 'reports', '700000000000000001'),
        setLoggingEnabled(client, guildId, true),
        toggleEventLogging(client, guildId, ['moderation.ban'], false),
    ]);
    assert.deepEqual(results, [true, true, true]);
    const config = client.db.data.get(getGuildConfigKey(guildId));
    assert.equal(config.logging.channels.reports, '700000000000000001');
    assert.equal(config.logging.enabled, true);
    assert.equal(config.logging.enabledEvents['moderation.ban'], false);
});

test('setLogChannel still throws on an unknown destination', async () => {
    await assert.rejects(setLogChannel({ db: fakeStore() }, nextGuildId(), 'nowhere', null), /Invalid log destination/);
});

function fakeCommandClient() {
    const command = (name, category) => ({
        category,
        data: { name, description: name, toJSON: () => ({ name, options: [] }) },
    });
    return {
        db: fakeStore(),
        commands: new Map([
            ['alpha', command('alpha', 'Fun')],
            ['beta', command('beta', 'Fun')],
            ['gamma', command('gamma', 'Tools')],
        ]),
    };
}

test('command access changes are atomic: concurrent edits all land', async () => {
    const guildId = nextGuildId();
    const client = fakeCommandClient();
    const results = await Promise.all([
        disableCommand(client, guildId, 'alpha'),
        disableCommand(client, guildId, 'beta'),
        disableCategory(client, guildId, 'Tools'),
    ]);
    assert.deepEqual(results[0], { commandName: 'alpha', enabled: false });
    assert.equal(results[2].categoryKey, 'tools');
    let config = client.db.data.get(getGuildConfigKey(guildId));
    assert.equal(config.disabledCommands.alpha, true);
    assert.equal(config.disabledCommands.beta, true);
    assert.equal(config.disabledCategories.tools, true);

    assert.deepEqual(await enableCommand(client, guildId, 'alpha'), { commandName: 'alpha', enabled: true });
    config = client.db.data.get(getGuildConfigKey(guildId));
    assert.equal('alpha' in config.disabledCommands, false);
    assert.equal(config.disabledCommands.beta, true);

    await assert.rejects(disableCommand(client, guildId, 'nope'), /Unknown command/);
});

test('setModmailBlocked is atomic', async () => {
    const guildId = nextGuildId();
    const client = { db: fakeStore() };
    await Promise.all([
        setModmailBlocked(client, guildId, '800000000000000001', true),
        setModmailBlocked(client, guildId, '800000000000000002', true),
    ]);
    let config = client.db.data.get(getGuildConfigKey(guildId));
    assert.deepEqual([...config.modmailBlocked].sort(), ['800000000000000001', '800000000000000002']);
    await setModmailBlocked(client, guildId, '800000000000000001', false);
    config = client.db.data.get(getGuildConfigKey(guildId));
    assert.deepEqual(config.modmailBlocked, ['800000000000000002']);
});

// ── reaction role panels ──────────────────────────────────────────────────────

const GUILD_ID = '900000000000000001';
const PANEL_ID = '900000000000000099';

function fakeRole(id, { position = 1, managed = false, dangerous = false } = {}) {
    return {
        id,
        name: `role-${id.slice(-2)}`,
        position,
        managed,
        permissions: { has: (perm) => dangerous && perm === 'Administrator' },
        toString: () => `<@&${id}>`,
    };
}

function fakeGuild(roles = []) {
    const cache = new Map(roles.map((role) => [role.id, role]));
    return {
        id: GUILD_ID,
        roles: { cache, fetch: async (id) => cache.get(id) ?? null },
        channels: { cache: new Map() },
        members: { me: { roles: { highest: { position: 10 } } } },
    };
}

test('getPanelRoleProblem matches the dashboard checks', () => {
    const guild = fakeGuild();
    const panel = { roles: ['900000000000000010'] };
    const full = { roles: Array.from({ length: 25 }, (_, i) => `9000000000000001${String(i).padStart(2, '0')}`) };

    assert.equal(getPanelRoleProblem(guild, null, full), 'This panel already has the maximum of 25 roles.');
    assert.equal(getPanelRoleProblem(guild, null, panel), null);
    assert.equal(getPanelRoleProblem(guild, fakeRole('900000000000000010'), panel), '<@&900000000000000010> is already in this panel.');
    assert.equal(getPanelRoleProblem(guild, fakeRole(GUILD_ID), panel), 'You cannot use @everyone.');
    assert.equal(getPanelRoleProblem(guild, fakeRole('900000000000000011', { managed: true }), panel), 'Managed/bot roles cannot be used.');
    assert.match(getPanelRoleProblem(guild, fakeRole('900000000000000011', { dangerous: true }), panel), /sensitive permissions/);
    assert.match(getPanelRoleProblem(guild, fakeRole('900000000000000011', { position: 10 }), panel), /above my highest role/);
    assert.equal(getPanelRoleProblem(guild, fakeRole('900000000000000011'), panel), null);
});

function panelClient(roles, panel) {
    const guild = fakeGuild(roles);
    const initial = panel ? { [getReactionRoleKey(GUILD_ID, PANEL_ID)]: panel } : {};
    return { guild, client: { db: fakeStore(initial), guilds: { cache: new Map([[GUILD_ID, guild]]) } } };
}

test('addPanelRole refuses with a userMessage and leaves the panel unchanged', async () => {
    const roles = [fakeRole('900000000000000010'), fakeRole('900000000000000011', { dangerous: true })];
    const panel = { guildId: GUILD_ID, channelId: '900000000000000050', messageId: PANEL_ID, roles: ['900000000000000010'] };
    const { client } = panelClient(roles, panel);

    await assert.rejects(addPanelRole(client, GUILD_ID, PANEL_ID, '900000000000000010'),
        { name: 'TitanBotError', userMessage: '<@&900000000000000010> is already in this panel.' });
    await assert.rejects(addPanelRole(client, GUILD_ID, PANEL_ID, '900000000000000011'), { type: 'permission' });
    assert.deepEqual(client.db.data.get(getReactionRoleKey(GUILD_ID, PANEL_ID)).roles, ['900000000000000010']);

    const missing = panelClient(roles, null).client;
    await assert.rejects(addPanelRole(missing, GUILD_ID, PANEL_ID, '900000000000000010'),
        { userMessage: 'That reaction role panel no longer exists.' });
    assert.equal(missing.db.data.size, 0, 'no empty panel row is created');
});

test('concurrent addPanelRole calls both land; removing the last role deletes the panel', async () => {
    const roles = ['900000000000000010', '900000000000000012', '900000000000000013'].map((id) => fakeRole(id));
    const panel = { guildId: GUILD_ID, channelId: '900000000000000050', messageId: PANEL_ID, roles: ['900000000000000010'] };
    const { client } = panelClient(roles, panel);
    const key = getReactionRoleKey(GUILD_ID, PANEL_ID);

    await Promise.all([
        addPanelRole(client, GUILD_ID, PANEL_ID, '900000000000000012'),
        addPanelRole(client, GUILD_ID, PANEL_ID, '900000000000000013'),
    ]);
    assert.deepEqual([...client.db.data.get(key).roles].sort(), ['900000000000000010', '900000000000000012', '900000000000000013']);

    let result = await removePanelRole(client, GUILD_ID, PANEL_ID, '900000000000000012');
    assert.equal(result.deletedPanel, false);
    assert.equal(result.panel.roles.includes('900000000000000012'), false);
    await removePanelRole(client, GUILD_ID, PANEL_ID, '900000000000000013');
    result = await removePanelRole(client, GUILD_ID, PANEL_ID, '900000000000000010');
    assert.equal(result.deletedPanel, true);
    assert.equal(client.db.data.has(key), false);
});

// ── giveaways ─────────────────────────────────────────────────────────────────

function giveawayClient(giveaway, { withChannel = true, withMessage = true } = {}) {
    const sent = [];
    const edits = [];
    const message = { edit: async (payload) => { edits.push(payload); } };
    const channel = {
        id: giveaway.channelId,
        isTextBased: () => true,
        send: async (payload) => { sent.push(payload); return { id: '990000000000000077' }; },
        messages: { fetch: async (id) => (withMessage && id === giveaway.messageId ? message : null) },
        toString: () => `<#${giveaway.channelId}>`,
    };
    const store = fakeStore({ [giveawayKey(GUILD_ID)]: { [giveaway.messageId]: giveaway } });
    return {
        sent,
        edits,
        stored: () => store.data.get(giveawayKey(GUILD_ID))[giveaway.messageId],
        client: {
            db: store,
            channels: { fetch: async () => (withChannel ? channel : null) },
            guilds: { cache: new Map(), fetch: async () => null },
        },
    };
}

const baseGiveaway = {
    messageId: '990000000000000001', channelId: '990000000000000002', hostId: '990000000000000003',
    prize: 'Cat', winnerCount: 1, participants: ['990000000000000004'],
};

test('endGiveawayNow ends, saves, edits and announces', async () => {
    const fake = giveawayClient({ ...baseGiveaway });
    const result = await endGiveawayNow(fake.client, GUILD_ID, baseGiveaway.messageId, '990000000000000005');
    assert.deepEqual(result.winners, ['990000000000000004']);
    assert.equal(result.participantCount, 1);
    assert.equal(result.channelId, baseGiveaway.channelId);
    assert.equal(result.messageFound, true);
    assert.equal(fake.stored().ended, true);
    assert.equal(fake.stored().winnerPingMessageId, '990000000000000077');
    assert.equal(fake.edits.length, 1);
    assert.equal(fake.sent.length, 1);

    await assert.rejects(endGiveawayNow(fake.client, GUILD_ID, baseGiveaway.messageId, 'x'),
        { userMessage: 'This giveaway has already ended.' });
    await assert.rejects(endGiveawayNow(fake.client, GUILD_ID, 'abc', 'x'), { userMessage: 'Please provide a valid message ID.' });
    await assert.rejects(endGiveawayNow(fake.client, GUILD_ID, '123', 'x'),
        { userMessage: 'No giveaway was found with that message ID in the database.' });
});

test('rerollGiveaway refuses an active giveaway and handles a missing message or channel', async () => {
    const active = giveawayClient({ ...baseGiveaway });
    await assert.rejects(rerollGiveaway(active.client, GUILD_ID, baseGiveaway.messageId, 'x'), { userMessage: /still active/ });

    const ended = giveawayClient({ ...baseGiveaway, ended: true, isEnded: true }, { withMessage: false });
    const result = await rerollGiveaway(ended.client, GUILD_ID, baseGiveaway.messageId, '990000000000000005');
    assert.equal(result.messageFound, false);
    assert.equal(result.channelId, baseGiveaway.channelId);
    assert.equal(ended.stored().rerolledBy, '990000000000000005');
    assert.equal(ended.stored().winnerPingMessageId, '990000000000000077');

    const noChannel = giveawayClient({ ...baseGiveaway, ended: true }, { withChannel: false });
    const lost = await rerollGiveaway(noChannel.client, GUILD_ID, baseGiveaway.messageId, '990000000000000005');
    assert.equal(lost.channelId, null);
    assert.equal(noChannel.sent.length, 0);
});
