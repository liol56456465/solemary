// Dashboard Phase 2: module settings pages and their POST handlers, with fake
// req/res, a fake guild (channels, roles, the bot's member) and fake services that
// record every call. For every POST action: no CSRF → 403, bad Origin → 403, editing
// off → 403, not allowed → 403, invalid input → 400 with the message and nothing
// called, valid input → the service is called, audit rows, one mod-log post, flash, 303.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard, dashboardSettings, SECURITY_HEADERS } from '../src/services/dashboard/routes.js';
import { createMemorySessionStore } from '../src/services/dashboard/sessionStore.js';
import { createAccessChecker } from '../src/services/dashboard/access.js';
import { SESSION_COOKIE, signValue, isSameOrigin } from '../src/services/dashboard/security.js';
import { MODULES, getAction } from '../src/services/dashboard/modules/index.js';
import { getSettingEntry, seedValue } from '../src/services/settings/settingsRegistry.js';
import { logger } from '../src/utils/logger.js';
import { channelGroups, channelWarnings, roleWarnings, switchInput } from '../src/services/dashboard/forms.js';
import { diffSnapshots, recordDashboardChange, changeSummary } from '../src/services/dashboard/audit.js';
import { channelPurposeFor } from '../src/services/automod/channelRouting.js';
import { JS_PATH, NAV, moduleItems } from '../src/services/dashboard/html.js';
import { lockChannel, purgeChannelMessages, unlockChannel } from '../src/services/channelToolsService.js';

const ALLOWED_SCRIPT = `<script src="${JS_PATH}" defer></script>`;
const SECRET = 'x'.repeat(64);
const GUILD = '100000000000000001';
const SUPPORT = '100000000000000002';
const ADMIN = '200000000000000002';
const OWNER = '200000000000000003';
const STRANGER = '300000000000000003';
const MEMBER = '300000000000000004';
const TEXT = '500000000000000001';
const TEXT2 = '500000000000000002';
const CAT = '500000000000000003';
const VOICE = '500000000000000004';
const ROLE_OK = '600000000000000001';
const ROLE_DANGER = '600000000000000002';
const ROLE_HIGH = '600000000000000003';
const ROLE_MANAGED = '600000000000000004';
const ROLE_OK2 = '600000000000000005';
const SUPPORT_ROLE = '600000000000000009';
const SUPPORT_CAT = '500000000000000099';
const PANEL = '700000000000000001';
const GA_ACTIVE = '700000000000000002';
const GA_ENDED = '700000000000000003';
const NATIVE_RULE = '700000000000000004';
const MISSING = '999999999999999999';
const ORIGIN = 'https://bot.example';

const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: `${ORIGIN}/`, MAIN_GUILD_ID: GUILD, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test',
};

// ── fake guild ────────────────────────────────────────────────────────────

function perms(names = []) {
    return { has: (p) => names.includes(p) };
}

function makeGuild() {
    const guild = { id: GUILD, name: 'Main <b>' };
    const SEND = 1n << 11n;
    const ch = (id, name, type, parentId = null) => {
        // Channel overwrites (only @everyone's Send Messages matters here) and recent messages.
        const denied = new Set();
        const channel = { id, name, type, parentId, rawPosition: 0, guild, toString: () => `<#${id}>`, edits: [], deletedIds: [] };
        channel.permissionOverwrites = {
            cache: { get: (target) => (target === GUILD && denied.has(SEND) ? { id: GUILD, deny: { has: (bit) => denied.has(bit) } } : undefined) },
            edit: async (target, patch, options) => {
                channel.edits.push({ target: target?.id || target, patch, options });
                if (patch.SendMessages === false) denied.add(SEND); else denied.delete(SEND);
            },
        };
        channel.permissionsFor = () => ({ has: (bit) => !denied.has(bit) });
        const now = Date.now();
        const msg = (n, authorId, ageMs) => ({ id: `80000000000000000${n}`, author: { id: authorId }, createdTimestamp: now - ageMs });
        channel.recent = [msg(1, MEMBER, 1000), msg(2, ADMIN, 2000), msg(3, MEMBER, 3000), msg(4, MEMBER, 20 * 86_400_000)];
        channel.messages = { fetch: async ({ limit }) => new Map(channel.recent.slice(0, limit).map((m) => [m.id, m])) };
        channel.bulkDelete = async (messages) => {
            channel.deletedIds.push(...messages.map((m) => m.id));
            channel.recent = channel.recent.filter((m) => !messages.includes(m));
            return new Map(messages.map((m) => [m.id, m]));
        };
        return channel;
    };
    guild.channels = { cache: new Map([
        [TEXT, ch(TEXT, 'general', 0, CAT)], [TEXT2, ch(TEXT2, '<script>x</script>', 0)],
        [CAT, ch(CAT, 'Support', 4)], [VOICE, ch(VOICE, 'Join to create', 2, CAT)],
    ]) };
    const role = (id, name, position, permissionNames = [], managed = false) => ({ id, name, position, managed, permissions: perms(permissionNames), guild });
    guild.roles = { cache: new Map([
        [GUILD, role(GUILD, '@everyone', 0)], [ROLE_OK, role(ROLE_OK, 'Member', 1)], [ROLE_OK2, role(ROLE_OK2, 'Helper', 2)],
        [ROLE_DANGER, role(ROLE_DANGER, 'Mods', 3, ['Administrator'])], [ROLE_HIGH, role(ROLE_HIGH, 'Owner', 50)],
        [ROLE_MANAGED, role(ROLE_MANAGED, 'Bot role', 4, [], true)],
    ]) };
    guild.members = {
        me: { permissionsIn: () => ({ has: () => true }), roles: { highest: { position: 10 } }, permissions: { has: () => true } },
        fetch: async (id) => (id === MEMBER ? { user: { username: 'member' } } : null),
    };
    const nativeRule = { id: NATIVE_RULE, name: 'Block words' };
    guild.autoModerationRules = { fetch: async (id) => (id ? (id === NATIVE_RULE ? nativeRule : null) : new Map([[NATIVE_RULE, nativeRule]])) };
    return guild;
}

function makeSupportGuild() {
    const guild = { id: SUPPORT, name: 'Support' };
    guild.roles = { cache: new Map([[SUPPORT, { id: SUPPORT, name: '@everyone', position: 0, guild }], [SUPPORT_ROLE, { id: SUPPORT_ROLE, name: 'Banned', position: 1, managed: false, permissions: perms(), guild }]]) };
    guild.channels = { cache: new Map([[SUPPORT_CAT, { id: SUPPORT_CAT, name: 'Appeals', type: 4, parentId: null, rawPosition: 0, guild }]]) };
    guild.members = { me: { permissionsIn: () => ({ has: () => true }), roles: { highest: { position: 10 } }, permissions: { has: () => true } } };
    return guild;
}

// ── fake services (record every call; stateful enough for before/after) ─────

function makeServices() {
    const calls = [];
    const auditRows = [];
    const record = (name, args) => calls.push({ name, args });
    const s = {
        registry: {},
        logEvents: [],
        automod: { enabled: true, mode: 'enforce', ruleModes: {}, channelRules: {}, exemptChannelIds: [TEXT2], trusted: { roleId: null, minLevel: 0 }, secondChance: true, moodAlerts: true, panic: { enabled: true, hours: 2 }, joinGate: {} },
        native: new Map(),
        logging: { enabled: false, channels: { audit: null, applications: null, reports: null }, ignore: { channels: [TEXT2], roles: [], users: [] }, enabledEvents: {} },
        welcome: { enabled: false, channelId: null, welcomeMessage: 'Welcome {user}', welcomePing: false, dmMessage: '', goodbyeEnabled: false, goodbyeChannelId: null, leaveMessage: 'Bye', goodbyePing: false, roleIds: [ROLE_OK], autoRoleDelay: 0, joinLogs: { enabled: false, channelId: null }, leaveLogs: { enabled: false, channelId: null } },
        tickets: { ticketCategoryId: null, ticketClosedCategoryId: null, ticketStaffRoleId: null, maxTicketsPerUser: 3, dmOnClose: true, ticketLogsChannelId: null, ticketTranscriptChannelId: null, ticketPanelMessage: 'Open a ticket', ticketButtonLabel: 'Create Ticket', ticketPanelChannelId: TEXT },
        config: { modmailBlocked: [MEMBER], disabledCommands: {}, disabledCategories: {}, birthdayChannelId: null, birthdayTimezone: 'UTC', birthdayRoleId: null },
        canned: { 'appeal-received': 'built in', mine: '<img src=x onerror=1>' },
        leveling: { enabled: true, xpRange: { min: 15, max: 25 }, xpCooldown: 60, levelUpMessage: 'gg {user}', levelUpChannel: null, ignoredChannels: [TEXT2], ignoredRoles: [], roleRewards: { 5: ROLE_OK }, announceLevelUp: true },
        levels: { [MEMBER]: 3 },
        verification: { enabled: false, channelId: TEXT, roleId: ROLE_OK, message: 'Verify here', buttonText: 'Verify', autoVerify: { enabled: false, criteria: 'none', accountAgeDays: null, roleId: null } },
        panels: [{ messageId: PANEL, channelId: TEXT, roles: [ROLE_OK, ROLE_OK2] }],
        giveaways: [{ messageId: GA_ACTIVE, channelId: TEXT, prize: 'Nitro', participants: ['1'], ended: false }, { messageId: GA_ENDED, channelId: TEXT, prize: 'Cake', participants: ['1', '2'], ended: true, winnerIds: ['1'] }],
        counters: [{ id: 'c1', type: 'members', channelId: VOICE }],
        counting: { enabled: false, channelId: null, system: 'decimal', nextNumber: 5 },
        jtc: { enabled: true, triggerChannels: [VOICE], channelOptions: {}, channelNameTemplate: "{username}'s Room", userLimit: 0, bitrate: 64000 },
        apps: { enabled: false, logChannelId: null, managerRoles: [ROLE_OK2], questions: ['Why?'], pendingApplicationRetentionDays: 30, reviewedApplicationRetentionDays: 14 },
        community: { suggestionsChannelId: null, starboardChannelId: TEXT, starboardEmoji: '⭐', starboardThreshold: 3 },
        stickies: [{ channelId: TEXT, content: 'Read the rules' }],
        tags: [{ name: 'rules', content: 'Be nice', triggerKind: 'none', trigger: null }],
        feeds: [{ id: 1, sourceId: 'UCabcdefghijklmnopqrstuv', channelId: TEXT, template: null }],
        appRoles: [{ roleId: ROLE_OK, name: 'Helper <b>', enabled: true, questions: ['Why?', { question: 'Age?', minLength: 2 }], logChannelId: null }],
    };
    const userErr = (message, type) => Object.assign(new Error(message), { type, userMessage: message });
    const clone = (v) => structuredClone(v);
    const merge = (target, patch) => {
        const before = clone(s[target]);
        Object.assign(s[target], clone(patch));
        return { before, after: clone(s[target]) };
    };
    const svc = {
        getGuildConfig: async () => clone(s.config),
        getSetting: (guildId, key) => (Object.hasOwn(s.registry, key) ? clone(s.registry[key]) : seedValue(getSettingEntry(key), ENV)),
        updateSettings: async (guildId, patch, actor) => {
            record('updateSettings', [guildId, patch, actor]);
            const changes = [];
            for (const [key, value] of Object.entries(patch)) {
                const entry = getSettingEntry(key);
                const check = entry.schema.safeParse(value);
                if (!check.success) throw Object.assign(new Error('bad'), { userMessage: `${entry.label}: ${check.error.issues[0].message}`, problems: ['x'] });
                const old = svc.getSetting(guildId, key);
                s.registry[key] = value;
                changes.push({ key, module: entry.module, old, new: value });
                auditRows.push({ guildId, key, old, new: value, by: 'settings service' });
            }
            return { changes, settings: patch };
        },
        getAutomodSettings: async () => clone(s.automod),
        getTrustedRoleProblem: (guild, role) => (role.managed || role.id === guild.id ? 'Pick a normal role (not @everyone or a bot role).' : null),
        loadNativePolicies: async () => new Map(s.native),
        setNativePolicy: async (guildId, ruleId, policy, dedupe) => { record('setNativePolicy', [ruleId, policy]); s.native.set(ruleId, { policy, dedupeMinutes: dedupe ?? 10 }); return true; },
        automodStats: async () => ({ total: 0, byGroup: [] }),
        automodRuleStats: async () => ({}),
        getLoggingStatus: async () => clone(s.logging),
        setLoggingEnabled: async (c, g, enabled) => { record('setLoggingEnabled', [enabled]); s.logging.enabled = enabled; return true; },
        setLogChannel: async (c, g, dest, id) => { record('setLogChannel', [dest, id]); s.logging.channels[dest] = id; return true; },
        toggleEventLogging: async (c, g, types, on) => { record('toggleEventLogging', [types, on]); for (const t of types) s.logging.enabledEvents[t] = on; return true; },
        updateIgnoreList: async (c, g, { action, type, id }) => { record('updateIgnoreList', [action, type, id]); const k = `${type}s`; s.logging.ignore[k] = action === 'add' ? [...s.logging.ignore[k], id] : s.logging.ignore[k].filter((x) => x !== id); return true; },
        getWelcomeSettings: async () => clone(s.welcome),
        updateWelcomeSettings: async (c, g, patch) => { record('updateWelcomeSettings', [patch]); return merge('welcome', patch); },
        addAutoRole: async (c, g, roleId) => { record('addAutoRole', [roleId]); const before = clone(s.welcome); const changed = !s.welcome.roleIds.includes(roleId); s.welcome.roleIds = [roleId]; return { before, after: clone(s.welcome), changed }; },
        removeAutoRole: async (c, g, roleId) => { record('removeAutoRole', [roleId]); const before = clone(s.welcome); const changed = s.welcome.roleIds.includes(roleId); s.welcome.roleIds = s.welcome.roleIds.filter((x) => x !== roleId); return { before, after: clone(s.welcome), changed }; },
        getTicketSettings: async () => clone(s.tickets),
        updateTicketSettings: async (c, g, patch) => { record('updateTicketSettings', [patch]); return merge('tickets', patch); },
        setModmailBlocked: async (c, g, id, blocked) => { record('setModmailBlocked', [id, blocked]); s.config.modmailBlocked = s.config.modmailBlocked.filter((x) => x !== id); },
        isBuiltInCanned: (name) => name === 'appeal-received',
        listCanned: async () => clone(s.canned),
        saveCanned: async (g, name, text) => { record('saveCanned', [name, text]); s.canned[name] = text; },
        removeCanned: async (g, name) => { record('removeCanned', [name]); if (name === 'appeal-received' || !s.canned[name]) return false; delete s.canned[name]; return true; },
        getLevelingConfig: async () => clone(s.leveling),
        updateLevelingConfig: async (c, g, patch) => { record('updateLevelingConfig', [patch]); return merge('leveling', patch); },
        setLevelRoleReward: async (c, g, level, roleId) => { record('setLevelRoleReward', [level, roleId]); const before = clone(s.leveling); if (roleId) s.leveling.roleRewards[level] = roleId; else delete s.leveling.roleRewards[level]; return { before, after: clone(s.leveling) }; },
        getUserLevelData: async (c, g, id) => ({ level: s.levels[id] ?? 0 }),
        addLevels: async (c, g, id, n) => { record('addLevels', [id, n]); s.levels[id] = (s.levels[id] ?? 0) + n; },
        removeLevels: async (c, g, id, n) => { record('removeLevels', [id, n]); s.levels[id] = Math.max(0, (s.levels[id] ?? 0) - n); },
        setUserLevel: async (c, g, id, n) => { record('setUserLevel', [id, n]); s.levels[id] = n; },
        getVerificationSettings: async () => clone(s.verification),
        updateVerificationSettings: async (c, g, patch) => {
            record('updateVerificationSettings', [patch]);
            const before = clone(s.verification);
            const { autoVerify, ...rest } = patch;
            Object.assign(s.verification, rest);
            if (autoVerify) Object.assign(s.verification.autoVerify, autoVerify);
            return { before, after: clone(s.verification) };
        },
        validateAutoVerifyCriteria: (criteria, days) => {
            if (criteria === 'account_age' && !days) throw Object.assign(new Error('x'), { type: 'validation', userMessage: 'Account age must be between 1 and 365 days.' });
            return { criteria, days };
        },
        getAllReactionRoleMessages: async () => clone(s.panels),
        addPanelRole: async (c, g, messageId, roleId) => { record('addPanelRole', [messageId, roleId]); const p = s.panels.find((x) => x.messageId === messageId); p.roles.push(roleId); return { panel: clone(p) }; },
        removePanelRole: async (c, g, messageId, roleId) => { record('removePanelRole', [messageId, roleId]); const p = s.panels.find((x) => x.messageId === messageId); p.roles = p.roles.filter((r) => r !== roleId); return { panel: clone(p), deletedPanel: p.roles.length === 0 }; },
        deletePanel: async (c, g, messageId) => { record('deletePanel', [messageId]); const p = s.panels.find((x) => x.messageId === messageId); s.panels = s.panels.filter((x) => x !== p); return { deleted: Boolean(p), panel: p || null }; },
        getGuildGiveaways: async () => clone(s.giveaways),
        endGiveawayNow: async (c, g, messageId) => { record('endGiveawayNow', [messageId]); return { winners: ['1'], participantCount: 1, channelId: TEXT, messageFound: true }; },
        rerollGiveaway: async (c, g, messageId) => { record('rerollGiveaway', [messageId]); return { winners: ['2'], participantCount: 2, channelId: TEXT, messageFound: true }; },
        updateBirthdaySettings: async (c, g, patch) => {
            record('updateBirthdaySettings', [patch]);
            const pick = () => ({ birthdayChannelId: s.config.birthdayChannelId, birthdayTimezone: s.config.birthdayTimezone, birthdayRoleId: s.config.birthdayRoleId });
            const before = pick();
            if (patch.timezone !== undefined && patch.timezone === 'Mars/Base') throw Object.assign(new Error('x'), { type: 'validation', userMessage: 'Mars/Base is not a known time zone.' });
            if (patch.channelId !== undefined) s.config.birthdayChannelId = patch.channelId;
            if (patch.timezone !== undefined) s.config.birthdayTimezone = patch.timezone;
            if (patch.roleId !== undefined) s.config.birthdayRoleId = patch.roleId;
            return { before, after: pick() };
        },
        getServerCounters: async () => clone(s.counters),
        changeCounterType: async (c, guild, id, type) => { record('changeCounterType', [id, type]); const k = s.counters.find((x) => x.id === id); const oldType = k.type; k.type = type; return { counter: clone(k), oldType, renamed: true }; },
        removeServerCounter: async (c, guild, id) => { record('removeServerCounter', [id]); const k = s.counters.find((x) => x.id === id); s.counters = s.counters.filter((x) => x !== k); return { counter: k, channel: null, channelDeleted: false }; },
        getCountingGameConfig: async () => clone(s.counting),
        activateCountingGame: async (c, g, channelId, system) => { record('activateCountingGame', [channelId, system]); Object.assign(s.counting, { enabled: true, channelId, system, nextNumber: 1 }); },
        resetCountingGame: async () => { record('resetCountingGame', []); s.counting.nextNumber = 1; },
        disableCountingGame: async () => { record('disableCountingGame', []); s.counting.enabled = false; },
        getJoinToCreateConfiguration: async () => clone(s.jtc),
        updateChannelConfig: async (c, g, channelId, updates) => { record('updateChannelConfig', [channelId, updates]); s.jtc.channelOptions[channelId] = { ...(s.jtc.channelOptions[channelId] || {}), ...updates }; return s.jtc.channelOptions[channelId]; },
        removeTriggerChannel: async (c, g, channelId) => { record('removeTriggerChannel', [channelId]); s.jtc.triggerChannels = s.jtc.triggerChannels.filter((x) => x !== channelId); return true; },
        getApplicationSettings: async () => clone(s.apps),
        updateApplicationSettings: async (c, g, patch) => { record('updateApplicationSettings', [patch]); return merge('apps', patch); },
        getCommunitySettings: () => clone(s.community),
        updateCommunitySettings: async (g, patch) => { record('updateCommunitySettings', [patch]); Object.assign(s.community, patch); return clone(s.community); },
        starboardSettingsPatch: ({ channelId, emoji, threshold }) => ({ starboardChannelId: channelId, starboardEmoji: emoji || '⭐', starboardThreshold: threshold }),
        listStickies: () => clone(s.stickies),
        setSticky: async ({ channel, content }) => {
            record('setSticky', [channel.id, content]);
            if (!String(content).trim()) throw Object.assign(new Error('x'), { type: 'user_input', userMessage: 'The sticky message cannot be empty.' });
            s.stickies = [...s.stickies.filter((x) => x.channelId !== channel.id), { channelId: channel.id, content }];
            return { posted: true };
        },
        removeSticky: async ({ channelId }) => { record('removeSticky', [channelId]); s.stickies = s.stickies.filter((x) => x.channelId !== channelId); return true; },
        listTags: () => clone(s.tags),
        createTag: async ({ name, content }) => {
            record('createTag', [name]);
            if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw Object.assign(new Error('x'), { type: 'user_input', userMessage: 'Tag names use lowercase letters, digits, - and _ (up to 32).' });
            const tag = { name, content, triggerKind: 'none' };
            s.tags.push(tag);
            return tag;
        },
        deleteTag: async (g, name) => { record('deleteTag', [name]); const had = s.tags.some((t) => t.name === name); s.tags = s.tags.filter((t) => t.name !== name); return had; },
        listFeeds: () => clone(s.feeds),
        addFeed: async ({ sourceInput, channelId }) => {
            record('addFeed', [sourceInput, channelId]);
            if (!/^UC[\w-]{22}$/.test(sourceInput)) throw Object.assign(new Error('x'), { type: 'user_input', userMessage: 'That is not a YouTube channel id.' });
            const feed = { id: 2, sourceId: sourceInput, channelId };
            s.feeds.push(feed);
            return { feed, latest: null };
        },
        removeFeed: async (g, id) => { record('removeFeed', [id]); const had = s.feeds.some((f) => f.id === id); s.feeds = s.feeds.filter((f) => f.id !== id); return had; },
        getCommandAccessSnapshot: (client, config) => ({
            categories: [{ key: 'fun', displayName: 'Fun', categoryDisabled: Boolean(config.disabledCategories?.fun), enabledCount: 1, totalCount: 2, disabledCommandNames: Object.keys(config.disabledCommands || {}),
                commands: [{ name: 'joke', description: 'A <joke>', protected: false }, { name: 'commands', description: 'Access', protected: true }] }],
        }),
        resolveCommandTarget: (client, name) => ({ joke: { name: 'joke', protected: false }, commands: { name: 'commands', protected: true } }[name] || null),
        getCategoryRegistry: (client, key) => (key === 'fun' ? { key: 'fun', displayName: 'Fun' } : null),
        enableCommand: async (c, g, name) => { record('enableCommand', [name]); delete s.config.disabledCommands[name]; },
        disableCommand: async (c, g, name) => { record('disableCommand', [name]); s.config.disabledCommands[name] = true; },
        enableCategory: async (c, g, key) => { record('enableCategory', [key]); delete s.config.disabledCategories[key]; },
        disableCategory: async (c, g, key) => { record('disableCategory', [key]); s.config.disabledCategories[key] = true; },
        postModLog: async (client, kind, fields, options) => { record('postModLog', [kind, options]); },
        // Channel tools: the real service on the fake guild, its log event recorded instead of sent.
        purgeChannelMessages: async (args) => { record('purgeChannelMessages', [args.channel.id, args.amount, args.fromUserId]); return purgeChannelMessages({ ...args, log: async (e) => s.logEvents.push(e) }); },
        lockChannel: async (args) => { record('lockChannel', [args.channel.id]); return lockChannel({ ...args, log: async (e) => s.logEvents.push(e) }); },
        unlockChannel: async (args) => { record('unlockChannel', [args.channel.id]); return unlockChannel({ ...args, log: async (e) => s.logEvents.push(e) }); },
        // Posting panels and creating things in Discord (Part 1 of the "everything from the web" work).
        setupTicketSystem: async (c, guild, opts) => {
            record('setupTicketSystem', [opts.panelChannel?.id]);
            if (s.tickets.ticketPanelChannelId) throw userErr('This server already has a ticket system set up.', 'configuration');
            Object.assign(s.tickets, { ticketPanelChannelId: opts.panelChannel.id, ticketPanelMessage: opts.panelMessage, ticketButtonLabel: opts.buttonLabel });
            return { message: { id: '710000000000000001' }, settings: clone(s.tickets) };
        },
        publishTicketPanel: async () => {
            record('publishTicketPanel', []);
            if (!s.tickets.ticketPanelChannelId) throw userErr('The ticket system is not set up yet: set it up first.', 'configuration');
            return { action: 'updated' };
        },
        setupVerification: async (c, guild, { channel, role, message, buttonText }) => {
            record('setupVerification', [channel.id, role.id]);
            Object.assign(s.verification, { enabled: true, channelId: channel.id, roleId: role.id, message, buttonText });
            return { message: { id: '710000000000000002' }, settings: clone(s.verification) };
        },
        publishVerificationPanel: async () => {
            record('publishVerificationPanel', []);
            if (!s.verification.channelId) throw userErr('The verification panel is not set up yet.', 'configuration');
            return { action: 'posted', message: { id: '710000000000000003' } };
        },
        postAppealPanels: async (c, guild, channel) => {
            record('postAppealPanels', [channel.id]);
            if (s.noAppealsCategory) throw userErr('There is no ticket category to open appeals in.', 'configuration');
            return { mainChannel: { id: channel.id, name: channel.name }, supportChannel: { id: '710000000000000004', name: 'appeals' }, created: false };
        },
        createReactionRolePanel: async (c, guild, { channel, roleIds, title }) => {
            record('createReactionRolePanel', [channel.id, roleIds, title]);
            const roles = roleIds.filter((id) => id !== ROLE_DANGER).map((id) => ({ id }));
            if (!roles.length) throw userErr('The following roles cannot be added: Mods - This role has dangerous permissions', 'validation');
            s.panels.push({ messageId: '710000000000000005', channelId: channel.id, roles: roles.map((r) => r.id) });
            return { message: { id: '710000000000000005' }, roles, rejected: roleIds.length > roles.length ? ['Mods - dangerous'] : [] };
        },
        postBotMessage: async (guild, { channel, content, embed }) => {
            record('postBotMessage', [channel.id, content, embed]);
            return { message: { id: '710000000000000011' } };
        },
        createPoll: async (guild, { channel, question, options, anonymous }) => {
            record('createPoll', [channel.id, question, options, anonymous]);
            return { message: { id: '710000000000000012' }, reacted: s.pollReactions ?? options.length };
        },
        startCountdownMessage: async (guild, { channel, totalSeconds, title }) => {
            record('startCountdownMessage', [channel.id, totalSeconds, title]);
            return { message: { id: '710000000000000013' }, countdownId: `${channel.id}-1`, endTime: Date.now() + totalSeconds * 1000 };
        },
        createGiveaway: async (c, guild, { channel, duration, winnerCount, prize }) => {
            record('createGiveaway', [channel.id, duration, winnerCount, prize]);
            if (!/^\d+[smhd]$/.test(duration)) throw userErr('Invalid duration format. Use: 1h, 30m, 5d, 10s (min: 10s, max: 30d)', 'validation');
            if (!prize) throw userErr('Prize must be between 1 and 256 characters.', 'validation');
            const giveaway = { messageId: '710000000000000006', channelId: channel.id, prize, winnerCount, endTime: Date.now() + 3600000, participants: [], ended: false };
            s.giveaways.push(giveaway);
            return { giveaway: clone(giveaway) };
        },
        deleteGiveawayNow: async (c, guild, messageId) => {
            record('deleteGiveawayNow', [messageId]);
            const giveaway = s.giveaways.find((x) => x.messageId === messageId);
            if (!giveaway) throw userErr('No giveaway was found with that message ID in the database.', 'validation');
            s.giveaways = s.giveaways.filter((x) => x !== giveaway);
            return { giveaway, deletedMessage: true, channelName: 'general' };
        },
        createServerCounter: async (c, guild, { type, channelType, category }) => {
            record('createServerCounter', [type, channelType, category.id]);
            if (s.counters.some((k) => k.type === type)) throw userErr('A **Members + Bots** counter already exists for this server.', 'user_input');
            const counter = { id: 'c2', type, channelId: '710000000000000007' };
            s.counters.push(counter);
            return { counter, channel: { id: counter.channelId, name: 'Members: 5' }, renamed: true };
        },
        setupJoinToCreate: async (c, guild, opts) => {
            record('setupJoinToCreate', [opts]);
            if (s.jtc.triggerChannels.length) throw userErr('This server already has a Join to Create channel set up.', 'validation');
            s.jtc.triggerChannels.push('710000000000000008');
            return { channel: { id: '710000000000000008', name: 'Join to Create' }, config: clone(s.jtc) };
        },
        editTag: async ({ guildId, name, ...changes }) => {
            record('editTag', [name, changes]);
            if (changes.triggerKind === 'regex' && /\(\?/.test(changes.trigger || '')) throw userErr('That pattern is not allowed.', 'user_input');
            const tag = s.tags.find((t) => t.name === name);
            if (!tag) return null;
            Object.assign(tag, changes);
            return clone(tag);
        },
        listApplicationRoles: async () => clone(s.appRoles),
        createApplicationRole: async (c, g, { roleId, name, questions }) => {
            record('createApplicationRole', [roleId, name, questions]);
            if (s.appRoles.some((r) => r.roleId === roleId)) throw userErr('This role is already configured as an application.', 'validation');
            const role = { roleId, name, enabled: true, questions: questions ? questions.split('\n') : null, logChannelId: null };
            s.appRoles.push(role);
            return { role, settings: { questions: role.questions || ['default'] } };
        },
        updateApplicationRole: async (c, g, roleId, patch) => {
            record('updateApplicationRole', [roleId, patch]);
            const role = s.appRoles.find((r) => r.roleId === roleId);
            const before = clone(role);
            Object.assign(role, patch);
            return { before, after: clone(role) };
        },
        deleteApplicationRole: async (c, g, roleId) => {
            record('deleteApplicationRole', [roleId]);
            const role = s.appRoles.find((r) => r.roleId === roleId);
            if (!role) throw userErr('That application role no longer exists.', 'validation');
            s.appRoles = s.appRoles.filter((r) => r !== role);
            return { role, deletedApplications: 2 };
        },
    };
    // Automod helpers: same shape as automodSettings.js (resolve the saved settings).
    const automodSet = (name, fn) => async (...args) => { record(name, args.slice(1)); fn(...args.slice(1)); return clone(s.automod); };
    Object.assign(svc, {
        setAutomodEnabled: automodSet('setAutomodEnabled', (v) => { s.automod.enabled = v; }),
        setAutomodMode: automodSet('setAutomodMode', (v) => { s.automod.mode = v; }),
        setRuleMode: automodSet('setRuleMode', (rule, mode) => { if (mode === 'default') delete s.automod.ruleModes[rule]; else s.automod.ruleModes[rule] = mode; }),
        setChannelRuleMode: automodSet('setChannelRuleMode', (channelId, rule, mode) => {
            const forChannel = { ...(s.automod.channelRules[channelId] || {}) };
            if (mode === 'default') delete forChannel[rule]; else forChannel[rule] = mode;
            if (Object.keys(forChannel).length) s.automod.channelRules[channelId] = forChannel; else delete s.automod.channelRules[channelId];
        }),
        setTrusted: automodSet('setTrusted', ({ roleId, minLevel, clear }) => { s.automod.trusted = clear ? { roleId: null, minLevel: 0 } : { roleId: roleId ?? null, minLevel: minLevel ?? 0 }; }),
        setSecondChance: automodSet('setSecondChance', (v) => { s.automod.secondChance = v; }),
        setMoodAlerts: automodSet('setMoodAlerts', (v) => { s.automod.moodAlerts = v; }),
        setPanic: automodSet('setPanic', ({ enabled, hours }) => { s.automod.panic = { enabled, hours }; }),
        setJoinGateCheck: automodSet('setJoinGateCheck', (check, action, days) => { s.automod.joinGate = { ...s.automod.joinGate, [check]: action, ...(days ? { ageDays: days } : {}) }; }),
    });
    svc.setExemptChannel = async (guildId, channelId, exempt) => {
        record('setExemptChannel', [channelId, exempt]);
        const set = new Set(s.automod.exemptChannelIds);
        if (exempt) set.add(channelId); else set.delete(channelId);
        s.automod.exemptChannelIds = [...set];
        return { settings: clone(s.automod), exempt };
    };
    return { svc, state: s, calls, auditRows };
}

// ── harness ───────────────────────────────────────────────────────────────

function fakeRes() {
    return {
        statusCode: 200, headers: {}, cookies: [], body: null, redirectedTo: null,
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(body) { this.body = body; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}

async function setup({ env = ENV, userId = ADMIN, admins = new Set([ADMIN]), owners = new Set([OWNER]), limits } = {}) {
    const { svc, state, calls, auditRows } = makeServices();
    const sessions = createMemorySessionStore();
    const guild = makeGuild();
    const client = {
        user: { id: '999999999999999998' },
        guilds: { cache: new Map([[GUILD, guild], [SUPPORT, makeSupportGuild()]]) },
        commands: new Map([['joke', {}]]),
    };
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: admins.has(id), isOwnerId: owners.has(id) }) });
    const auditStore = {
        writeRows: async (guildId, actor, module, changes) => { for (const c of changes) auditRows.push({ guildId, actor, module, ...c }); return changes.length; },
        list: async () => ({ rows: auditRows.map((r, i) => ({ id: i, created_at: new Date(0), user_id: r.actor?.userId, username: r.actor?.username, module: r.module, key: r.key, old: r.old, new: r.new })), total: auditRows.length }),
        users: async () => [],
    };
    const overview = {
        getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}),
    };
    const d = createDashboard({
        client, settings: dashboardSettings(env), sessions, access, services: svc, auditStore, env,
        data: { overview }, ...(limits ? { limits } : {}),
    });
    const session = await sessions.create({ userId, username: userId === OWNER ? 'owner' : 'admin<b>' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, svc, state, calls, auditRows, sessions, session, cookie, guild };
}

async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (passed) await handler(req, res, () => { res.fellThrough = true; });
    return res;
}

function post(h, module, action, form, { origin = ORIGIN, csrf = h.session.csrf, headers = {} } = {}) {
    return run(h, h.d.moduleAction, {
        method: 'POST', params: { module, action },
        headers: { cookie: h.cookie, ...(origin ? { origin } : {}), ...headers },
        body: { ...(csrf === null ? {} : { csrf }), ...form },
    });
}

function get(h, module) {
    return run(h, h.d.modulePage, { method: 'GET', params: { module }, headers: { cookie: h.cookie }, query: {} });
}

// Valid form, the service it must reach, and an invalid form with the expected message.
const CASES = {
    enforcement: {
        'appeal-panels': { form: { channelId: TEXT }, service: 'postAppealPanels', admin: true,
            bad: { form: { channelId: VOICE }, message: /must be a text channel/ } },
        channels: { form: { modLogChannelId: TEXT, evidenceChannelId: '', adminRequestChannelId: '', appealsCategoryId: CAT, reportsCategoryId: CAT, modmailCategoryId: '', openChannelCap: '15', supportServerInvite: 'https://discord.gg/abc' }, service: 'updateSettings',
            bad: { form: { modLogChannelId: MISSING }, message: /not in the server/ } },
        roles: { form: { mutedRoleId: ROLE_OK, warnRole1: ROLE_OK2 }, service: 'updateSettings', bad: { form: { mutedRoleId: GUILD }, message: /@everyone/ } },
        timings: { form: { appealWindowDays: '20', appealCooldownDays: '7', rejoinInviteHours: '168', staleReportDays: '7', staleAppealReminderDays: '3' }, service: 'updateSettings',
            bad: { form: { appealWindowDays: '999', appealCooldownDays: '7', rejoinInviteHours: '1', staleReportDays: '7', staleAppealReminderDays: '3' }, message: /between 1 and 365/ } },
        'mass-action': { form: { massActionLimit: '7', massMuteLimit: '12', massActionWindowMinutes: '10', massActionBlockMinutes: '60' }, service: 'updateSettings',
            bad: { form: { massActionLimit: 'x', massActionWindowMinutes: '10', massActionBlockMinutes: '60' }, message: /whole number/ } },
    },
    automod: {
        enabled: { form: { enabled: 'false' }, service: 'setAutomodEnabled', bad: { form: { enabled: 'maybe' }, message: /on or off/ } },
        mode: { form: { mode: 'monitor' }, service: 'setAutomodMode', bad: { form: { mode: 'chaos' }, message: /unknown choice/ } },
        rules: { form: { 'rule:caps': 'off' }, service: 'setRuleMode', bad: { form: { 'rule:caps': 'loud' }, message: /unknown mode/ } },
        'channel-add': { form: { channel: TEXT, rule: 'caps', mode: 'off' }, service: 'setChannelRuleMode', bad: { form: { channel: VOICE, rule: 'caps', mode: 'off' }, message: /must be a text channel or category/ } },
        'channel-remove': { seed: (s) => { s.automod.channelRules = { [TEXT]: { caps: 'off' } }; }, form: { channel: TEXT, rule: 'caps' }, service: 'setChannelRuleMode', bad: { form: { channel: 'x', rule: 'caps' }, message: /not a channel ID/ } },
        'exempt-add': { form: { channel: TEXT }, service: 'setExemptChannel', bad: { form: { channel: MISSING }, message: /not in the server/ } },
        'exempt-remove': { form: { channel: TEXT2 }, service: 'setExemptChannel', bad: { form: { channel: '1' }, message: /not a channel ID/ } },
        trusted: { form: { roleId: ROLE_OK, minLevel: '5' }, service: 'setTrusted', bad: { form: { roleId: ROLE_MANAGED, minLevel: '5' }, message: /managed/ } },
        'second-chance': { form: { enabled: 'false' }, service: 'setSecondChance', bad: { form: {}, message: /on or off/ } },
        mood: { form: { enabled: 'false' }, service: 'setMoodAlerts', bad: { form: { enabled: '' }, message: /on or off/ } },
        panic: { form: { hours: '5', enabled: '1' }, service: 'setPanic', bad: { form: { hours: '99' }, message: /between 1 and 24/ } },
        'join-gate': { form: { 'gate:avatar': 'flag', 'gate:links': 'off', 'gate:botname': 'off', 'gate:age': 'off', ageDays: '7' }, service: 'setJoinGateCheck',
            bad: { form: { 'gate:avatar': 'ban', 'gate:links': 'off', 'gate:botname': 'off', 'gate:age': 'off', ageDays: '7' }, message: /unknown choice/ } },
        native: { form: { ruleId: NATIVE_RULE, policy: 'warn', dedupeMinutes: '' }, service: 'setNativePolicy', bad: { form: { ruleId: MISSING, policy: 'warn' }, message: /no longer exists/ } },
        channels: { form: { reviewChannelId: TEXT, alertsChannelId: '', extraBlockedWords: 'foo\nBar' }, service: 'updateSettings', bad: { form: { reviewChannelId: CAT, alertsChannelId: '' }, message: /must be a text channel/ } },
    },
    logging: {
        enabled: { form: { enabled: 'true' }, service: 'setLoggingEnabled', bad: { form: { enabled: 'x' }, message: /on or off/ } },
        channels: { form: { audit: TEXT, applications: '', reports: '' }, service: 'setLogChannel', bad: { form: { audit: VOICE }, message: /must be a text channel/ } },
        events: { form: {}, service: 'toggleEventLogging' },
        'ignore-add': { form: { type: 'role', id: ROLE_OK }, service: 'updateIgnoreList', bad: { form: { type: 'user', id: 'abc' }, message: /Discord user ID/ } },
        'ignore-remove': { form: { type: 'channel', id: TEXT2 }, service: 'updateIgnoreList', bad: { form: { type: 'planet', id: TEXT2 }, message: /unknown choice/ } },
    },
    welcome: {
        'welcome-enabled': { form: { enabled: 'true' }, service: 'updateWelcomeSettings', bad: { form: { enabled: '2' }, message: /on or off/ } },
        'goodbye-enabled': { form: { enabled: 'true' }, service: 'updateWelcomeSettings', bad: { form: {}, message: /on or off/ } },
        welcome: { form: { channelId: TEXT, welcomeMessage: 'Hi {user}', welcomePing: '1', dmMessage: '' }, service: 'updateWelcomeSettings', bad: { form: { channelId: CAT }, message: /must be a text channel/ } },
        goodbye: { form: { goodbyeChannelId: TEXT, leaveMessage: 'Bye {user}' }, service: 'updateWelcomeSettings', bad: { form: { goodbyeChannelId: MISSING }, message: /not in the server/ } },
        'autorole-add': { form: { roleId: ROLE_OK2 }, service: 'addAutoRole', bad: { form: { roleId: ROLE_DANGER }, message: /staff permissions/ } },
        'autorole-remove': { form: { roleId: ROLE_OK }, service: 'removeAutoRole' },
        'autorole-delay': { form: { autoRoleDelay: '30' }, service: 'updateWelcomeSettings', bad: { form: { autoRoleDelay: '-1' }, message: /between 0 and 3600/ } },
        logs: { form: { joinLogsEnabled: '1', joinLogsChannelId: TEXT, leaveLogsChannelId: '' }, service: 'updateWelcomeSettings', bad: { form: { joinLogsChannelId: VOICE }, message: /must be a text channel/ } },
    },
    tickets: {
        setup: { seed: (s) => { s.tickets.ticketPanelChannelId = null; }, form: { panelChannelId: TEXT, panelMessage: 'Open one', buttonLabel: 'Help', categoryId: CAT, closedCategoryId: '', staffRoleId: ROLE_OK, maxTicketsPerUser: '3', dmOnClose: '1' },
            service: 'setupTicketSystem', admin: true, bad: { form: { panelChannelId: CAT, maxTicketsPerUser: '3' }, message: /must be a text channel/ } },
        'panel-publish': { form: {}, service: 'publishTicketPanel', admin: true,
            bad: { seed: (s) => { s.tickets.ticketPanelChannelId = null; }, form: {}, message: /not set up yet/ } },
        settings: { form: { ticketCategoryId: CAT, ticketClosedCategoryId: '', ticketStaffRoleId: ROLE_OK, maxTicketsPerUser: '3', dmOnClose: '1', ticketLogsChannelId: '', ticketTranscriptChannelId: '', ticketButtonLabel: 'Help', ticketPanelMessage: 'Open a ticket' },
            service: 'updateTicketSettings', bad: { form: { ticketCategoryId: TEXT, maxTicketsPerUser: '3' }, message: /must be a category/ } },
        unblock: { form: { userId: MEMBER }, service: 'setModmailBlocked', bad: { form: { userId: 'me' }, message: /Discord user ID/ } },
        'canned-add': { form: { name: 'hello', text: 'Hello there' }, service: 'saveCanned', bad: { form: { name: 'Bad Name', text: 'x' }, message: /lowercase letters/ } },
        'canned-remove': { form: { name: 'mine' }, service: 'removeCanned', bad: { form: { name: 'appeal-received' }, message: /built in/ } },
    },
    leveling: {
        enabled: { form: { enabled: 'false' }, service: 'updateLevelingConfig', bad: { form: { enabled: 'y' }, message: /on or off/ } },
        settings: { form: { xpMin: '10', xpMax: '20', xpCooldown: '30', levelUpChannel: '', announceLevelUp: '1', levelUpMessage: 'gg {user}' }, service: 'updateLevelingConfig',
            bad: { form: { xpMin: '30', xpMax: '20', xpCooldown: '30' }, message: /less than or equal/ } },
        'ignore-add': { form: { type: 'channel', id: TEXT }, service: 'updateLevelingConfig', bad: { form: { type: 'role', id: MISSING }, message: /not in the server/ } },
        'ignore-remove': { form: { type: 'channel', id: TEXT2 }, service: 'updateLevelingConfig' },
        'reward-add': { form: { level: '10', roleId: ROLE_OK2 }, service: 'setLevelRoleReward', bad: { form: { level: '10', roleId: ROLE_HIGH }, message: /not below my highest role/ } },
        'reward-remove': { form: { level: '5' }, service: 'setLevelRoleReward', bad: { form: { level: '0' }, message: /between 1 and 1000/ } },
        member: { form: { userId: MEMBER, op: 'add', levels: '2' }, service: 'addLevels', bad: { form: { userId: STRANGER, op: 'add', levels: '2' }, message: /not in the server/ }, admin: true },
    },
    verification: {
        setup: { seed: (s) => { s.verification.channelId = null; }, form: { channelId: TEXT, roleId: ROLE_OK2, buttonText: 'Go', message: 'Press it' }, service: 'setupVerification', admin: true,
            bad: { form: { channelId: TEXT, roleId: ROLE_OK2 }, message: /already set up/ } },
        'panel-publish': { form: {}, service: 'publishVerificationPanel', admin: true,
            bad: { seed: (s) => { s.verification.channelId = null; }, form: {}, message: /not set up yet/ } },
        enabled: { form: { enabled: 'true' }, service: 'updateVerificationSettings', bad: { seed: (s) => { s.verification.autoVerify.enabled = true; }, form: { enabled: 'true' }, message: /Auto-verify is on/ } },
        settings: { form: { roleId: ROLE_OK2, buttonText: 'Go', message: 'Press it' }, service: 'updateVerificationSettings', bad: { form: { roleId: ROLE_DANGER, buttonText: 'Go', message: 'x' }, message: /staff permissions/ } },
        'auto-enabled': { seed: (s) => { s.welcome.roleIds = []; }, form: { enabled: 'true' }, service: 'updateVerificationSettings', bad: { form: { enabled: 'true' }, message: /auto roles are configured/ } },
        auto: { form: { criteria: 'account_age', accountAgeDays: '7', autoRoleId: '' }, service: 'updateVerificationSettings', bad: { form: { criteria: 'account_age', accountAgeDays: '' }, message: /Account age must be/ } },
        redirect: { form: { verifySuccessRedirect: 'https://example.com/ok' }, service: 'updateSettings', bad: { form: { verifySuccessRedirect: 'javascript:alert(1)' }, message: /https/ } },
    },
    'reaction-roles': {
        'panel-create': { form: { channelId: TEXT, title: 'Pick roles', description: 'Colours', roleIds: [ROLE_OK, ROLE_OK2] }, service: 'createReactionRolePanel', admin: true,
            bad: { form: { channelId: TEXT, title: 'x', description: 'y', roleIds: [] }, message: /Choose at least one role/ } },
        'role-add': { form: { messageId: PANEL, roleId: ROLE_DANGER }, service: 'addPanelRole', bad: { form: { messageId: PANEL, roleId: MISSING }, message: /not in the server/ } },
        'role-remove': { form: { messageId: PANEL, roleId: ROLE_OK }, service: 'removePanelRole', bad: { form: { messageId: 'x', roleId: ROLE_OK }, message: /Unknown panel/ } },
        'panel-delete': { form: { messageId: PANEL }, service: 'deletePanel', bad: { form: { messageId: MISSING }, message: /no longer exists/ } },
    },
    messages: {
        send: { form: { channelId: TEXT, content: 'Hello @everyone', title: 'News', description: 'Line 1\r\nLine 2', colour: 'purple', hex: '', imageUrl: 'https://example.com/a.png', footer: 'Staff' },
            service: 'postBotMessage', admin: true, bad: { form: { channelId: TEXT, title: 'News', imageUrl: 'http://example.com/a.png' }, message: /https:\/\/ link/ } },
        poll: { form: { channelId: TEXT, question: 'Pizza?', options: 'Yes\r\nNo\r\n\r\nMaybe', anonymous: '1' }, service: 'createPoll', admin: true,
            bad: { form: { channelId: TEXT, question: 'Pizza?', options: 'Only one' }, message: /at least 2 options/ } },
        countdown: { form: { channelId: TEXT, title: 'Launch', minutes: '2', seconds: '30' }, service: 'startCountdownMessage', admin: true,
            bad: { form: { channelId: TEXT, minutes: '0', seconds: '0' }, message: /at least 1 second/ } },
    },
    giveaways: {
        create: { form: { channelId: TEXT, prize: 'Nitro <b>', duration: '2h', winners: '2' }, service: 'createGiveaway', admin: true,
            bad: { form: { channelId: TEXT, prize: 'x', duration: 'soon', winners: '1' }, message: /Invalid duration format/ } },
        delete: { form: { messageId: GA_ENDED }, service: 'deleteGiveawayNow', admin: true, bad: { form: { messageId: MISSING }, message: /No giveaway was found/ } },
        end: { form: { messageId: GA_ACTIVE }, service: 'endGiveawayNow', bad: { form: { messageId: '12' }, message: /Unknown giveaway/ }, admin: true },
        reroll: { form: { messageId: GA_ENDED }, service: 'rerollGiveaway', bad: { form: { messageId: '' }, message: /Unknown giveaway/ }, admin: true },
    },
    birthdays: {
        settings: { form: { channelId: TEXT, timezone: 'Europe/London', roleId: ROLE_OK }, service: 'updateBirthdaySettings', bad: { form: { channelId: TEXT, timezone: 'Mars/Base', roleId: '' }, message: /not a known time zone/ } },
        off: { seed: (s) => { s.config.birthdayChannelId = TEXT; }, form: {}, service: 'updateBirthdaySettings' },
    },
    counters: {
        'counter-create': { form: { type: 'bots', channelType: 'voice', categoryId: CAT }, service: 'createServerCounter', admin: true,
            bad: { form: { type: 'bots', channelType: 'voice', categoryId: TEXT }, message: /must be a category/ } },
        'counter-type': { form: { counterId: 'c1', type: 'bots' }, service: 'changeCounterType', bad: { form: { counterId: 'c1', type: 'cats' }, message: /unknown choice/ } },
        'counter-delete': { form: { counterId: 'c1' }, service: 'removeServerCounter', bad: { form: { counterId: '' }, message: /Unknown counter/ } },
        'counting-setup': { form: { channelId: TEXT, system: 'decimal' }, service: 'activateCountingGame', bad: { form: { channelId: '', system: 'decimal' }, message: /pick a channel/ } },
        'counting-reset': { form: {}, service: 'resetCountingGame' },
        'counting-off': { seed: (s) => { s.counting.enabled = true; }, form: {}, service: 'disableCountingGame' },
    },
    'join-to-create': {
        'trigger-add': { seed: (s) => { s.jtc.triggerChannels = []; }, form: { categoryId: CAT, nameTemplate: '{username} room', userLimit: '0', bitrateKbps: '64' }, service: 'setupJoinToCreate', admin: true,
            bad: { form: { categoryId: CAT, nameTemplate: '{username}', userLimit: '0', bitrateKbps: '64' }, message: /already has a Join to Create/ } },
        trigger: { form: { channelId: VOICE, nameTemplate: '{username} room', userLimit: '5', bitrateKbps: '64' }, service: 'updateChannelConfig',
            bad: { form: { channelId: VOICE, nameTemplate: 'x', userLimit: '500', bitrateKbps: '64' }, message: /between 0 and 99/ } },
        'trigger-remove': { form: { channelId: VOICE }, service: 'removeTriggerChannel', bad: { form: { channelId: 'nope' }, message: /Unknown trigger/ } },
    },
    applications: {
        'role-create': { form: { roleId: ROLE_OK2, name: 'Moderator', questions: 'Why?\nAge? [min:2]' }, service: 'createApplicationRole',
            bad: { form: { roleId: ROLE_OK, name: 'Again' }, message: /already configured/ } },
        'role-update': { form: { roleId: ROLE_OK, name: 'Helpers', enabled: '1', logChannelId: TEXT, questions: 'Why join? [min:10]' }, service: 'updateApplicationRole',
            bad: { form: { roleId: ROLE_OK, name: 'Helpers', questions: 'a\nb\nc\nd\ne\nf' }, message: /At most 5 questions/ } },
        'role-delete': { form: { roleId: ROLE_OK, confirm: '1' }, service: 'deleteApplicationRole', bad: { form: { roleId: ROLE_OK }, message: /Tick the box/ } },
        enabled: { form: { enabled: 'true' }, service: 'updateApplicationSettings', bad: { form: { enabled: 'yes please' }, message: /on or off/ } },
        settings: { form: { logChannelId: TEXT, pendingDays: '30', reviewedDays: '14' }, service: 'updateApplicationSettings', bad: { form: { logChannelId: '', pendingDays: '0', reviewedDays: '14' }, message: /between 1 and 3650/ } },
        questions: { form: { questions: 'Why do you want to join?\nAge? [min:2]' }, service: 'updateApplicationSettings', bad: { form: { questions: 'a\nb\nc\nd\ne\nf' }, message: /At most 5 questions/ } },
        'manager-add': { form: { roleId: ROLE_OK }, service: 'updateApplicationSettings', bad: { form: { roleId: MISSING }, message: /not in the server/ } },
        'manager-remove': { form: { roleId: ROLE_OK2 }, service: 'updateApplicationSettings', bad: { form: { roleId: ROLE_OK }, message: /not a manager role/ } },
    },
    community: {
        suggestions: { form: { channelId: TEXT }, service: 'updateCommunitySettings', bad: { form: { channelId: CAT }, message: /must be a text channel/ } },
        starboard: { form: { channelId: TEXT, emoji: '🌟', threshold: '5' }, service: 'updateCommunitySettings', bad: { form: { channelId: TEXT, threshold: '1000' }, message: /between 1 and 100/ } },
        'starboard-off': { form: {}, service: 'updateCommunitySettings' },
        'sticky-set': { form: { channelId: TEXT2, content: 'Hello' }, service: 'setSticky', bad: { form: { channelId: TEXT2, content: '   ' }, message: /cannot be empty/ } },
        'sticky-remove': { form: { channelId: TEXT }, service: 'removeSticky', bad: { form: { channelId: TEXT2 }, message: /no sticky/ } },
        'tag-create': { form: { name: 'faq', content: 'Read the FAQ', triggerKind: 'none' }, service: 'createTag', bad: { form: { name: 'Bad Name!', content: 'x' }, message: /Tag names/ } },
        'tag-edit': { form: { name: 'rules', content: 'Be kind', triggerKind: 'word', trigger: 'rules', cooldownS: '30', allowChannels: [TEXT], denyChannels: '' }, service: 'editTag',
            bad: { form: { name: 'rules', content: 'x', triggerKind: 'none', allowChannels: [VOICE] }, message: /must be a text channel or category/ } },
        'tag-delete': { form: { name: 'rules' }, service: 'deleteTag', bad: { form: { name: 'nope' }, message: /no such tag/ } },
        'feed-add': { form: { source: 'UCabcdefghijklmnopqrstu2', channelId: TEXT }, service: 'addFeed', bad: { form: { source: 'nope', channelId: TEXT }, message: /YouTube channel id/ } },
        'feed-remove': { form: { id: '1' }, service: 'removeFeed', bad: { form: { id: '9' }, message: /no feed #9/ } },
    },
    commands: {
        command: { form: { name: 'joke', enabled: 'false' }, service: 'disableCommand', bad: { form: { name: 'commands', enabled: 'false' }, message: /cannot be disabled/ } },
        category: { form: { key: 'fun', enabled: 'false' }, service: 'disableCategory', bad: { form: { key: 'nope', enabled: 'false' }, message: /Unknown category/ } },
    },
    channels: {
        purge: { form: { channelId: TEXT, amount: '2', userId: '', reason: 'spam', confirm: '1' }, service: 'purgeChannelMessages', admin: true,
            bad: { form: { channelId: TEXT, amount: '101', confirm: '1' }, message: /between 1 and 100/ } },
        lock: { form: { channelId: TEXT, reason: 'raid' }, service: 'lockChannel', admin: true,
            bad: { form: { channelId: VOICE }, message: /must be a text channel/ } },
        unlock: { seed: (s, guild) => { guild.channels.cache.get(TEXT).permissionOverwrites.edit(GUILD, { SendMessages: false }); }, form: { channelId: TEXT }, service: 'unlockChannel', admin: true,
            bad: { form: { channelId: MISSING }, message: /not in the server/ } },
    },
    support: {
        'banned-role': { form: { bannedRoleId: SUPPORT_ROLE }, service: 'updateSettings', bad: { form: { bannedRoleId: ROLE_OK }, message: /not in the server/ } },
        'appeals-category': { form: { supportAppealsCategoryId: SUPPORT_CAT }, service: 'updateSettings', bad: { form: { supportAppealsCategoryId: CAT }, message: /not in the server/ } },
    },
};

// ── coverage of the case table ────────────────────────────────────────────

test('every module action has a test case', () => {
    for (const module of MODULES) {
        for (const action of Object.keys(module.actions)) {
            assert.ok(CASES[module.key]?.[action], `missing case for ${module.key}/${action}`);
        }
    }
});

// ── security, for every POST action ───────────────────────────────────────

test('every POST action: no CSRF → 403, bad Origin → 403, editing off → 403; nothing is called', async () => {
    for (const module of MODULES) {
        for (const action of Object.keys(module.actions)) {
            const { form } = CASES[module.key][action];
            const h = await setup();
            const noCsrf = await post(h, module.key, action, form, { csrf: null });
            assert.equal(noCsrf.statusCode, 403, `${module.key}/${action} without CSRF`);
            const wrongCsrf = await post(h, module.key, action, form, { csrf: 'A'.repeat(32) });
            assert.equal(wrongCsrf.statusCode, 403, `${module.key}/${action} wrong CSRF`);
            const badOrigin = await post(h, module.key, action, form, { origin: 'https://evil.example' });
            assert.equal(badOrigin.statusCode, 403, `${module.key}/${action} bad Origin`);
            const nullOrigin = await post(h, module.key, action, form, { origin: 'null' });
            assert.equal(nullOrigin.statusCode, 403, `${module.key}/${action} Origin null`);
            const badReferer = await post(h, module.key, action, form, { origin: null, headers: { referer: 'https://evil.example/dashboard' } });
            assert.equal(badReferer.statusCode, 403, `${module.key}/${action} bad Referer`);
            const noHeaders = await post(h, module.key, action, form, { origin: null });
            assert.equal(noHeaders.statusCode, 403, `${module.key}/${action} without Origin/Referer`);
            const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
            const disabled = await post(off, module.key, action, form);
            assert.equal(disabled.statusCode, 403, `${module.key}/${action} editing off`);
            assert.match(disabled.body, /Editing is off/);
            assert.deepEqual([...h.calls, ...off.calls], [], `${module.key}/${action}: nothing called`);
            assert.equal(h.auditRows.length + off.auditRows.length, 0);
        }
    }
});

test('every POST action: users without access are refused; admin-only actions refuse OWNER_IDS without Administrator', async () => {
    for (const module of MODULES) {
        for (const [action, c] of Object.entries(CASES[module.key])) {
            const stranger = await setup({ userId: STRANGER });
            const res = await post(stranger, module.key, action, c.form);
            assert.equal(res.statusCode, 403, `${module.key}/${action} stranger`);
            assert.equal(stranger.calls.length, 0);
            const owner = await setup({ userId: OWNER });
            c.seed?.(owner.state, owner.guild);
            const asOwner = await post(owner, module.key, action, c.form);
            if (getAction(module, action).admin) {
                assert.equal(asOwner.statusCode, 403, `${module.key}/${action} owner must be refused`);
                assert.match(asOwner.body, /Administrator/);
                assert.equal(owner.calls.length, 0);
            } else {
                assert.equal(asOwner.statusCode, 303, `${module.key}/${action} owner may change settings (decision 4)`);
            }
        }
    }
});

test('owner override: an OWNER_IDS action without Administrator is logged with user, action and time; an admin\'s is not', async () => {
    const warnings = [];
    const realWarn = logger.warn;
    logger.warn = (message, ...rest) => { warnings.push(String(message)); return realWarn.call(logger, message, ...rest); };
    try {
        const module = MODULES.find((m) => Object.keys(CASES[m.key]).some((a) => !getAction(m, a).admin));
        const action = Object.keys(CASES[module.key]).find((a) => !getAction(module, a).admin);
        const owner = await setup({ userId: OWNER });
        CASES[module.key][action].seed?.(owner.state, owner.guild);
        assert.equal((await post(owner, module.key, action, CASES[module.key][action].form)).statusCode, 303);
        const line = warnings.find((w) => w.startsWith('Owner override:'));
        assert.ok(line, 'override logged');
        assert.ok(line.includes(OWNER), 'user id');
        assert.ok(line.includes(`${module.key}/${action}`), 'action');
        assert.match(line, /via dashboard at \d{4}-\d{2}-\d{2}T/, 'time');
        warnings.length = 0;
        const admin = await setup();
        CASES[module.key][action].seed?.(admin.state, admin.guild);
        await post(admin, module.key, action, CASES[module.key][action].form);
        assert.equal(warnings.filter((w) => w.startsWith('Owner override:')).length, 0);
    } finally {
        logger.warn = realWarn;
    }
});

// ── invalid and valid input, for every POST action ────────────────────────

test('every POST action with invalid input: 400, the message on the page, no write, no audit, no mod log', async () => {
    for (const module of MODULES) {
        for (const [action, c] of Object.entries(CASES[module.key])) {
            if (!c.bad) continue;
            const h = await setup();
            c.bad.seed?.(h.state, h.guild);
            const res = await post(h, module.key, action, c.bad.form);
            assert.equal(res.statusCode, 400, `${module.key}/${action} invalid → 400 (got ${res.statusCode})`);
            assert.match(res.body, c.bad.message, `${module.key}/${action} message`);
            assert.match(res.body, /class="error( form-error)?" role="alert"/);
            const writes = h.calls.filter((call) => call.name !== 'postModLog' && !['createTag', 'addFeed', 'setSticky', 'updateBirthdaySettings', 'updateSettings', 'removeCanned', 'deleteTag', 'removeFeed', 'deletePanel',
                // These services refuse by themselves (nothing written when they throw).
                'publishTicketPanel', 'publishVerificationPanel', 'createGiveaway', 'deleteGiveawayNow', 'setupJoinToCreate', 'createApplicationRole', 'editTag'].includes(call.name));
            assert.deepEqual(writes.map((w) => w.name), [], `${module.key}/${action}: no write on invalid input`);
            assert.equal(h.auditRows.length, 0, `${module.key}/${action}: no audit row`);
            assert.ok(!h.calls.some((call) => call.name === 'postModLog'), `${module.key}/${action}: no mod log`);
        }
    }
});

test('every POST action with valid input: service called, audit row, one mod-log line, flash, 303', async () => {
    for (const module of MODULES) {
        for (const [action, c] of Object.entries(CASES[module.key])) {
            const h = await setup();
            c.seed?.(h.state, h.guild);
            const res = await post(h, module.key, action, c.form);
            assert.equal(res.statusCode, 303, `${module.key}/${action} → 303 (got ${res.statusCode}: ${String(res.body).match(/role="alert">([^<]*)/)?.[1] || ''})`);
            assert.equal(res.redirectedTo, `/dashboard/${module.key}`);
            assert.ok(h.calls.some((call) => call.name === c.service), `${module.key}/${action} calls ${c.service}`);
            assert.ok(h.auditRows.length > 0, `${module.key}/${action} audit row`);
            const modLog = h.calls.filter((call) => call.name === 'postModLog');
            assert.equal(modLog.length, 1, `${module.key}/${action} one mod-log post`);
            assert.equal(modLog[0].args[0], 'dashboard');
            assert.match(modLog[0].args[1].description, new RegExp(`\\(${ADMIN}\\) changed `));
            const session = await h.sessions.get(h.session.id);
            assert.ok(session.flash, `${module.key}/${action} flash`);
            // The flash is shown once on the next page, then cleared.
            const page = await get(h, module.key);
            assert.equal(page.statusCode, 200);
            assert.ok(page.body.includes('class="flash"'), `${module.key}/${action} flash shown`);
            assert.equal((await h.sessions.get(h.session.id)).flash, null);
        }
    }
});

test('audit rows: registry settings are audited by the settings service (not twice); others in the dashboard layer with old → new', async () => {
    const h = await setup();
    await post(h, 'enforcement', 'channels', { modLogChannelId: TEXT });
    assert.equal(h.auditRows.length, 1);
    assert.equal(h.auditRows[0].by, 'settings service');
    assert.equal(h.calls.find((c) => c.name === 'updateSettings').args[2].module, 'enforcement');

    const t = await setup();
    await post(t, 'tickets', 'settings', { ...CASES.tickets.settings.form, maxTicketsPerUser: '5' });
    const keys = t.auditRows.map((r) => r.key).sort();
    assert.ok(keys.includes('maxTicketsPerUser'));
    const row = t.auditRows.find((r) => r.key === 'maxTicketsPerUser');
    assert.deepEqual([row.old, row.new, row.module, row.actor.userId], [3, 5, 'tickets', ADMIN]);
    assert.deepEqual(t.calls.find((c) => c.name === 'updateTicketSettings').args[0].maxTicketsPerUser, 5, 'only changed keys are sent');
});

test('a form that changes nothing: 303 with "Nothing changed", no audit row, no mod log', async () => {
    const h = await setup();
    const res = await post(h, 'birthdays', 'settings', { channelId: '', timezone: 'UTC', roleId: '' });
    assert.equal(res.statusCode, 303);
    assert.equal(h.auditRows.length, 0);
    assert.ok(!h.calls.some((c) => c.name === 'postModLog'));
    assert.match((await h.sessions.get(h.session.id)).flash, /Nothing changed/);
});

test('POST rate limit: 30 per minute per session → 429', async () => {
    const h = await setup({ limits: { session: { limit: 1000, windowMs: 60000 }, ip: { limit: 30, windowMs: 60000 }, static: { limit: 30, windowMs: 60000 }, post: { limit: 3, windowMs: 60000 } } });
    for (let i = 0; i < 3; i += 1) assert.equal((await post(h, 'automod', 'mood', { enabled: i % 2 ? 'true' : 'false' })).statusCode, 303);
    const limited = await post(h, 'automod', 'mood', { enabled: 'true' });
    assert.equal(limited.statusCode, 429);
});

test('unknown module or action → 404 (after the security checks)', async () => {
    const h = await setup();
    assert.equal((await post(h, 'nope', 'x', {})).statusCode, 404);
    assert.equal((await post(h, 'automod', 'nope', {})).statusCode, 404);
    assert.equal((await post(h, 'automod', 'toString', {})).statusCode, 404, 'no prototype lookups');
    assert.equal((await post(h, 'nope', 'x', {}, { csrf: null })).statusCode, 403);
});

test('array values for repeated keys never reach a service', async () => {
    const h = await setup();
    const res = await post(h, 'enforcement', 'channels', { modLogChannelId: [TEXT, TEXT2] });
    assert.equal(res.statusCode, 303);
    assert.ok(!h.calls.some((c) => c.name === 'updateSettings'), 'an array is treated as empty → nothing changed');
});

// ── pages ─────────────────────────────────────────────────────────────────

test('every module page renders: 200, escaped values, no inline styles or scripts, CSRF in every form', async () => {
    for (const module of MODULES) {
        const h = await setup();
        const res = await get(h, module.key);
        assert.equal(res.statusCode, 200, module.key);
        assert.ok(!/<style|style=|<script|\son[a-z]+=/i.test(res.body.replace(ALLOWED_SCRIPT, '').replace(/&lt;[^]*?&gt;/g, '')), `${module.key}: no inline style/script/handlers`);
        assert.ok(!res.body.includes('<script>x</script>'), `${module.key}: channel names escaped`);
        assert.ok(!res.body.includes('<img src=x'), `${module.key}: values escaped`);
        assert.ok(!res.body.includes('admin<b>'), 'username escaped');
        const forms = res.body.match(/<form method="post"[^>]*>/g) || [];
        const tokens = res.body.match(/name="csrf" value="[^"]+"/g) || [];
        assert.equal(tokens.length, forms.length, `${module.key}: CSRF token in every form`);
        assert.ok(!res.body.includes('Phase 2'), `${module.key}: no placeholders left`);
        assert.ok(res.body.includes(`aria-current="page"`), `${module.key}: active in the sidebar`);
    }
});

test('editing off: every page says read-only and has no submit buttons; owners see Administrator-only parts disabled', async () => {
    for (const module of MODULES) {
        const h = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
        const res = await get(h, module.key);
        assert.equal(res.statusCode, 200);
        assert.match(res.body, /Read-only: editing from the dashboard is turned off/);
        assert.ok(!res.body.includes('type="submit" class="primary"') && !res.body.includes('type="submit" class="danger"'), `${module.key}: no save buttons`);
        assert.ok(!res.body.includes('<fieldset>'), `${module.key}: every form fieldset disabled`);
    }
    const owner = await setup({ userId: OWNER });
    const giveaways = await get(owner, 'giveaways');
    assert.match(giveaways.body, /need Administrator/);
    assert.ok(!/>End now</.test(giveaways.body), 'no End now button for an owner');
    const leveling = await get(owner, 'leveling');
    assert.match(leveling.body, /needs Administrator/);
});

test('pickers: grouped by category, sorted by name; warnings for missing permissions and unassignable roles', async () => {
    const guild = makeGuild();
    const groups = channelGroups(guild, ['text']);
    assert.deepEqual(groups.map((g) => g.group), ['No category', 'Support']);
    assert.deepEqual(groups[1].channels.map((c) => c.id), [TEXT]);
    assert.deepEqual(channelGroups(guild, ['category'])[0].channels.map((c) => c.id), [CAT]);
    guild.members.me.permissionsIn = () => ({ has: (p) => p !== 1n << 11n }); // SendMessages missing
    assert.match(channelWarnings(guild, TEXT)[0], /missing Send Messages in #general/);
    assert.match(channelWarnings(guild, MISSING)[0], /no longer exists/);
    assert.match(roleWarnings(guild, ROLE_HIGH)[0], /not below my highest role/);
    assert.match(roleWarnings(guild, ROLE_DANGER, { autoAssign: true }).join(), /staff permissions \(Administrator\)/);
    assert.deepEqual(roleWarnings(guild, ROLE_OK, { autoAssign: true }), []);
    assert.match(roleWarnings(guild, ROLE_MANAGED).join(), /managed/);

    const h = await setup();
    h.guild.members.me.permissionsIn = () => ({ has: () => false });
    h.state.registry.modLogChannelId = TEXT;
    const page = await get(h, 'enforcement');
    assert.match(page.body, /class="field-warn">I am missing View Channel, Send Messages, Embed Links in #general/);
    assert.match(page.body, /<optgroup label="Support"><option value="500000000000000001" selected>#general<\/option>/);
});

test('audit page: filters by user and module, paged; values escaped', async () => {
    const h = await setup();
    const seen = [];
    h.d = createDashboard({
        client: { guilds: { cache: new Map([[GUILD, h.guild]]) } }, settings: dashboardSettings(ENV), sessions: h.sessions,
        access: createAccessChecker({}, { facts: async () => ({ inGuild: true, isAdmin: true }) }), services: h.svc, env: ENV,
        data: { overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) } },
        auditStore: {
            list: async (guildId, filters) => { seen.push(filters); return { rows: [{ id: 1, created_at: new Date(0), user_id: ADMIN, username: '<u>', module: 'logging', key: 'k', old: null, new: '<x>' }], total: 120 }; },
            users: async () => [{ user_id: ADMIN, username: 'admin' }],
            writeRows: async () => 0,
        },
    });
    const res = await run(h, h.d.audit, { method: 'GET', headers: { cookie: h.cookie }, query: { user: ADMIN, module: 'logging', page: '1' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen[0], { userId: ADMIN, module: 'logging', page: 1, pageSize: 50 });
    assert.match(res.body, /Page 2 of 3/);
    assert.match(res.body, /&lt;u&gt;/);
    assert.match(res.body, /&lt;x&gt;/);
    assert.match(res.body, /<option value="200000000000000002" selected>/);
    const bad = await run(h, h.d.audit, { method: 'GET', headers: { cookie: h.cookie }, query: { user: '1 OR 1=1', module: "x'; drop" } });
    assert.equal(bad.statusCode, 200);
    assert.deepEqual(seen[1], { userId: null, module: null, page: 0, pageSize: 50 }, 'bad filters are ignored');
});

test('sidebar: every module listed (no Phase 2 placeholders), on/off states shown', async () => {
    const keys = NAV.flatMap((item) => (item.group ? item.items : [item])).map((i) => i.key);
    for (const module of MODULES) assert.ok(keys.includes(module.key), module.key);
    const h = await setup();
    const res = await get(h, 'automod');
    assert.match(res.body, /<\/svg><span class="side-text">Automod<\/span><span class="dot dot-on"><span class="sr">on<\/span><\/span><\/a>/, 'sidebar entry with the on/off dot');
});

test('security headers: CSP still without unsafe-inline; same-origin referrer policy', () => {
    assert.ok(!SECURITY_HEADERS['Content-Security-Policy'].includes('unsafe-inline'));
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /form-action 'self'/);
    assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'same-origin');
});

test('same-origin check: Origin, else Referer, else Sec-Fetch-Site; nothing → refused', () => {
    assert.equal(isSameOrigin({ headers: { origin: ORIGIN } }, ORIGIN), true);
    assert.equal(isSameOrigin({ headers: { origin: 'null' } }, ORIGIN), false);
    assert.equal(isSameOrigin({ headers: { referer: `${ORIGIN}/dashboard/automod` } }, ORIGIN), true);
    assert.equal(isSameOrigin({ headers: { referer: 'https://bot.example.evil.com/' } }, ORIGIN), false);
    assert.equal(isSameOrigin({ headers: { referer: 'not a url' } }, ORIGIN), false);
    assert.equal(isSameOrigin({ headers: { 'sec-fetch-site': 'same-origin' } }, ORIGIN), true);
    assert.equal(isSameOrigin({ headers: {} }, ORIGIN), false);
    assert.equal(isSameOrigin({ headers: { origin: ORIGIN } }, null), false);
});

test('audit helpers and the mod log route', async () => {
    assert.deepEqual(diffSnapshots({ a: 1, b: [1] }, { a: 1, b: [1, 2], c: null }), [{ key: 'b', old: [1], new: [1, 2] }]);
    assert.match(changeSummary([{ key: 'k', old: null, new: 'x'.repeat(500) }]), /^k: — → x+…$/);
    assert.equal(channelPurposeFor('dashboard'), 'modlog');
    const rows = [];
    const posts = [];
    await recordDashboardChange({
        store: { writeRows: async (...args) => rows.push(args) }, postModLog: async (...args) => posts.push(args), client: {}, guildId: GUILD,
        actor: { userId: ADMIN, username: 'a' }, module: 'tickets', moduleLabel: 'Tickets', changes: [{ key: 'k', old: 1, new: 2 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(posts[0][1], 'dashboard');
    assert.match(posts[0][3].description, /a \(200000000000000002\) changed Tickets: k: 1 → 2/);
    await recordDashboardChange({ store: { writeRows: async () => { throw new Error('db down'); } }, postModLog: async () => { throw new Error('discord down'); }, client: {}, guildId: GUILD, actor: { userId: ADMIN }, module: 'x', changes: [{ key: 'k', old: 1, new: 2 }] });
});

test('dashboardSettings: DASHBOARD_EDIT_ENABLED defaults to off', () => {
    assert.equal(dashboardSettings({ ...ENV, DASHBOARD_EDIT_ENABLED: undefined }).editEnabled, false);
    assert.equal(dashboardSettings({ ...ENV, DASHBOARD_EDIT_ENABLED: 'yes' }).editEnabled, false);
    assert.equal(dashboardSettings(ENV).editEnabled, true);
});

// ── Part 1: actions that used to need Discord ─────────────────────────────

test('tickets / verification: setup form while there is no panel, "update or re-post" once there is one', async () => {
    const h = await setup();
    let page = await get(h, 'tickets');
    assert.match(page.body, /action="\/dashboard\/tickets\/panel-publish"/);
    assert.ok(!page.body.includes('action="/dashboard/tickets/setup"'));
    h.state.tickets.ticketPanelChannelId = null;
    page = await get(h, 'tickets');
    assert.match(page.body, /action="\/dashboard\/tickets\/setup"/);
    h.state.verification.channelId = null;
    page = await get(h, 'verification');
    assert.match(page.body, /action="\/dashboard\/verification\/setup"/);
    // Owners without Administrator see the forms disabled (posting needs Administrator).
    const owner = await setup({ userId: OWNER });
    owner.state.tickets.ticketPanelChannelId = null;
    const ownerPage = await get(owner, 'tickets');
    assert.match(ownerPage.body, /Posting the panel needs Administrator/);
    assert.match(ownerPage.body, /action="\/dashboard\/tickets\/setup"[^>]*>[^]*?<fieldset disabled>/);
});

test('reaction roles: refused roles are skipped and named in the flash; the role list is a multi-select', async () => {
    const h = await setup();
    const page = await get(h, 'reaction-roles');
    assert.match(page.body, /<select name="roleIds" multiple size="\d+">/);
    const res = await post(h, 'reaction-roles', 'panel-create', { channelId: TEXT, title: 'Roles', description: 'Pick', roleIds: [ROLE_OK, ROLE_DANGER] });
    assert.equal(res.statusCode, 303);
    const call = h.calls.find((c) => c.name === 'createReactionRolePanel');
    assert.deepEqual(call.args[1], [ROLE_OK, ROLE_DANGER]);
    assert.match((await h.sessions.get(h.session.id)).flash, /Panel posted with 1 role\(s\)\. Skipped: Mods - dangerous/);
    // Junk values never reach the service.
    const junk = await setup();
    await post(junk, 'reaction-roles', 'panel-create', { channelId: TEXT, title: 'R', description: 'P', roleIds: ['x', ROLE_OK, ROLE_OK] });
    assert.deepEqual(junk.calls.find((c) => c.name === 'createReactionRolePanel').args[1], [ROLE_OK]);
});

test('tag edit: only changed fields are sent; a trigger change always carries its kind; channel lists validated', async () => {
    const h = await setup();
    h.state.tags[0] = { name: 'rules', content: 'Be nice', triggerKind: 'word', trigger: 'rules', cooldownS: 60, allowChannels: [], denyChannels: [] };
    let res = await post(h, 'community', 'tag-edit', { name: 'rules', content: 'Be nice', triggerKind: 'word', trigger: 'rules', cooldownS: '60', denyChannels: [TEXT2] });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.calls.find((c) => c.name === 'editTag').args[1], { denyChannels: [TEXT2] });
    res = await post(h, 'community', 'tag-edit', { name: 'rules', content: 'Be nice', triggerKind: 'word', trigger: 'rule', cooldownS: '60', denyChannels: [TEXT2] });
    assert.deepEqual(h.calls.filter((c) => c.name === 'editTag')[1].args[1], { trigger: 'rule', triggerKind: 'word' });
    res = await post(h, 'community', 'tag-edit', { name: 'nope', content: 'x', triggerKind: 'none' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /no such tag/);
    const page = await get(h, 'community');
    assert.match(page.body, /<details class="sub" data-key="tag-rules">/);
});

test('applications: roles listed (escaped) with their questions; [min:N] kept; delete needs the confirm box', async () => {
    const h = await setup();
    const page = await get(h, 'applications');
    assert.ok(page.body.includes('Helper &lt;b&gt;'));
    assert.ok(!page.body.includes('Helper <b>'));
    assert.match(page.body, /Why\?\nAge\? \[min:2\]<\/textarea>/);
    const res = await post(h, 'applications', 'role-update', { roleId: ROLE_OK, name: 'Helper <b>', enabled: '1', logChannelId: '', questions: 'Why? [min:5]' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.calls.find((c) => c.name === 'updateApplicationRole').args[1], { questions: [{ question: 'Why?', minLength: 5 }] });
    const unknown = await post(h, 'applications', 'role-update', { roleId: ROLE_OK2, name: 'x' });
    assert.equal(unknown.statusCode, 400);
    assert.match(unknown.body, /no longer exists/);
});

test('giveaways: start form, times as <time> for the relative display, delete asks first', async () => {
    const h = await setup();
    h.state.giveaways[0].endTime = Date.now() + 3600000;
    const page = await get(h, 'giveaways');
    assert.match(page.body, /action="\/dashboard\/giveaways\/create"/);
    assert.match(page.body, /<time datetime="[^"]+" data-relative>/);
    assert.match(page.body, /data-confirm="Delete the &quot;Nitro&quot; giveaway and its message\?"/);
});

test('destructive buttons carry data-confirm; toggles are switches with role="switch"', async () => {
    const h = await setup();
    const page = await get(h, 'applications');
    // The main switch is in the page header (no separate Status section).
    assert.match(page.body, /<div class="module-main"><form method="post" action="\/dashboard\/applications\/enabled" class="switch-form">/);
    assert.match(page.body, /role="switch" aria-checked="false"/);
    const counters = await get(h, 'counters');
    assert.match(counters.body, /data-confirm="Delete this counter and its channel\?"/);
});

// ── Modules page, module header switch, section links ─────────────────────

function modulesPageGet(h, query = {}) {
    return run(h, h.d.modulesHub, { method: 'GET', params: {}, headers: { cookie: h.cookie }, query });
}

test('Modules page: a card per settings module; state only (no switches on cards); filters', async () => {
    const h = await setup();
    const res = await modulesPageGet(h);
    assert.equal(res.statusCode, 200);
    const settings = moduleItems();
    for (const item of settings) assert.ok(res.body.includes(`href="/dashboard/${item.key}"`), item.key);
    assert.equal((res.body.match(/<li class="module-card"/g) || []).length, settings.length);
    // State only: the main switch lives in the module page header, not on the card.
    assert.ok(!res.body.includes('class="switch-form"'), 'no switches on the cards');
    assert.match(res.body, /<p class="module-state"><span class="module-state-item is-(on|off)"><span class="dot dot-(on|off)" aria-hidden="true"><\/span>(On|Off)<\/span>/);
    assert.match(res.body, /data-module-search/);
    assert.ok(!/style="|<script>/.test(res.body));
    const on = await modulesPageGet(h, { show: 'on' });
    assert.ok(!/data-state="off"/.test(on.body) && !/data-state="none"/.test(on.body));
    const off = await modulesPageGet(h, { show: 'off' });
    assert.ok(!/data-state="on"/.test(off.body));
    const junk = await modulesPageGet(h, { show: '<x>' });
    assert.equal((junk.body.match(/<li class="module-card"/g) || []).length, settings.length, 'unknown filter = all');
});

test('a switch from the Modules page returns there; any other back value goes to the module page', async () => {
    const h = await setup();
    const back = await post(h, 'automod', 'enabled', { enabled: 'false', back: 'modules' });
    assert.equal(back.statusCode, 303);
    assert.equal(back.redirectedTo, '/dashboard/modules');
    for (const value of ['https://evil.example/', '/dashboard/modules', '//evil', 'modules ']) {
        const res = await post(h, 'automod', 'enabled', { enabled: 'false', back: value });
        assert.equal(res.redirectedTo, '/dashboard/automod', value);
    }
});

test('module header: the main switch; read-only shows the on/off pill and no form', async () => {
    const h = await setup();
    const page = await get(h, 'automod');
    assert.match(page.body, /<header class="module-header">/);
    assert.match(page.body, /<div class="module-main"><form method="post" action="\/dashboard\/automod\/enabled" class="switch-form">/);
    const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    const ro = await get(off, 'automod');
    assert.match(ro.body, /<div class="module-main"><span class="state state-(on|off)">/);
    assert.ok(!ro.body.includes('action="/dashboard/automod/enabled"'));
    const mods = await modulesPageGet(off);
    assert.ok(!mods.body.includes('class="switch-form"'), 'no switches when editing is off');
});

test('"On this page" links on long module pages point at existing sections', async () => {
    const h = await setup();
    const page = await get(h, 'automod');
    const links = [...page.body.matchAll(/<a href="#(s-[a-z0-9-]+)">/g)].map((m) => m[1]);
    assert.ok(links.length >= 4, links.join());
    for (const id of links) assert.ok(page.body.includes(`id="${id}"`), id);
});

test('Overview keeps the full module states (automod etc.) next to the config-based ones', async () => {
    const h = await setup();
    const res = await run(h, h.d.overview, { method: 'GET', params: {}, headers: { cookie: h.cookie }, query: {} });
    assert.equal(res.statusCode, 200);
    // Automod's state comes from the automod service, not from the guild config.
    assert.match(res.body, /<span class="mod-name">Automod<\/span><span class="state-word is-(on|warn)">/);
    assert.match(res.body, /<li><span>Automod<\/span><span class="state-word is-on">/, 'System tile');
    assert.ok(!/0 of 0 modules/.test(res.body));
});

test('module pages list their own commands with switches that come back to the module page', async () => {
    const h = await setup();
    h.svc.getCommandAccessSnapshot = (client, config) => ({
        categories: [
            { key: 'logging', displayName: 'Logging', categoryDisabled: false, disabledCommandNames: Object.keys(config.disabledCommands || {}),
                commands: [{ name: 'logging', description: 'Set up <logs>', protected: false }] },
            { key: 'leveling', displayName: 'Leveling', categoryDisabled: true, disabledCommandNames: [],
                commands: [{ name: 'rank', description: 'Your rank', protected: false }] },
        ],
    });
    const page = await get(h, 'logging');
    assert.match(page.body, /<details class="card section" id="s-commands" data-key="commands"><summary><h2>Commands \(1\)<\/h2>/);
    assert.match(page.body, /<form method="post" action="\/dashboard\/commands\/command" class="switch-form"><input type="hidden" name="csrf" value="[^"]+">\n<input type="hidden" name="name" value="logging"><input type="hidden" name="enabled" value="false"><input type="hidden" name="back" value="logging">/);
    assert.ok(page.body.includes('Set up &lt;logs&gt;'), 'description escaped');
    const leveling = await get(h, 'leveling');
    assert.match(leveling.body, /category Leveling is off/);
    assert.ok(!leveling.body.includes('action="/dashboard/commands/command"'), 'no switch while the category is off');
    const commandsPage = await get(h, 'commands');
    assert.ok(!commandsPage.body.includes('id="s-commands"'), 'not repeated on the Commands page');
    // The switch's POST returns to the module page; unknown back values go to the Commands page.
    const back = await post(h, 'commands', 'command', { name: 'joke', enabled: 'false', back: 'logging' });
    assert.equal(back.redirectedTo, '/dashboard/logging');
    const evil = await post(h, 'commands', 'command', { name: 'joke', enabled: 'true', back: 'https://evil.example' });
    assert.equal(evil.redirectedTo, '/dashboard/commands');
});

test('Overview: recent dashboard changes (escaped), linked to the module; unavailable when the audit store fails', async () => {
    const h = await setup();
    await post(h, 'automod', 'enabled', { enabled: 'false' });
    const res = await run(h, h.d.overview, { method: 'GET', params: {}, headers: { cookie: h.cookie }, query: {} });
    assert.match(res.body, /<h2>Recent dashboard changes<\/h2><ul class="activity">/);
    assert.match(res.body, /<strong>admin&lt;b&gt;<\/strong> changed <code>[^<]+<\/code> in <a href="\/dashboard\/automod">Automod<\/a>/);
    assert.ok(res.body.includes('href="/dashboard/audit">Full audit log'));
    const { overviewPage } = await import('../src/services/dashboard/overview.js');
    const o = { checklist: [], bot: { ready: true, ping: null }, database: null, guild: null, recent: [], lockdown: undefined };
    assert.match(overviewPage({ session: { username: 'a', csrf: 't' }, overview: o, recentChanges: null }), /Recent dashboard changes<\/h2><p class="muted">Unavailable \(database\)/);
    assert.match(overviewPage({ session: { username: 'a', csrf: 't' }, overview: o, recentChanges: [] }), /No dashboard changes yet/);
});

test('top bar search: ?q= filters modules by name, one-liner or keywords (every word), escaped', async () => {
    const h = await setup();
    const find = (q) => modulesPageGet(h, { q });
    const xp = await find('xp');
    assert.equal((xp.body.match(/<li class="module-card"/g) || []).length, 1);
    assert.match(xp.body, /href="\/dashboard\/leveling"/);
    assert.match(xp.body, /1 module matches <strong>“xp”<\/strong>/);
    const two = await find('join message');
    assert.match(two.body, /href="\/dashboard\/welcome"/);
    const none = await find('<script>zzz');
    assert.ok(!none.body.includes('<script>zzz'));
    assert.match(none.body, /No module matches/);
    // The header still counts every module; the filter chips keep the search.
    assert.match(xp.body, /href="\/dashboard\/modules\?show=on&amp;q=xp"/);
});

test('Overview checklist: progress bar, open items first, done/to-do words for screen readers', async () => {
    const { overviewPage } = await import('../src/services/dashboard/overview.js');
    const o = {
        bot: { ready: true, ping: null }, database: null, guild: null, recent: [], lockdown: undefined,
        checklist: [
            { label: 'Done thing', done: true, href: '/dashboard/logging', hint: '' },
            { label: 'Open thing', done: false, href: '/dashboard/tickets', hint: 'set it <up>' },
        ],
    };
    const page = overviewPage({ session: { username: 'a', csrf: 't' }, overview: o });
    assert.match(page, /<svg class="ring"[^>]*aria-label="1 of 2 setup steps done">/, 'setup ring with a text alternative');
    assert.match(page, /stroke-dasharray="50.0 100"/);
    assert.ok(page.indexOf('Open thing') < page.indexOf('Done thing'), 'open items first');
    assert.match(page, /<span class="sr">to do:<\/span>/);
    assert.match(page, /<span class="sr">done:<\/span>/);
    assert.ok(page.includes('set it &lt;up&gt;'));
});

test('switchInput: an on/off setting is a real checkbox (name=1 when on) drawn as a switch', () => {
    const on = String(switchInput('dmOnClose', true, { label: 'DM the member' }));
    assert.match(on, /^<label class="switch-row">/);
    assert.match(on, /<input type="checkbox" class="switch-input" role="switch" name="dmOnClose" value="1" checked>/);
    assert.match(on, /<span class="switch-track" aria-hidden="true"><\/span><span class="switch-word" aria-hidden="true"><span class="w-on">On<\/span><span class="w-off">Off<\/span><\/span><\/span><\/label>$/, 'On/Off in words next to the switch');
    const off = String(switchInput('x', false, { label: '<b>', help: 'why' }));
    assert.ok(!off.includes(' checked'));
    assert.ok(off.includes('&lt;b&gt;') && off.includes('<span class="hint">why</span>'), 'label escaped, help shown');
});

test('Modules page: state line — On / Off, plus Needs setup from the Getting-started checklist', async () => {
    const { modulesPage, setupByModule } = await import('../src/services/dashboard/modulesPage.js');
    const checklist = [
        { label: 'Ticket category', done: true, href: '/dashboard/tickets' },
        { label: 'Ticket staff role', done: false, href: '/dashboard/tickets' },
        { label: 'Welcome channel', done: true, href: '/dashboard/welcome' },
        { label: 'Mod log channel', done: false, href: '/dashboard/enforcement' },
    ];
    assert.deepEqual(Object.fromEntries(setupByModule(checklist)), {
        tickets: { total: 2, todo: 1 }, welcome: { total: 1, todo: 0 }, enforcement: { total: 1, todo: 1 },
    });
    const full = String(modulesPage({ session: { username: 'a', csrf: 't' }, moduleStates: { welcome: true, tickets: true, automod: false }, checklist }));
    const page = full.slice(full.indexOf('data-module-grid'));
    const cardOf = (key) => page.slice(page.indexOf(`href="/dashboard/${key}"`), page.indexOf('</li>', page.indexOf(`href="/dashboard/${key}"`)));
    assert.match(cardOf('tickets'), /is-on"><span class="dot dot-on" aria-hidden="true"><\/span>On<\/span><span class="module-state-item is-setup"><span class="dot dot-warn" aria-hidden="true"><\/span>Needs setup · 1 to do/);
    assert.match(cardOf('welcome'), />On<\/span><\/p>/);
    assert.match(cardOf('automod'), /is-off"><span class="dot dot-off" aria-hidden="true"><\/span>Off<\/span><\/p>/, 'off wins');
    assert.match(cardOf('enforcement'), /Needs setup · 1 to do/, 'no on/off state, open setup items');
    assert.ok(!cardOf('giveaways').includes('module-state'), 'no state and no checklist items: no line');
    assert.ok(!String(modulesPage({ session: { username: 'a', csrf: 't' } })).match(/is-setup/), 'no checklist: no setup info');
});

test('a refused form shows its error inside that form and marks the field', async () => {
    const { placeFormError } = await import('../src/services/dashboard/pages.js');
    const { html } = await import('../src/services/dashboard/html.js');
    const body = html`<form method="post" action="/dashboard/tickets/settings" class="settings-form"><label>Max<input name="maxTicketsPerUser" value="99"></label></form><form method="post" action="/dashboard/tickets/other"></form>`;
    const out = String(placeFormError(body, { moduleKey: 'tickets', action: 'settings', field: 'maxTicketsPerUser', message: 'Max must be between 1 and 10 <b>' }));
    assert.ok(out.startsWith('<form method="post" action="/dashboard/tickets/settings" class="settings-form"><p class="error form-error" role="alert" id="form-error">Not saved: Max must be between 1 and 10 &lt;b&gt;</p>'));
    assert.ok(out.includes('name="maxTicketsPerUser" aria-invalid="true" aria-describedby="form-error"'));
    assert.equal(placeFormError(body, { moduleKey: 'tickets', action: 'nope', message: 'x' }), null, 'form not on the page: the caller shows it at the top');
    assert.equal(placeFormError(body, { moduleKey: 'tickets', action: '', message: 'x' }), null);
});

test('text fields never cut silently: over the limit is refused, naming the field', async () => {
    const { text, InputError } = await import('../src/services/dashboard/forms.js');
    assert.equal(text({ a: '  hi  ' }, 'a', 5), 'hi');
    assert.equal(text({ a: 'x'.repeat(5) }, 'a', 5), 'xxxxx');
    assert.throws(() => text({ a: 'x'.repeat(6) }, 'a', 5), (e) => e instanceof InputError && e.field === 'a' && /at most 5 characters \(6 entered\)/.test(e.userMessage));
});

test('audit log: a long value shows its start; the rest is behind "Show all", nothing dropped', async () => {
    const { auditPage } = await import('../src/services/dashboard/pages.js');
    const long = 'y'.repeat(300);
    const page = String(auditPage({ session: { username: 'a', csrf: 't' }, rows: [{ created_at: new Date(0), username: 'a', user_id: '1', module: 'welcome', key: 'message', old: 'short', new: long }] }));
    assert.ok(page.includes(`<details class="long-value"><summary>${'y'.repeat(120)}… <span class="muted">Show all (300 characters)</span></summary><div class="long-value-full">${long}</div></details>`));
    assert.ok(page.includes('<td class="value">short</td>'));
});

test('Find a setting: also matches a module\'s setup steps (e.g. "category" finds Tickets and Enforcement)', async () => {
    const { modulesPage } = await import('../src/services/dashboard/modulesPage.js');
    const checklist = [{ label: 'Ticket staff role', done: false, href: '/dashboard/tickets' }, { label: 'Birthday channel', done: false, href: '/dashboard/birthdays' }];
    const keys = (q) => [...String(modulesPage({ session: { username: 'a', csrf: 't' }, q, checklist })).matchAll(/class="module-card-name"><a href="\/dashboard\/([a-z-]+)"/g)].map((m) => m[1]);
    assert.deepEqual(keys('category'), ['tickets', 'enforcement', 'support'], 'keywords (sidebar order)');
    assert.deepEqual(keys('birthday channel'), ['birthdays'], 'setup step label');
    assert.deepEqual(keys('ticket staff role'), ['tickets'], 'every word must match');
});

// ── Channel tools (purge, lock, unlock) ───────────────────────────────────

test('channel tools: every action is Administrator-only; an OWNER_IDS user without Administrator changes nothing', async () => {
    const module = MODULES.find((m) => m.key === 'channels');
    for (const action of Object.keys(module.actions)) {
        assert.equal(getAction(module, action).admin, true, `channels/${action} admin`);
        const owner = await setup({ userId: OWNER });
        const res = await post(owner, 'channels', action, CASES.channels[action].form);
        assert.equal(res.statusCode, 403);
        assert.deepEqual(owner.guild.channels.cache.get(TEXT).deletedIds, []);
        assert.deepEqual(owner.guild.channels.cache.get(TEXT).edits, []);
    }
    const owner = await setup({ userId: OWNER });
    const page = await get(owner, 'channels');
    assert.match(page.body, /need Administrator in the main server/);
    assert.ok(!page.body.includes('>Delete messages<'), 'no purge button for an owner');
});

test('channel tools: refused clearly when the bot lacks Manage Messages / Manage Channels; nothing changes', async () => {
    const h = await setup();
    h.guild.members.me.permissionsIn = () => ({ has: (bit) => bit === 1n << 10n }); // View Channel only
    const purge = await post(h, 'channels', 'purge', CASES.channels.purge.form);
    assert.equal(purge.statusCode, 400);
    assert.match(purge.body, /missing Read Message History, Manage Messages in #general/);
    const lock = await post(h, 'channels', 'lock', CASES.channels.lock.form);
    assert.equal(lock.statusCode, 400);
    assert.match(lock.body, /missing Manage Channels, Manage Permissions in #general/);
    const text = h.guild.channels.cache.get(TEXT);
    assert.deepEqual([text.deletedIds, text.edits, h.state.logEvents, h.auditRows], [[], [], [], []]);
});

test('channel tools: purge limits (1–100), confirm box required, user filter, 14-day messages skipped', async () => {
    const h = await setup();
    for (const amount of ['0', '101', 'x']) {
        const res = await post(h, 'channels', 'purge', { channelId: TEXT, amount, confirm: '1' });
        assert.equal(res.statusCode, 400, `amount ${amount}`);
    }
    const noConfirm = await post(h, 'channels', 'purge', { channelId: TEXT, amount: '5' });
    assert.equal(noConfirm.statusCode, 400);
    assert.match(noConfirm.body, /Tick the box/);
    const badUser = await post(h, 'channels', 'purge', { channelId: TEXT, amount: '5', userId: 'bob', confirm: '1' });
    assert.match(badUser.body, /must be a Discord user ID/);
    const text = h.guild.channels.cache.get(TEXT);
    assert.deepEqual(text.deletedIds, [], 'nothing deleted by refused forms');

    const res = await post(h, 'channels', 'purge', { channelId: TEXT, amount: '5', userId: MEMBER, reason: 'spam', confirm: '1' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(text.deletedIds, ['800000000000000001', '800000000000000003'], 'only the member\'s recent messages');
    assert.match((await h.sessions.get(h.session.id)).flash, /Deleted 2 messages in #general\. 1 message was older than 14 days and skipped\./);
    assert.equal(h.state.logEvents.length, 1);
    assert.equal(h.state.logEvents[0].event.action, 'Messages Purged');
    assert.match(h.state.logEvents[0].event.reason, /Dashboard \(admin<b>\): spam/);
    assert.equal(h.auditRows[0].key, `purge.${TEXT}`);

    const onlyOld = await post(h, 'channels', 'purge', { channelId: TEXT, amount: '5', userId: MEMBER, confirm: '1' });
    assert.equal(onlyOld.statusCode, 400);
    assert.match(onlyOld.body, /older than 14 days/);
});

test('channel tools: lock then unlock round trip (overwrite, audit reason, log events, locked list)', async () => {
    const h = await setup();
    const text = h.guild.channels.cache.get(TEXT);
    assert.match((await get(h, 'channels')).body, /Locked channels \(0\)/);
    assert.equal((await post(h, 'channels', 'lock', { channelId: TEXT, reason: 'raid' })).statusCode, 303);
    assert.deepEqual(text.edits[0], { target: GUILD, patch: { SendMessages: false }, options: { type: 0, reason: 'Dashboard (admin<b>): raid' } });
    const page = await get(h, 'channels');
    assert.match(page.body, /Locked channels \(1\)/);
    assert.match(page.body, /action="\/dashboard\/channels\/unlock"/);
    const again = await post(h, 'channels', 'lock', { channelId: TEXT });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /already locked/);

    assert.equal((await post(h, 'channels', 'unlock', { channelId: TEXT })).statusCode, 303);
    assert.deepEqual(text.edits[1], { target: GUILD, patch: { SendMessages: null }, options: { type: 0, reason: 'Dashboard (admin<b>)' } });
    assert.match((await get(h, 'channels')).body, /Locked channels \(0\)/);
    const notLocked = await post(h, 'channels', 'unlock', { channelId: TEXT });
    assert.equal(notLocked.statusCode, 400);
    assert.match(notLocked.body, /is not locked/);
    assert.deepEqual(h.state.logEvents.map((e) => e.event.action), ['Channel Locked', 'Channel Unlocked']);
    assert.deepEqual(h.auditRows.map((r) => [r.key, r.old, r.new]), [[`lock.${TEXT}`, false, true], [`lock.${TEXT}`, true, false]]);
});

// ── Messages (post as the bot) ────────────────────────────────────────────

test('messages: every action is Administrator-only; the page has the three forms, disabled for OWNER_IDS without Administrator', async () => {
    const module = MODULES.find((m) => m.key === 'messages');
    for (const name of ['send', 'poll', 'countdown']) assert.equal(getAction(module, name).admin, true, `${name} is admin-only`);
    const h = await setup();
    const page = await get(h, 'messages');
    assert.equal(page.statusCode, 200);
    for (const action of ['send', 'poll', 'countdown']) assert.ok(page.body.includes(`action="/dashboard/messages/${action}"`), `${action} form`);
    assert.match(page.body, /never ping/);
    const owner = await setup({ userId: OWNER });
    const ownerPage = await get(owner, 'messages');
    assert.equal((ownerPage.body.match(/<fieldset disabled>/g) || []).length, 3, 'owner: all three forms disabled');
    assert.match(ownerPage.body, /Posting needs Administrator/);
});

test('messages/send: text, embed and colour reach the service; hex colour wins; bad hex and footer-only embeds are refused', async () => {
    const h = await setup();
    assert.equal((await post(h, 'messages', 'send', CASES.messages.send.form)).statusCode, 303);
    const [channelId, content, embed] = h.calls.find((c) => c.name === 'postBotMessage').args;
    assert.equal(channelId, TEXT);
    assert.equal(content, 'Hello @everyone');
    assert.equal(embed.description, 'Line 1\nLine 2', 'line breaks normalised');
    assert.equal(embed.colour, 0x9B59B6);
    assert.ok(h.auditRows.some((r) => r.key === 'message.710000000000000011' && r.new.embed.colour === '#9b59b6'));

    const hex = await setup();
    await post(hex, 'messages', 'send', { channelId: TEXT, content: 'hi', colour: 'red', hex: '#00ff00' });
    assert.equal(hex.calls.find((c) => c.name === 'postBotMessage').args[2], null, 'no embed fields: text only');
    await post(hex, 'messages', 'send', { channelId: TEXT, title: 't', hex: '00ff00' });
    assert.equal(hex.calls.filter((c) => c.name === 'postBotMessage')[1].args[2].colour, 0x00ff00);

    for (const [form, message] of [
        [{ channelId: TEXT, title: 't', hex: 'green' }, /hex code/],
        [{ channelId: TEXT, footer: 'only a footer' }, /footer alone/],
        [{ channelId: TEXT }, /nothing to post/],
        [{ channelId: VOICE, content: 'x' }, /must be a text channel/],
        [{ channelId: TEXT, content: 'x'.repeat(2001) }, /at most 2000 characters/],
        [{ channelId: TEXT, title: 'x', imageUrl: 'javascript:alert(1)' }, /https:\/\/ link/],
        [{ channelId: TEXT, title: 'x', imageUrl: 'https://user:pw@example.com/a.png' }, /https:\/\/ link/],
    ]) {
        const r = await setup();
        const res = await post(r, 'messages', 'send', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form));
        assert.match(res.body, message);
        assert.ok(!r.calls.some((c) => c.name === 'postBotMessage'), 'nothing posted');
    }
});

test('messages: a channel where the bot lacks a permission is refused clearly, nothing posted', async () => {
    const { PermissionFlagsBits } = await import('discord.js');
    const h = await setup();
    h.guild.members.me.permissionsIn = () => ({ has: (p) => p !== PermissionFlagsBits.EmbedLinks });
    const res = await post(h, 'messages', 'send', { channelId: TEXT, content: 'hi' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /I am missing Embed Links in #general\. Nothing was posted\./);
    assert.ok(!h.calls.some((c) => c.name === 'postBotMessage'));

    const p = await setup();
    p.guild.members.me.permissionsIn = () => ({ has: (perm) => perm !== PermissionFlagsBits.AddReactions });
    assert.equal((await post(p, 'messages', 'countdown', CASES.messages.countdown.form)).statusCode, 303, 'countdown needs no reactions');
    const poll = await post(p, 'messages', 'poll', CASES.messages.poll.form);
    assert.equal(poll.statusCode, 400);
    assert.match(poll.body, /missing Add Reactions/);
    assert.ok(!p.calls.some((c) => c.name === 'createPoll'));
});

test('messages/poll and countdown: options one per line, anonymous switch, reaction shortfall in the flash; duration limits', async () => {
    const h = await setup();
    await post(h, 'messages', 'poll', CASES.messages.poll.form);
    assert.deepEqual(h.calls.find((c) => c.name === 'createPoll').args, [TEXT, 'Pizza?', ['Yes', 'No', 'Maybe'], true]);
    const few = await setup();
    few.state.pollReactions = 1;
    await post(few, 'messages', 'poll', CASES.messages.poll.form);
    assert.match((await few.sessions.get(few.session.id)).flash, /Only 1 of 3 vote reactions/);
    const many = await setup();
    const res = await post(many, 'messages', 'poll', { channelId: TEXT, question: 'Q', options: Array.from({ length: 11 }, (_, i) => `o${i}`).join('\n') });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /at most 10 options/);

    const c = await setup();
    await post(c, 'messages', 'countdown', CASES.messages.countdown.form);
    assert.deepEqual(c.calls.find((x) => x.name === 'startCountdownMessage').args, [TEXT, 150, 'Launch']);
    const long = await setup();
    const tooLong = await post(long, 'messages', 'countdown', { channelId: TEXT, minutes: '1440', seconds: '1' });
    assert.equal(tooLong.statusCode, 400);
    assert.match(tooLong.body, /longer than 24 hours/);
});
