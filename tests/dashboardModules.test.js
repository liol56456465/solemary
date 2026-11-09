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
import { resolveLogChannel } from '../src/services/loggingService.js';
import { storeWelcomeImage } from '../src/utils/welcomeImageStore.js';
import { BacktestError } from '../src/services/automod/backtest.js';
import { FIELD_LEVEL, NOT_PRIVILEGED } from './helpers/privilegedActions.js';
import { derivedTemplateId } from '../src/services/enforcement/templateService.js';

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
const POLL_LINK = `https://discord.com/channels/${'100000000000000001'}/${'500000000000000001'}/710000000000000015`;
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
        lockdown: null,
        probations: { [MEMBER]: { startedAt: Date.now() - 1000, until: Date.now() + 86400000, caseCode: 'abc234x', how: 'expired' } },
        reviews: [{ title: 'Excessive caps <b>', url: `https://discord.com/channels/${GUILD}/${TEXT}/700000000000000010`, at: Date.now() - 60000, count: 3 },
            { title: 'Bad link', url: 'javascript:alert(1)', at: Date.now() - 120000, count: 1 }],
        logging: { enabled: false, channels: { audit: null, applications: null, reports: null }, ignore: { channels: [TEXT2], roles: [], users: [] }, enabledEvents: {} },
        welcome: { enabled: false, channelId: null, welcomeMessage: 'Welcome {user}', welcomePing: false, dmMessage: '', goodbyeEnabled: false, goodbyeChannelId: null, leaveMessage: 'Bye', goodbyePing: false, roleIds: [ROLE_OK], autoRoleDelay: 0, joinLogs: { enabled: false, channelId: null }, leaveLogs: { enabled: false, channelId: null } },
        tickets: { ticketCategoryId: null, ticketClosedCategoryId: null, ticketStaffRoleId: null, maxTicketsPerUser: 3, dmOnClose: true, ticketLogsChannelId: null, ticketTranscriptChannelId: null, ticketPanelMessage: 'Open a ticket', ticketButtonLabel: 'Create Ticket', ticketPanelChannelId: TEXT },
        config: { modmailBlocked: [MEMBER], disabledCommands: {}, disabledCategories: {}, birthdayChannelId: null, birthdayTimezone: 'UTC', birthdayRoleId: null },
        canned: { 'appeal-received': 'built in', mine: '<img src=x onerror=1>' },
        // Ticket ratings (v14): a member's comment is escaped like any other value.
        ticketRatings: {
            byStaff: [{ staffId: '300000000000000099', avg: 4.5, count: 2 }], byPriority: [{ kind: 'ticket', priority: 'high', avg: 4.5, count: 2 }],
            trend: [{ week: '2026-11-02', avg: 4.5, count: 2 }, { week: '2026-11-09', avg: null, count: 0 }],
            response: { prompted: 3, rated: 2, pending: 1, rate: 2 / 3 },
            low: [{ kind: 'ticket', ticket_number: '012', staff_id: '300000000000000099', rating: 1, rated_at: new Date('2026-11-03T10:00:00Z'), comment: '<img src=x onerror=2>', comment_flagged: true }],
        },
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
        scheduled: [
            { id: 1, guildId: GUILD, channelId: TEXT, payload: { content: 'Daily <b>reminder</b>', embed: null }, schedule: { kind: 'weekly', time: '09:00', days: [1, 3, 5] },
                timezone: 'Europe/Vilnius', nextRunAt: Date.now() + 3600000, lastRunAt: Date.now() - 86400000, lastError: null, failureCount: 0, paused: false, createdBy: ADMIN },
            { id: 2, guildId: GUILD, channelId: TEXT2, payload: { content: '', embed: { title: 'News', description: '', imageUrl: '', footer: '', colour: 0x9b59b6 } },
                schedule: { kind: 'interval', date: '2026-01-01', time: '08:00', hours: 6 }, timezone: 'UTC', nextRunAt: Date.now() + 7200000, lastRunAt: Date.now() - 60000,
                lastError: 'I am missing Send Messages in #x. Nothing was posted.', failureCount: 3, paused: true, createdBy: ADMIN },
        ],
        appRoles: [{ roleId: ROLE_OK, name: 'Helper <b>', enabled: true, questions: ['Why?', { question: 'Age?', minLength: 2 }], logChannelId: null }],
        submitted: [
            { id: '1700000000000-abc', userId: MEMBER, username: 'member<b>', roleId: ROLE_OK, roleName: 'Helper <b>', status: 'pending', createdAt: '2026-10-01T10:00:00.000Z', answers: [{ question: 'Why?', answer: 'I like <i>cats</i>' }] },
            { id: '1600000000000-old', userId: STRANGER, username: 'stranger', roleId: ROLE_OK, roleName: 'Helper <b>', status: 'denied', createdAt: '2026-09-01T10:00:00.000Z', reviewedAt: '2026-09-02T10:00:00.000Z', reviewMessage: 'Not now', answers: [] },
        ],
        suggestions: [
            { id: 4, guild_id: GUILD, user_id: MEMBER, content: 'More <b>cats</b>', status: 'pending', status_reason: null, upvotes: 3, downvotes: 1, channel_id: TEXT, message_id: '710000000000000010', created_at: new Date('2026-10-01T00:00:00Z') },
        ],
        modmailOpen: {},
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
        updateSettings: async (guildId, patchOrBuild, actor) => {
            // Like guildSettings.updateSettings: a build function gets the current values (the real one holds the row lock).
            const patch = typeof patchOrBuild === 'function' ? await patchOrBuild((key) => clone(svc.getSetting(guildId, key))) : patchOrBuild;
            record('updateSettings', [guildId, patch, actor]);
            if (!patch || !Object.keys(patch).length) return { changes: [], settings: {} };
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
        automodRuleStats: async (guildId, days) => { s.statsDays = days; return {}; },
        // Automod test run (backtest.js): s.backtest is the job snapshot; s.backtestRefuse makes start refuse.
        startAutomodBacktest: (params) => {
            record('startAutomodBacktest', [params]);
            if (s.backtestRefuse) throw new BacktestError(s.backtestRefuse);
            s.backtest = { guildId: params.guild.id, status: 'running', startedAt: Date.now(), finishedAt: null, params: { channelIds: params.channelIds, days: params.days, automodEnabled: true, draft: null }, progress: { read: 0 }, result: null, error: null };
            return clone(s.backtest);
        },
        getAutomodBacktest: () => {
            if (s.backtestReadFails) throw new Error('state gone');
            return s.backtest ? clone(s.backtest) : null;
        },
        getLockdownState: async () => clone(s.lockdown),
        endLockdown: async (guild, admin) => {
            record('endLockdown', [admin]);
            if (!s.lockdown?.active) return false;
            s.lockdown = null;
            return true;
        },
        collectOpenReviews: async () => clone(s.reviews),
        listProbations: async () => Object.entries(s.probations).map(([userId, p]) => ({ userId, ...p })),
        endProbation: async (guildId, userId) => {
            record('endProbation', [userId]);
            const existing = s.probations[userId] || null;
            delete s.probations[userId];
            return existing;
        },
        getLoggingStatus: async () => clone(s.logging),
        setLoggingEnabled: async (c, g, enabled) => { record('setLoggingEnabled', [enabled]); s.logging.enabled = enabled; return true; },
        setLogChannel: async (c, g, dest, id) => { record('setLogChannel', [dest, id]); s.logging.channels[dest] = id; return true; },
        toggleEventLogging: async (c, g, types, on) => { record('toggleEventLogging', [types, on]); for (const t of types) s.logging.enabledEvents[t] = on; return true; },
        setLogChannels: async (c, g, wanted) => {
            record('setLogChannels', [wanted]);
            const changes = [];
            for (const [destination, id] of Object.entries(wanted)) {
                const old = s.logging.channels[destination] || null;
                if ((id || null) === old) continue;
                s.logging.channels[destination] = id || null;
                changes.push({ destination, old, new: id || null });
            }
            return changes;
        },
        updateEventLogging: async (c, g, plan) => {
            const steps = await plan(clone(s.logging.enabledEvents));
            record('updateEventLogging', [steps]);
            for (const step of steps) for (const t of step.types) s.logging.enabledEvents[t] = step.enabled;
            return steps;
        },
        updateIgnoreList: async (c, g, { action, type, id }) => { record('updateIgnoreList', [action, type, id]); const k = `${type}s`; s.logging.ignore[k] = action === 'add' ? [...s.logging.ignore[k], id] : s.logging.ignore[k].filter((x) => x !== id); return true; },
        getWelcomeSettings: async () => clone(s.welcome),
        // The /greet image store itself, on the fake guild (its channel.send is recorded by withImageStore).
        resolveLogChannel,
        storeWelcomeImage: async (guild, attachment, channelIds, label, ...options) => { record('storeWelcomeImage', [attachment, channelIds, label, ...options]); return storeWelcomeImage(guild, attachment, channelIds, label, ...options); },
        // Bot in this server (appearance.js): the server owner's plan, and the two Discord calls.
        guildPlan: () => s.plan ?? 'pro',
        setBotNickname: async (guild, nick) => { record('setBotNickname', [nick]); },
        setBotAvatar: async (client, guildId, dataUri) => { record('setBotAvatar', [dataUri ? dataUri.slice(0, 22) : null]); },
        resolveWelcomeImageUrl: async (c, url, ref) => (ref ? `${ref.url}&fresh=1` : url),
        updateWelcomeSettings: async (c, g, patch) => { record('updateWelcomeSettings', [patch]); return merge('welcome', patch); },
        addAutoRole: async (c, g, roleId) => { record('addAutoRole', [roleId]); const before = clone(s.welcome); const changed = !s.welcome.roleIds.includes(roleId); s.welcome.roleIds = [roleId]; return { before, after: clone(s.welcome), changed }; },
        removeAutoRole: async (c, g, roleId) => { record('removeAutoRole', [roleId]); const before = clone(s.welcome); const changed = s.welcome.roleIds.includes(roleId); s.welcome.roleIds = s.welcome.roleIds.filter((x) => x !== roleId); return { before, after: clone(s.welcome), changed }; },
        getTicketSettings: async () => clone(s.tickets),
        ticketRatingDashboard: async () => clone(s.ticketRatings),
        updateTicketSettings: async (c, g, patch) => { record('updateTicketSettings', [patch]); return merge('tickets', patch); },
        setModmailBlocked: async (c, g, id, blocked) => { record('setModmailBlocked', [id, blocked]); s.config.modmailBlocked = blocked ? [...new Set([...s.config.modmailBlocked, id])] : s.config.modmailBlocked.filter((x) => x !== id); },
        findModmailChannel: async (guild, id) => s.modmailOpen[id] || null,
        isBuiltInCanned: (name) => name === 'appeal-received',
        listCanned: async () => clone(s.canned),
        saveCanned: async (g, name, text) => { record('saveCanned', [name, text]); s.canned[name] = text; },
        removeCanned: async (g, name) => { record('removeCanned', [name]); if (name === 'appeal-received' || !s.canned[name]) return false; delete s.canned[name]; return true; },
        getServerCat: async () => {
            if (s.catFails) throw new Error('db down');
            return { name: svc.getSetting(GUILD, 'catName'), image: 'young-happy.png', stage: { key: 'young', name: 'Young cat' }, mood: 'happy',
                sentence: `${svc.getSetting(GUILD, 'catName')} is happy: the server was busier this week.`, total: 4321 };
        },
        getLevelingConfig: async () => clone(s.leveling),
        updateLevelingConfig: async (c, g, patch) => { record('updateLevelingConfig', [patch]); return merge('leveling', patch); },
        updateVoiceXpConfig: async (c, g, patch) => {
            record('updateVoiceXpConfig', [patch]);
            const before = clone(s.leveling);
            s.leveling.voice = { ...(s.leveling.voice || {}), ...clone(patch) };
            return { before, after: clone(s.leveling) };
        },
        updateLevelIgnoreList: async (c, g, field, action, id) => {
            record('updateLevelIgnoreList', [field, action, id]);
            const before = clone(s.leveling);
            const list = s.leveling[field] || [];
            const changed = action === 'add' ? !list.includes(id) : list.includes(id);
            if (changed) s.leveling[field] = action === 'add' ? [...list, id] : list.filter((x) => x !== id);
            return { before, after: clone(s.leveling), changed };
        },
        setLevelRoleReward: async (c, g, level, roleId) => { record('setLevelRoleReward', [level, roleId]); const before = clone(s.leveling); if (roleId) s.leveling.roleRewards[level] = roleId; else delete s.leveling.roleRewards[level]; return { before, after: clone(s.leveling) }; },
        setLevelBoost: async (c, g, kind, id, multiplier) => {
            record('setLevelBoost', [kind, id, multiplier]);
            const field = kind === 'channel' ? 'channelMultipliers' : 'roleMultipliers';
            const before = clone(s.leveling);
            const map = { ...(s.leveling[field] || {}) };
            if (multiplier === null) delete map[id]; else map[id] = multiplier;
            s.leveling[field] = map;
            return { before, after: clone(s.leveling), field };
        },
        syncLevelRolesForMember: async (c, member, options) => {
            record('syncLevelRolesForMember', [options]);
            if (s.levelSyncFails) throw new Error('db down');
            return s.levelSync ?? { added: [], removed: [], skipped: [], errors: 0 };
        },
        getUserLevelData: async (c, g, id) => ({ level: s.levels[id] ?? 0 }),
        addLevels: async (c, g, id, n) => { record('addLevels', [id, n]); s.levels[id] = (s.levels[id] ?? 0) + n; },
        removeLevels: async (c, g, id, n) => { record('removeLevels', [id, n]); s.levels[id] = Math.max(0, (s.levels[id] ?? 0) - n); },
        setUserLevel: async (c, g, id, n) => { record('setUserLevel', [id, n]); s.levels[id] = n; },
        getVerificationSettings: async () => clone(s.verification),
        updateVerificationSettings: async (c, g, patch) => {
            record('updateVerificationSettings', [patch]);
            const before = clone(s.verification);
            const { autoVerify, quiz, ...rest } = patch;
            Object.assign(s.verification, rest);
            if (autoVerify) Object.assign(s.verification.autoVerify, autoVerify);
            if (quiz) s.verification.quiz = { ...(s.verification.quiz || {}), ...clone(quiz) };
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
        // Rules post (rulesPost.js): records the built messages; s.rulesPostFails makes Discord refuse.
        postRulesMessages: async (guild, channel, messages) => {
            record('postRulesMessages', [channel.id, messages]);
            if (s.rulesPostFails) throw new Error('Missing Access');
            return messages.map((m, i) => `71000000000000010${i}`);
        },
        updateRulesMessages: async (guild, posted, messages) => {
            record('updateRulesMessages', [posted, messages]);
            if (s.rulesPostGone) throw userErr('One of the posted rules messages was deleted in #general. Use Post to send a new copy.', 'validation');
            const message = (id) => ({ id, delete: async () => { s.rulesDeleted = [...(s.rulesDeleted || []), id]; } });
            const ids = messages.map((m, i) => `71000000000000020${i}`);
            return { channel: guild.channels.cache.get(posted.channelId), ids, added: ids.map(message), leftovers: (s.rulesLeftovers || []).map(message) };
        },
        postBotMessage: async (guild, { channel, content, embed, ping = null, buttons = [] }) => {
            record('postBotMessage', [channel.id, content, embed, ping, buttons]);
            return { message: { id: '710000000000000011' } };
        },
        createPoll: async (guild, { channel, question, options, anonymous }) => {
            record('createPoll', [channel.id, question, options, anonymous]);
            return { message: { id: '710000000000000012' }, reacted: s.pollReactions ?? options.length };
        },
        createNativePoll: async (guild, { channel, question, options, durationHours, multiSelect }) => {
            record('createNativePoll', [channel.id, question, options, durationHours, multiSelect]);
            return { message: { id: '710000000000000015' }, endsAt: Date.UTC(2026, 10, 4, 12, 0) };
        },
        endPoll: async (guild, link) => {
            record('endPoll', [link]);
            if (s.endPollError) throw userErr(s.endPollError, 'validation');
            return { message: { id: '710000000000000016' }, channel: guild.channels.cache.get(TEXT), question: 'Pizza?' };
        },
        listScheduledMessages: async () => clone(s.scheduled),
        createScheduledMessage: async (input) => {
            record('createScheduledMessage', [input]);
            const row = { id: 3, ...clone(input), nextRunAt: Date.now() + 3600000, lastRunAt: null, lastError: null, failureCount: 0, paused: false };
            s.scheduled.push(row);
            return clone(row);
        },
        updateScheduledMessage: async (g, id, patch) => {
            record('updateScheduledMessage', [id, patch]);
            const row = s.scheduled.find((m) => m.id === id);
            const before = clone(row);
            Object.assign(row, clone(patch), { failureCount: 0, lastError: null });
            return { before, after: clone(row) };
        },
        setScheduledMessagePaused: async (g, id, paused) => {
            record('setScheduledMessagePaused', [id, paused]);
            const row = s.scheduled.find((m) => m.id === id);
            const before = clone(row);
            row.paused = paused;
            return { before, after: clone(row) };
        },
        sendScheduledTest: async (client, userId, payload) => { record('sendScheduledTest', [userId, payload]); },
        runScheduledMessageNow: async (guild, id) => {
            record('runScheduledMessageNow', [id]);
            const row = s.scheduled.find((m) => m.id === id);
            return { row: clone(row), message: { id: '710000000000000014' }, channel: guild.channels.cache.get(row.channelId) };
        },
        deleteScheduledMessage: async (g, id) => {
            record('deleteScheduledMessage', [id]);
            const row = s.scheduled.find((m) => m.id === id);
            s.scheduled = s.scheduled.filter((m) => m.id !== id);
            return row ? clone(row) : null;
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
        getApplications: async () => clone(s.submitted),
        reviewApplicationAndNotify: async (c, guild, id, { action, reason, reviewerId }) => {
            record('reviewApplicationAndNotify', [id, action, reason, reviewerId]);
            const app = s.submitted.find((a) => a.id === id);
            if (!app) throw userErr('Application not found.', 'user_input');
            if (app.status !== 'pending') throw userErr('This application has already been reviewed.', 'validation');
            app.status = action === 'approve' ? 'approved' : 'denied';
            return { application: clone(app), status: app.status, reason: reason || 'No reason provided.', dmDelivered: !s.dmFails, logUpdated: true, roleAdded: action === 'approve' ? !s.roleFails : null };
        },
        listOpenSuggestions: async () => clone(s.suggestions.filter((x) => x.status === 'pending' || x.status === 'considering')),
        getSuggestion: async (g, id) => clone(s.suggestions.find((x) => x.id === id) || null),
        decideSuggestion: async ({ suggestionId, status, reason, decidedBy }) => {
            record('decideSuggestion', [suggestionId, status, reason, decidedBy]);
            const row = s.suggestions.find((x) => x.id === suggestionId);
            if (!row) return null;
            Object.assign(row, { status, status_reason: reason || null, decided_by: decidedBy });
            return { row: clone(row), edited: true, dmed: !s.dmFails };
        },
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
        // Bot settings (/configwizard), random member (/tools randomuser), short links (/shorten).
        updateConfigSetting: async (c, g, key, value) => { record('updateConfigSetting', [key, value]); s.config[key] = value; },
        pickRandomMember: async (guild, filters) => {
            record('pickRandomMember', [filters]);
            if (filters.roleId === ROLE_OK2) throw userErr('No users have the **Helper** role.\n\nTry adjusting your filters.', 'user_input');
            return { member: { id: MEMBER, user: { username: 'member<b>' } }, poolSize: 3 };
        },
        // Invite tracking (Invites page): read-only cards (an escaped name, a code) and the warm-up after turning on.
        getInvitePageData: async () => ({
            canRead: false, cacheStatus: null,
            leaderboard: [{ rank: 1, userId: MEMBER, invited: 3, left: 1, fake: 0, bonus: 2, total: 4 }],
            recent: [{ userId: STRANGER, inviterId: MEMBER, code: 'abc<b>', source: 'invite', joinedAt: new Date('2026-11-01T10:00:00Z'), leftAt: null, counted: true, fake: false }],
            codes: [{ code: 'abc', inviterId: MEMBER, uses: 3, maxUses: 0, deleted: false }],
        }),
        warmInviteCache: (guild) => { record('warmInviteCache', [guild?.id]); },
        shortenUrl: async (url, custom) => {
            record('shortenUrl', [url, custom]);
            if (!/^https?:\/\//.test(url)) throw userErr('Invalid URL format. Include http:// or https://', 'validation');
            if (custom === 'down') throw userErr('Unable to reach the URL shortener service right now. Please try again later.', 'network');
            return 'https://is.gd/abc123';
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
        setHeadsUp: automodSet('setHeadsUp', (rule, v) => { s.automod.headsUp = { ...(s.automod.headsUp || {}), [rule]: v }; }),
        headsUpStats: async (guildId, opts) => { s.headsUpDays = opts?.days; if (s.headsUpStatsFail) throw new Error('db down'); return { days: opts?.days, sent: 7, fixed: 5, acted: 2 }; },
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

function post(h, module, action, form, { origin = ORIGIN, csrf = h.session.csrf, headers = {}, upload = null } = {}) {
    return run(h, h.d.moduleAction, {
        method: 'POST', params: { module, action },
        headers: { cookie: h.cookie, ...(origin ? { origin } : {}), ...headers },
        body: { ...(csrf === null ? {} : { csrf }), ...form },
        // As parseMultipart leaves it for an upload action (the multipart path is tested on its own).
        ...(upload ? { upload } : {}),
    });
}

/** post; for an action with a confirm page, then Confirm with that page's one-time token. */
async function postConfirmed(h, module, action, form, opts = {}) {
    const first = await post(h, module, action, form, opts);
    const token = /name="token" value="([^"]+)"/.exec(String(first.body || ''))?.[1];
    if (first.statusCode !== 200 || !token) return first;
    const fh = /name="fh" value="([^"]+)"/.exec(first.body)[1];
    return post(h, module, action, { token, fh }, opts);
}

const tokenOf = (body) => ({ token: /name="token" value="([^"]+)"/.exec(body)?.[1], fh: /name="fh" value="([^"]+)"/.exec(body)?.[1] });

// ── image uploads (Welcome & goodbye) ─────────────────────────────────────

const BOUNDARY = '----mewvoWelcomeBoundary';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const STORED_URL = 'https://cdn.discordapp.com/attachments/500000000000000001/800000000000000099/welcome-image.png?ex=ffffffff&is=1&hm=1';

/** An audit log channel (TEXT) where the bot can post: its sends are recorded, as the stored message. */
function withImageStore(state, guild) {
    state.config.logging = { channels: { audit: TEXT } };
    const channel = guild.channels.cache.get(TEXT);
    channel.sent = [];
    channel.deleted = [];
    channel.isTextBased = () => true;
    channel.send = async (payload) => {
        channel.sent.push(payload);
        const name = payload.files?.[0]?.name || 'image.png';
        return { id: '800000000000000099', attachments: { first: () => ({ url: STORED_URL.replace('welcome-image.png', name) }) } };
    };
    channel.messages.delete = async (id) => { channel.deleted.push(id); };
    return channel;
}

function multipartBody(fields, file = null) {
    const parts = Object.entries(fields).map(([name, value]) => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    if (file) parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(parts);
}

/** A multipart POST through the real chain: requireUser → moduleUploadBody → moduleAction. */
async function uploadPost(h, action, { file = { name: 'cat.png', type: 'image/png', data: PNG }, csrf = h.session.csrf, origin = ORIGIN } = {}) {
    const res = fakeRes();
    const req = {
        method: 'POST', params: { module: 'welcome', action }, query: {},
        headers: { cookie: h.cookie, ...(origin ? { origin } : {}), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        body: multipartBody(csrf === null ? {} : { csrf }, file),
    };
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (!passed) return res;
    let parsed = false;
    await h.d.moduleUploadBody(req, res, () => { parsed = true; });
    if (parsed) await h.d.moduleAction(req, res);
    return res;
}

function get(h, module) {
    return run(h, h.d.modulePage, { method: 'GET', params: { module }, headers: { cookie: h.cookie }, query: {} });
}

// Rules quiz (Verification page): two saved questions.
function seedQuiz(state) {
    state.verification.quiz = { enabled: true, cooldownMinutes: 5, questions: [
        { question: 'Q one', answers: ['A', 'B'], correctIndex: 0 },
        { question: 'Q two', answers: ['C', 'D', 'E'], correctIndex: 2 },
    ] };
}

// Server rules (Rules page): two rules, the first with a <b> in its text (escaping).
const RULE_A = 'aaaa1111';
const RULE_B = 'bbbb2222';
function seedRules(state) {
    state.registry.serverRules = { rules: [{ id: RULE_A, title: 'No spam', text: 'Do not <b>spam</b>.' }, { id: RULE_B, title: 'Be kind', text: '' }], updatedAt: '2026-10-01T00:00:00.000Z' };
}
/** Rules plus a saved post design for #general (TEXT); `posted` adds an earlier post. */
function seedRulesPost(state, { posted = false, banner = null } = {}) {
    seedRules(state);
    state.registry.rulesPost = {
        ...getSettingEntry('rulesPost').fallback, channelId: TEXT, title: 'Our <b>rules</b>', colour: 0x9b59b6, banner,
        posted: posted ? { channelId: TEXT, messageIds: ['710000000000000090'], at: '2026-10-02T00:00:00.000Z' } : null,
    };
}

// Custom automod rules: one on, one off, the first with a <b> in its name (escaping).
const CUSTOM_A = 'cust2345';
const CUSTOM_B = 'cust6789';
function seedCustomRules(state) {
    state.registry.automodCustomRules = [
        { id: CUSTOM_A, name: 'Ads <b>', words: ['join my server', 'free nitro'], action: 'warn', muteDuration: null, enabled: true },
        { id: CUSTOM_B, name: 'Spoilers', words: ['ending'], action: 'delete', muteDuration: null, enabled: false },
    ];
}

// Valid form, the service it must reach, and an invalid form with the expected message.
const CASES = {
    enforcement: {
        'appeal-panels': { form: { channelId: TEXT }, service: 'postAppealPanels', admin: true,
            bad: { form: { channelId: VOICE }, message: /must be a text channel/ } },
        channels: { admin: true, form: { modLogChannelId: TEXT, evidenceChannelId: '', adminRequestChannelId: '', appealsCategoryId: CAT, reportsCategoryId: CAT, modmailCategoryId: '', openChannelCap: '15', supportServerInvite: 'https://discord.gg/abc' }, service: 'updateSettings',
            bad: { form: { modLogChannelId: MISSING }, message: /not in the server/ } },
        roles: { form: { mutedRoleId: ROLE_OK, warnRole1: ROLE_OK2 }, service: 'updateSettings', admin: true, bad: { form: { mutedRoleId: GUILD }, message: /@everyone/ } },
        timings: { admin: true, form: { appealWindowDays: '20', appealCooldownDays: '7', rejoinInviteHours: '168', staleReportDays: '7', staleAppealReminderDays: '3' }, service: 'updateSettings',
            bad: { form: { appealWindowDays: '999', appealCooldownDays: '7', rejoinInviteHours: '1', staleReportDays: '7', staleAppealReminderDays: '3' }, message: /between 1 and 365/ } },
        'appeal-review': { form: { independentAppealReview: '1' }, service: 'updateSettings', admin: true },
        // Other servers only: refused in Mewvo's own servers (the generic tests run in the main server).
        'appeals-home': { admin: true, form: { appealsHome: 'own', appealsInvite: 'https://discord.gg/ours' }, service: 'updateSettings', homeRefused: /This setting does not apply in Mewvo/ },
        'mass-action': { form: { massActionLimit: '7', massMuteLimit: '12', massActionWindowMinutes: '10', massActionBlockMinutes: '60' }, service: 'updateSettings', admin: true,
            bad: { form: { massActionLimit: 'x', massActionWindowMinutes: '10', massActionBlockMinutes: '60' }, message: /whole number/ } },
        transparency: { form: { enabled: 'true' }, service: 'updateSettings', admin: true, bad: { form: { enabled: 'maybe' }, message: /on or off/ } },
        'trust-card': { form: { enabled: 'true' }, service: 'updateSettings', admin: true, bad: { form: { enabled: 'maybe' }, message: /on or off/ } },
        'template-add': { admin: true, form: { name: 'Spam: short mute', action: 'mute', reasonKey: 'spam', duration: '1h' }, service: 'updateSettings',
            bad: { form: { name: 'No time', action: 'mute', reasonKey: 'spam', duration: '' }, message: /needs a duration/ } },
        'template-remove': { admin: true, seed: (s) => { s.registry.enforcementTemplates = [{ name: 'Spam', action: 'warn', reasonKey: 'spam', duration: null }]; }, form: { id: derivedTemplateId('Spam') }, service: 'updateSettings',
            bad: { form: { id: 't0000000000' }, message: /gone already/ } },
    },
    appearance: {
        nickname: { form: { nickname: 'Mewvo Helper' }, service: 'setBotNickname', admin: true,
            bad: { form: { nickname: 'x'.repeat(40) }, message: /at most 32/ } },
        avatar: { form: {}, upload: { file: { field: 'image', filename: 'cat.png', data: PNG } }, service: 'setBotAvatar', admin: true,
            bad: { form: {}, message: /Choose a picture to upload/ } },
        'avatar-reset': { form: {}, service: 'setBotAvatar', admin: true },
    },
    'bot-language': {
        language: { form: { botLanguage: 'de' }, service: 'updateSettings', bad: { form: { botLanguage: 'xx' }, message: /Language for posts and DMs/ } },
        // Role-granting: Administrator-only; two languages on one role are refused.
        'language-roles': { admin: true, form: { role_en: ROLE_OK, role_de: ROLE_OK2 }, service: 'updateSettings',
            bad: { form: { role_en: ROLE_OK, role_de: ROLE_OK }, message: /same role/ } },
    },
    automod: {
        // Turning automod off needs Administrator (needsAct: the action itself is open to every editor for turning it on).
        enabled: { admin: true, form: { enabled: 'false' }, service: 'setAutomodEnabled', needsAct: true, bad: { form: { enabled: 'maybe' }, message: /on or off/ } },
        mode: { admin: true, form: { mode: 'monitor' }, service: 'setAutomodMode', bad: { form: { mode: 'chaos' }, message: /unknown choice/ } },
        rules: { admin: true, form: { 'rule:caps': 'off' }, service: 'setRuleMode', bad: { form: { 'rule:caps': 'loud' }, message: /unknown mode/ } },
        'test-run-rule': { admin: true, form: { rule: 'caps', mode: 'monitor' }, service: 'setRuleMode', bad: { form: { rule: 'nope', mode: 'off' }, message: /Rule: unknown choice/ } },
        'custom-add': { admin: true, form: { name: 'Other servers', action: 'mute', muteDuration: '1h', words: 'join my server\nfree nitro' }, service: 'updateSettings',
            bad: { form: { name: 'No time', action: 'mute', muteDuration: '', words: 'bad' }, message: /needs a duration/ } },
        'custom-edit': { admin: true, seed: seedCustomRules, form: { id: CUSTOM_A, action: 'warn', words: 'new phrase\nother words' }, service: 'updateSettings',
            bad: { seed: seedCustomRules, form: { id: CUSTOM_A, action: 'warn', words: '' }, message: /at least one word/ } },
        'custom-toggle': { admin: true, seed: seedCustomRules, form: { id: CUSTOM_A, enabled: 'false' }, service: 'updateSettings',
            bad: { seed: seedCustomRules, form: { id: 'gone1234', enabled: 'false' }, message: /gone already/ } },
        'custom-remove': { admin: true, seed: seedCustomRules, form: { id: CUSTOM_A }, service: 'updateSettings',
            bad: { form: { id: CUSTOM_A }, message: /gone already/ } },
        'channel-add': { admin: true, form: { channel: TEXT, rule: 'caps', mode: 'off' }, service: 'setChannelRuleMode', bad: { form: { channel: VOICE, rule: 'caps', mode: 'off' }, message: /must be a text channel or category/ } },
        'channel-remove': { admin: true, seed: (s) => { s.automod.channelRules = { [TEXT]: { caps: 'off' } }; }, form: { channel: TEXT, rule: 'caps' }, service: 'setChannelRuleMode', bad: { form: { channel: 'x', rule: 'caps' }, message: /not a channel ID/ } },
        'exempt-add': { admin: true, form: { channel: TEXT }, service: 'setExemptChannel', bad: { form: { channel: MISSING }, message: /not in the server/ } },
        'exempt-remove': { admin: true, form: { channel: TEXT2 }, service: 'setExemptChannel', bad: { form: { channel: '1' }, message: /not a channel ID/ } },
        trusted: { form: { roleId: ROLE_OK, minLevel: '5' }, service: 'setTrusted', admin: true, bad: { form: { roleId: ROLE_MANAGED, minLevel: '5' }, message: /managed/ } },
        'second-chance': { admin: true, form: { enabled: 'false' }, service: 'setSecondChance', bad: { form: {}, message: /on or off/ } },
        mood: { admin: true, form: { enabled: 'false' }, service: 'setMoodAlerts', bad: { form: { enabled: '' }, message: /on or off/ } },
        panic: { admin: true, form: { hours: '5', enabled: '1' }, service: 'setPanic', bad: { form: { hours: '99' }, message: /between 1 and 24/ } },
        'join-gate': { admin: true, form: { 'gate:avatar': 'flag', 'gate:links': 'off', 'gate:botname': 'off', 'gate:age': 'off', ageDays: '7' }, service: 'setJoinGateCheck',
            bad: { form: { 'gate:avatar': 'ban', 'gate:links': 'off', 'gate:botname': 'off', 'gate:age': 'off', ageDays: '7' }, message: /unknown choice/ } },
        native: { admin: true, form: { ruleId: NATIVE_RULE, policy: 'warn', dedupeMinutes: '' }, service: 'setNativePolicy', bad: { form: { ruleId: MISSING, policy: 'warn' }, message: /no longer exists/ } },
        channels: { admin: true, form: { reviewChannelId: TEXT, alertsChannelId: '', extraBlockedWords: 'foo\nBar' }, service: 'updateSettings', bad: { form: { reviewChannelId: CAT, alertsChannelId: '' }, message: /must be a text channel/ } },
        'lockdown-end': { seed: (s) => { s.lockdown = { active: true, startedAt: '2026-10-28T10:00:00Z', joinerIds: ['1', '2'] }; }, form: {}, service: 'endLockdown', admin: true,
            bad: { form: {}, message: /no lockdown right now/ } },
        'probation-end': { form: { user: MEMBER }, service: 'endProbation', admin: true, bad: { form: { user: 'x' }, message: /Discord user ID/ } },
        // Read-only: no audit row, no mod log (readOnly).
        'test-run': { form: { channels: [TEXT], days: '7' }, service: 'startAutomodBacktest', admin: true, readOnly: true,
            bad: { form: { channels: [VOICE], days: '7' }, message: /must be a text channel/ } },
    },
    logging: {
        enabled: { admin: true, form: { enabled: 'true' }, service: 'setLoggingEnabled', bad: { form: { enabled: 'x' }, message: /on or off/ } },
        channels: { admin: true, form: { audit: TEXT, applications: '', reports: '' }, service: 'setLogChannels', bad: { form: { audit: VOICE }, message: /must be a text channel/ } },
        events: { admin: true, form: {}, service: 'updateEventLogging' },
        'ignore-add': { form: { type: 'role', id: ROLE_OK }, service: 'updateIgnoreList', admin: true, bad: { form: { type: 'user', id: 'abc' }, message: /Discord user ID/ } },
        'ignore-remove': { admin: true, form: { type: 'channel', id: TEXT2 }, service: 'updateIgnoreList', bad: { form: { type: 'planet', id: TEXT2 }, message: /unknown choice/ } },
    },
    welcome: {
        'welcome-enabled': { form: { enabled: 'true' }, service: 'updateWelcomeSettings', bad: { form: { enabled: '2' }, message: /on or off/ } },
        'goodbye-enabled': { form: { enabled: 'true' }, service: 'updateWelcomeSettings', bad: { form: {}, message: /on or off/ } },
        welcome: { form: { channelId: TEXT, welcomeMessage: 'Hi {user}', welcomePing: '1', dmMessage: '' }, service: 'updateWelcomeSettings', bad: { form: { channelId: CAT }, message: /must be a text channel/ } },
        goodbye: { form: { goodbyeChannelId: TEXT, leaveMessage: 'Bye {user}' }, service: 'updateWelcomeSettings', bad: { form: { goodbyeChannelId: MISSING }, message: /not in the server/ } },
        'autorole-add': { form: { roleId: ROLE_OK2 }, service: 'addAutoRole', admin: true, bad: { form: { roleId: ROLE_DANGER }, message: /staff permissions/ } },
        'autorole-remove': { form: { roleId: ROLE_OK }, service: 'removeAutoRole', admin: true },
        'autorole-delay': { form: { autoRoleDelay: '30' }, service: 'updateWelcomeSettings', admin: true, bad: { form: { autoRoleDelay: '-1' }, message: /between 0 and 3600/ } },
        logs: { form: { joinLogsEnabled: '1', joinLogsChannelId: TEXT, leaveLogsChannelId: '' }, service: 'updateWelcomeSettings', bad: { form: { joinLogsChannelId: VOICE }, message: /must be a text channel/ } },
        'welcome-embed': { form: { welcomeTitle: 'Hi {user}', welcomeColor: '#112233', welcomeFooter: 'Enjoy', welcomeImage: 'https://example.com/a.png' }, service: 'updateWelcomeSettings', admin: true,
            bad: { form: { welcomeTitle: 'Hi', welcomeImage: 'http://example.com/a.png' }, message: /must start with https/ } },
        'welcome-image-upload': { seed: withImageStore, form: {}, upload: { file: { field: 'image', filename: 'cat.png', data: PNG } }, service: 'storeWelcomeImage', admin: true,
            bad: { form: {}, message: /Choose an image file/ } },
        'goodbye-image-upload': { seed: withImageStore, form: {}, upload: { file: { field: 'image', filename: 'cat.png', data: PNG } }, service: 'storeWelcomeImage', admin: true,
            bad: { seed: withImageStore, form: {}, message: /Choose an image file/ } },
        'welcome-image-remove': { seed: (s) => { s.welcome.welcomeImage = 'https://example.com/a.png'; }, form: {}, service: 'updateWelcomeSettings', admin: true },
        'goodbye-image-remove': { seed: (s) => { s.welcome.leaveEmbed = { title: 'Bye', image: 'https://example.com/b.png' }; }, form: {}, service: 'updateWelcomeSettings', admin: true },
        'goodbye-embed': { form: { goodbyeTitle: 'Bye', goodbyeColor: 'AA0000', goodbyeFooter: '', goodbyeImage: 'https://example.com/b.gif' }, service: 'updateWelcomeSettings', admin: true,
            bad: { form: { goodbyeColor: 'red' }, message: /hex colour/ } },
    },
    tickets: {
        setup: { seed: (s) => { s.tickets.ticketPanelChannelId = null; }, form: { panelChannelId: TEXT, panelMessage: 'Open one', buttonLabel: 'Help', categoryId: CAT, closedCategoryId: '', staffRoleId: ROLE_OK, maxTicketsPerUser: '3', dmOnClose: '1' },
            service: 'setupTicketSystem', admin: true, bad: { form: { panelChannelId: CAT, maxTicketsPerUser: '3' }, message: /must be a text channel/ } },
        'panel-publish': { form: {}, service: 'publishTicketPanel', admin: true,
            bad: { seed: (s) => { s.tickets.ticketPanelChannelId = null; }, form: {}, message: /not set up yet/ } },
        settings: { form: { ticketCategoryId: CAT, ticketClosedCategoryId: '', ticketStaffRoleId: ROLE_OK, maxTicketsPerUser: '3', dmOnClose: '1', ticketLogsChannelId: '', ticketTranscriptChannelId: '', ticketButtonLabel: 'Help', ticketPanelMessage: 'Open a ticket' },
            service: 'updateTicketSettings', needsAct: true, bad: { form: { ticketCategoryId: TEXT, maxTicketsPerUser: '3' }, message: /must be a category/ } },
        block: { form: { userId: STRANGER, reason: 'spam' }, service: 'setModmailBlocked', admin: true, bad: { form: { userId: 'abc' }, message: /Discord user ID/ } },
        unblock: { form: { userId: MEMBER }, service: 'setModmailBlocked', bad: { form: { userId: 'me' }, message: /Discord user ID/ } },
        'canned-add': { form: { name: 'hello', text: 'Hello there' }, service: 'saveCanned', bad: { form: { name: 'Bad Name', text: 'x' }, message: /small letters, numbers and -/ } },
        'canned-remove': { form: { name: 'mine' }, service: 'removeCanned', bad: { form: { name: 'appeal-received' }, message: /built in/ } },
        // Ratings (v14): their own form; the window is 1–30 days.
        ratings: { form: { ticketRatingsEnabled: '1', modmailRatingsEnabled: '1', ticketRatingWindowDays: '10', ticketLowRatingAlert: '1' }, service: 'updateTicketSettings',
            bad: { form: { ticketRatingsEnabled: '1', ticketRatingWindowDays: '45' }, message: /between 1 and 30/ } },
    },
    leveling: {
        enabled: { form: { enabled: 'false' }, service: 'updateLevelingConfig', bad: { form: { enabled: 'y' }, message: /on or off/ } },
        settings: { form: { xpMin: '10', xpMax: '20', xpCooldown: '30', levelUpChannel: '', announceLevelUp: '1', levelUpMessage: 'gg {user}' }, service: 'updateLevelingConfig',
            bad: { form: { xpMin: '30', xpMax: '20', xpCooldown: '30' }, message: /cannot be more than Most XP/ } },
        'ignore-add': { form: { type: 'channel', id: TEXT }, service: 'updateLevelIgnoreList', bad: { form: { type: 'role', id: MISSING }, message: /not in the server/ } },
        'ignore-remove': { form: { type: 'channel', id: TEXT2 }, service: 'updateLevelIgnoreList' },
        'reward-add': { form: { level: '10', roleId: ROLE_OK2 }, service: 'setLevelRoleReward', admin: true, bad: { form: { level: '10', roleId: ROLE_HIGH }, message: /not below my highest role/ } },
        'reward-remove': { form: { level: '5' }, service: 'setLevelRoleReward', admin: true, bad: { form: { level: '0' }, message: /between 1 and 1000/ } },
        'boost-add': { form: { type: 'channel', id: TEXT, multiplier: '1.5' }, service: 'setLevelBoost', bad: { form: { type: 'role', id: ROLE_OK, multiplier: '5.5' }, message: /between 1.1 and 5/ } },
        'boost-remove': { seed: (s) => { s.leveling.roleMultipliers = { [ROLE_OK]: 2 }; }, form: { type: 'role', id: ROLE_OK }, service: 'setLevelBoost' },
        'reward-mode': { form: { rewardMode: 'highest' }, service: 'updateLevelingConfig', admin: true, bad: { form: { rewardMode: 'all' }, message: /unknown choice/ } },
        voice: { form: { voiceEnabled: '1', voiceXpMin: '3', voiceXpMax: '7', voiceCap: '120', voiceMinHumans: '2' }, service: 'updateVoiceXpConfig',
            bad: { form: { voiceEnabled: '1', voiceXpMin: '9', voiceXpMax: '7', voiceCap: '120', voiceMinHumans: '2' }, message: /Least XP per minute cannot be more than Most XP per minute/ } },
        card: { form: { levelUpCard: '1', colour: 'purple', hex: '' }, service: 'updateLevelingConfig', bad: { form: { levelUpCard: '1', hex: '#12' }, message: /colour code like #9B59B6/ } },
        member: { form: { userId: MEMBER, op: 'add', levels: '2' }, service: 'addLevels', bad: { form: { userId: STRANGER, op: 'add', levels: '2' }, message: /not in the server/ }, admin: true },
        'cat-name': { form: { catName: 'Mochi <b>' }, service: 'updateSettings', admin: true, bad: { form: { catName: '@@ <>' }, message: /use letters, numbers and spaces/ } },
        'cat-announce': { form: { enabled: 'false' }, service: 'updateSettings', admin: true, bad: { form: { enabled: 'maybe' }, message: /on or off/ } },
    },
    verification: {
        setup: { seed: (s) => { s.verification.channelId = null; }, form: { channelId: TEXT, roleId: ROLE_OK2, buttonText: 'Go', message: 'Press it' }, service: 'setupVerification', admin: true,
            bad: { form: { channelId: TEXT, roleId: ROLE_OK2 }, message: /already set up/ } },
        'panel-publish': { form: {}, service: 'publishVerificationPanel', admin: true,
            bad: { seed: (s) => { s.verification.channelId = null; }, form: {}, message: /not set up yet/ } },
        enabled: { form: { enabled: 'true' }, service: 'updateVerificationSettings', admin: true, bad: { seed: (s) => { s.verification.autoVerify.enabled = true; }, form: { enabled: 'true' }, message: /Auto-verify is on/ } },
        settings: { form: { roleId: ROLE_OK2, buttonText: 'Go', message: 'Press it' }, service: 'updateVerificationSettings', admin: true, bad: { form: { roleId: ROLE_DANGER, buttonText: 'Go', message: 'x' }, message: /staff permissions/ } },
        'auto-enabled': { seed: (s) => { s.welcome.roleIds = []; }, form: { enabled: 'true' }, service: 'updateVerificationSettings', admin: true, bad: { form: { enabled: 'true' }, message: /auto roles are configured/ } },
        auto: { form: { criteria: 'account_age', accountAgeDays: '7', autoRoleId: '' }, service: 'updateVerificationSettings', admin: true, bad: { form: { criteria: 'account_age', accountAgeDays: '' }, message: /Account age must be/ } },
        redirect: { form: { verifySuccessRedirect: 'https://example.com/ok' }, service: 'updateSettings', bad: { form: { verifySuccessRedirect: 'javascript:alert(1)' }, message: /https/ } },
        'quiz-enabled': { form: { enabled: 'true' }, service: 'updateVerificationSettings', bad: { form: { enabled: 'maybe' }, message: /on or off/ } },
        quiz: { form: { q1: 'Is spam allowed?', q1a1: 'No', q1a2: 'Yes', q1c: '1', cooldownMinutes: '5' }, service: 'updateVerificationSettings',
            bad: { form: { q1: 'Is spam allowed?', q1a1: 'No', q1c: '1', cooldownMinutes: '5' }, message: /give 2 to 4 answers/ } },
        'quiz-move': { seed: seedQuiz, form: { index: '0', direction: 'down', question: 'Q one' }, service: 'updateVerificationSettings',
            bad: { seed: seedQuiz, form: { index: '0', direction: 'up', question: 'Q one' }, message: /already at the top/ } },
        'quiz-remove': { seed: seedQuiz, form: { index: '1', question: 'Q two' }, service: 'updateVerificationSettings',
            bad: { seed: seedQuiz, form: { index: '1', question: 'Q one' }, message: /changed in the meantime/ } },
    },
    'reaction-roles': {
        'panel-create': { form: { channelId: TEXT, title: 'Pick roles', description: 'Colours', roleIds: [ROLE_OK, ROLE_OK2] }, service: 'createReactionRolePanel', admin: true,
            bad: { form: { channelId: TEXT, title: 'x', description: 'y', roleIds: [] }, message: /Choose at least one role/ } },
        'role-add': { form: { messageId: PANEL, roleId: ROLE_DANGER }, service: 'addPanelRole', admin: true, bad: { form: { messageId: PANEL, roleId: MISSING }, message: /not in the server/ } },
        'role-remove': { form: { messageId: PANEL, roleId: ROLE_OK }, service: 'removePanelRole', admin: true, bad: { form: { messageId: 'x', roleId: ROLE_OK }, message: /Unknown panel/ } },
        'panel-delete': { form: { messageId: PANEL }, service: 'deletePanel', admin: true, bad: { form: { messageId: MISSING }, message: /no longer exists/ } },
    },
    messages: {
        send: { form: { channelId: TEXT, content: 'Hello @everyone', title: 'News', description: 'Line 1\r\nLine 2', colour: 'purple', hex: '', imageUrl: 'https://example.com/a.png', footer: 'Staff' },
            service: 'postBotMessage', admin: true, bad: { form: { channelId: TEXT, title: 'News', imageUrl: 'http://example.com/a.png' }, message: /must start with https:\/\// } },
        poll: { form: { channelId: TEXT, question: 'Pizza?', options: 'Yes\r\nNo\r\n\r\nMaybe', hours: '48', multiSelect: '1' }, service: 'createNativePoll', admin: true,
            bad: { form: { channelId: TEXT, question: 'Pizza?', options: 'Only one' }, message: /at least 2 options/ } },
        'poll-end': { form: { link: POLL_LINK }, service: 'endPoll', admin: true,
            bad: { form: { link: 'https://example.com/channels/1/2/3' }, message: /Copy Message Link/ } },
        countdown: { form: { channelId: TEXT, title: 'Launch', minutes: '2', seconds: '30' }, service: 'startCountdownMessage', admin: true,
            bad: { form: { channelId: TEXT, minutes: '0', seconds: '0' }, message: /at least 1 second/ } },
        schedule: { form: { channelId: TEXT, content: 'Weekly @everyone', title: '', description: '', colour: 'primary', repeat: 'weekdays', time: '18:30', day1: '1', day5: '1', timezone: 'europe/vilnius' },
            service: 'createScheduledMessage', admin: true,
            bad: { form: { channelId: TEXT, content: 'x', repeat: 'once', date: '2020-01-01', time: '10:00', timezone: 'UTC' }, message: /already passed/ } },
        'schedule-edit': { form: { id: '1', channelId: TEXT2, content: 'Changed', colour: 'primary', repeat: 'hours', date: '2026-01-01', time: '07:00', hours: '12', timezone: 'UTC' },
            service: 'updateScheduledMessage', admin: true,
            bad: { form: { id: '1', channelId: TEXT, content: 'x', repeat: 'weekdays', time: '10:00', timezone: 'UTC' }, message: /at least one weekday/ } },
        'schedule-pause': { form: { id: '1', paused: 'true' }, service: 'setScheduledMessagePaused', admin: true,
            bad: { form: { id: '9', paused: 'true' }, message: /no scheduled message #9/ } },
        'schedule-run': { form: { id: '1' }, service: 'runScheduledMessageNow', admin: true,
            bad: { form: { id: 'x' }, message: /whole number/ } },
        'schedule-test': { form: { id: '1' }, service: 'sendScheduledTest', admin: true,
            bad: { form: { id: 'x' }, message: /whole number/ } },
        'schedule-delete': { form: { id: '2' }, service: 'deleteScheduledMessage', admin: true,
            bad: { form: { id: '9' }, message: /no scheduled message #9/ } },
    },
    giveaways: {
        create: { form: { channelId: TEXT, prize: 'Nitro <b>', duration: '2h', winners: '2' }, service: 'createGiveaway', admin: true,
            bad: { form: { channelId: TEXT, prize: 'x', duration: 'soon', winners: '1' }, message: /Invalid duration format/ } },
        delete: { form: { messageId: GA_ENDED }, service: 'deleteGiveawayNow', admin: true, bad: { form: { messageId: MISSING }, message: /No giveaway was found/ } },
        end: { form: { messageId: GA_ACTIVE }, service: 'endGiveawayNow', bad: { form: { messageId: '12' }, message: /Unknown giveaway/ }, admin: true },
        reroll: { form: { messageId: GA_ENDED }, service: 'rerollGiveaway', bad: { form: { messageId: '' }, message: /Unknown giveaway/ }, admin: true },
        'random-member': { form: { roleId: '', includeBots: '1' }, service: 'pickRandomMember', admin: true,
            bad: { form: { roleId: ROLE_OK2 }, message: /No users have the Helper role/ } },
    },
    birthdays: {
        settings: { form: { channelId: TEXT, timezone: 'Europe/London', roleId: ROLE_OK }, service: 'updateBirthdaySettings', needsAct: true, bad: { form: { channelId: TEXT, timezone: 'Mars/Base', roleId: '' }, message: /not a known time zone/ } },
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
    // Invite tracking: both forms are Administrator-only (who invited whom, role rewards).
    invites: {
        settings: { admin: true, form: { enabled: '1', fakeAccountDays: '7', fakeLeaveHours: '24' }, service: 'updateSettings',
            bad: { form: { enabled: '1', fakeAccountDays: '999', fakeLeaveHours: '24' }, message: /between 0 and 365/ } },
        milestones: { admin: true, form: { stackRoles: '1', count_1: '5', role_1: ROLE_OK, count_2: '10', role_2: ROLE_OK2 }, service: 'updateSettings',
            bad: { form: { count_1: '5', role_1: ROLE_DANGER }, message: /staff permissions/ } },
    },
    applications: {
        review: { form: { id: '1700000000000-abc', decision: 'approve', note: 'Welcome' }, service: 'reviewApplicationAndNotify', admin: true,
            bad: { form: { id: '1700000000000-abc', decision: 'maybe' }, message: /Decision: unknown choice/ } },
        'role-create': { form: { roleId: ROLE_OK2, name: 'Moderator', questions: 'Why?\nAge? [min:2]' }, service: 'createApplicationRole', admin: true,
            bad: { form: { roleId: ROLE_OK, name: 'Again' }, message: /already configured/ } },
        'role-update': { form: { roleId: ROLE_OK, name: 'Helpers', enabled: '1', logChannelId: TEXT, questions: 'Why join? [min:10]' }, service: 'updateApplicationRole', admin: true,
            bad: { form: { roleId: ROLE_OK, name: 'Helpers', questions: 'a\nb\nc\nd\ne\nf' }, message: /At most 5 questions/ } },
        'role-delete': { form: { roleId: ROLE_OK }, service: 'deleteApplicationRole', admin: true, bad: { form: { roleId: MISSING }, message: /no longer exists/ } },
        enabled: { form: { enabled: 'true' }, service: 'updateApplicationSettings', bad: { form: { enabled: 'yes please' }, message: /on or off/ } },
        settings: { form: { logChannelId: TEXT, pendingDays: '30', reviewedDays: '14' }, service: 'updateApplicationSettings', bad: { form: { logChannelId: '', pendingDays: '0', reviewedDays: '14' }, message: /between 1 and 3650/ } },
        questions: { form: { questions: 'Why do you want to join?\nAge? [min:2]' }, service: 'updateApplicationSettings', bad: { form: { questions: 'a\nb\nc\nd\ne\nf' }, message: /At most 5 questions/ } },
        'manager-add': { form: { roleId: ROLE_OK }, service: 'updateApplicationSettings', admin: true, bad: { form: { roleId: MISSING }, message: /not in the server/ } },
        'manager-remove': { form: { roleId: ROLE_OK2 }, service: 'updateApplicationSettings', admin: true, bad: { form: { roleId: ROLE_OK }, message: /not a manager role/ } },
    },
    community: {
        'suggestion-status': { form: { id: '4', status: 'approved', reason: 'Good idea' }, service: 'decideSuggestion', admin: true,
            bad: { form: { id: '9', status: 'approved' }, message: /no suggestion #9/ } },
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
        'bot-settings': { form: { prefix: '?', modRole: ROLE_DANGER }, service: 'updateConfigSetting', admin: true,
            bad: { form: { prefix: 'two words', modRole: '' }, message: /The prefix must be 1 to 10 characters, with no spaces/ } },
        shorten: { form: { url: 'https://example.com/a/long/link', custom: '' }, service: 'shortenUrl', admin: true,
            bad: { form: { url: 'example.com' }, message: /Include http/ } },
    },
    channels: {
        purge: { form: { channelId: TEXT, amount: '2', userId: '', reason: 'spam' }, service: 'purgeChannelMessages', admin: true,
            bad: { form: { channelId: TEXT, amount: '101' }, message: /between 1 and 100/ } },
        lock: { form: { channelId: TEXT, reason: 'raid' }, service: 'lockChannel', admin: true,
            bad: { form: { channelId: VOICE }, message: /must be a text channel/ } },
        unlock: { seed: (s, guild) => { guild.channels.cache.get(TEXT).permissionOverwrites.edit(GUILD, { SendMessages: false }); }, form: { channelId: TEXT }, service: 'unlockChannel', admin: true,
            bad: { form: { channelId: MISSING }, message: /not in the server/ } },
    },
    support: {
        'banned-role': { form: { bannedRoleId: SUPPORT_ROLE }, service: 'updateSettings', admin: true, bad: { form: { bannedRoleId: ROLE_OK }, message: /not in the server/ } },
        'appeals-category': { form: { supportAppealsCategoryId: SUPPORT_CAT }, service: 'updateSettings', bad: { form: { supportAppealsCategoryId: CAT }, message: /not in the server/ } },
    },
    rules: {
        'rule-add': { form: { title: 'No ads', text: 'Keep ads out.' }, service: 'updateSettings', bad: { form: { title: '   ', text: 'x' }, message: /needs a title/ } },
        'rule-edit': { seed: seedRules, form: { id: RULE_A, title: 'No spamming', text: 'Nope.' }, service: 'updateSettings',
            bad: { seed: seedRules, form: { id: 'zzzz9999', title: 'X' }, message: /no longer exists/ } },
        'rule-delete': { seed: seedRules, form: { id: RULE_A }, service: 'updateSettings', bad: { form: { id: RULE_A }, message: /no longer exists/ } },
        'rule-move': { seed: seedRules, form: { id: RULE_A, direction: 'down' }, service: 'updateSettings',
            bad: { seed: seedRules, form: { id: RULE_A, direction: 'up' }, message: /already the first/ } },
        links: { seed: seedRules, form: { link_spam: RULE_A }, service: 'updateSettings',
            bad: { seed: seedRules, form: { link_spam: 'zzzz9999' }, message: /no longer exists/ } },
        'library-add': { form: { key: 'spam' }, service: 'updateSettings', bad: { form: { key: 'nope' }, message: /does not exist/ } },
        'post-design': { form: { channelId: TEXT, title: 'Rules', colour: 'green', hex: '', intro: 'Hi', footer: 'Bye', layout: 'fields', bannerUrl: '', thumbnailUrl: '' }, service: 'updateSettings',
            bad: { form: { channelId: TEXT, title: 'Rules', layout: 'list', footer: 'x'.repeat(201) }, message: /Footer is too long: at most 200/ } },
        'banner-upload': { seed: withImageStore, form: {}, upload: { file: { field: 'image', filename: 'cat.png', data: PNG } }, service: 'storeWelcomeImage', admin: true,
            bad: { seed: withImageStore, form: {}, message: /Choose an image file/ } },
        'thumbnail-upload': { seed: withImageStore, form: {}, upload: { file: { field: 'image', filename: 'cat.png', data: PNG } }, service: 'storeWelcomeImage', admin: true,
            bad: { form: {}, message: /Choose an image file/ } },
        'banner-remove': { seed: (s) => seedRulesPost(s, { banner: { url: 'https://example.com/b.png', ref: null } }), form: {}, service: 'updateSettings' },
        'thumbnail-remove': { seed: (s) => { seedRulesPost(s); s.registry.rulesPost.thumbnail = { url: 'https://example.com/t.png', ref: null }; }, form: {}, service: 'updateSettings' },
        post: { seed: seedRulesPost, form: {}, service: 'postRulesMessages', admin: true, bad: { seed: seedRules, form: {}, message: /Pick a channel in the design/ } },
        'post-update': { seed: (s) => seedRulesPost(s, { posted: true }), form: {}, service: 'updateRulesMessages', admin: true,
            bad: { seed: seedRulesPost, form: {}, message: /have not been posted yet/ } },
    },
};

// ── coverage of the case table ────────────────────────────────────────────

test('every module action has a test case', () => {
    for (const module of MODULES) {
        for (const action of Object.keys(module.actions)) {
            assert.ok(CASES[module.key]?.[action], `missing case for ${module.key}/${action}`);
            // B3: the case table says which actions are Administrator-only; the descriptor must agree.
            assert.equal(getAction(module, action).admin, Boolean(CASES[module.key][action].admin), `${module.key}/${action}: admin marker`);
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
            assert.equal(res.statusCode, 404, `${module.key}/${action} stranger: no access here → the server's uniform 404`);
            assert.equal(stranger.calls.length, 0);
            const owner = await setup({ userId: OWNER });
            c.seed?.(owner.state, owner.guild);
            const asOwner = await postConfirmed(owner, module.key, action, c.form);
            // Without Administrator only actions marked `manager` run (closed by default).
            if (!getAction(module, action).manager || c.needsAct) {
                assert.equal(asOwner.statusCode, 403, `${module.key}/${action} owner must be refused`);
                assert.match(asOwner.body, /Administrator/);
                assert.equal(owner.calls.length, 0);
            } else if (c.homeRefused) {
                assert.equal(asOwner.statusCode, 400, `${module.key}/${action} refused in a home server`);
                assert.match(asOwner.body, c.homeRefused);
            } else {
                assert.equal(asOwner.statusCode, 303, `${module.key}/${action} owner may change manager-level settings (decision 4)`);
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
        assert.equal((await postConfirmed(owner, module.key, action, CASES[module.key][action].form)).statusCode, 303);
        const line = warnings.find((w) => w.startsWith('Owner override:'));
        assert.ok(line, 'override logged');
        assert.ok(line.includes(OWNER), 'user id');
        assert.ok(line.includes(`${module.key}/${action}`), 'action');
        assert.match(line, /via dashboard at \d{4}-\d{2}-\d{2}T/, 'time');
        warnings.length = 0;
        const admin = await setup();
        CASES[module.key][action].seed?.(admin.state, admin.guild);
        await postConfirmed(admin, module.key, action, CASES[module.key][action].form);
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
                'publishTicketPanel', 'publishVerificationPanel', 'createGiveaway', 'deleteGiveawayNow', 'setupJoinToCreate', 'createApplicationRole', 'editTag',
                // Read-only tools that refuse by themselves.
                'pickRandomMember', 'shortenUrl'].includes(call.name));
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
            const res = await postConfirmed(h, module.key, action, c.form, { upload: c.upload });
            if (c.homeRefused) {
                // Refused in Mewvo's own servers, nothing written (tests/dashboardModulesB3.test.js runs it for another server).
                assert.equal(res.statusCode, 400, `${module.key}/${action} refused in a home server`);
                assert.match(res.body, c.homeRefused);
                assert.ok(!h.calls.some((call) => call.name === c.service), `${module.key}/${action}: nothing saved`);
                continue;
            }
            assert.equal(res.statusCode, 303, `${module.key}/${action} → 303 (got ${res.statusCode}: ${String(res.body).match(/role="alert">([^<]*)/)?.[1] || ''})`);
            assert.equal(res.redirectedTo, `/dashboard/${module.key}`);
            assert.ok(h.calls.some((call) => call.name === c.service), `${module.key}/${action} calls ${c.service}`);
            const modLog = h.calls.filter((call) => call.name === 'postModLog');
            if (c.readOnly) {
                // Changes nothing: no audit row and no mod log line.
                assert.equal(h.auditRows.length, 0, `${module.key}/${action} no audit row`);
                assert.equal(modLog.length, 0, `${module.key}/${action} no mod-log post`);
            } else {
                assert.ok(h.auditRows.length > 0, `${module.key}/${action} audit row`);
                assert.equal(modLog.length, 1, `${module.key}/${action} one mod-log post`);
                assert.equal(modLog[0].args[0], 'dashboard');
                assert.match(modLog[0].args[1].description, new RegExp(`\\(${ADMIN}\\) changed `));
            }
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

test('independent appeal review: off by default, the switch turns it on and off, each change audited', async () => {
    const h = await setup();
    const page = await get(h, 'enforcement');
    assert.match(page.body, /A different moderator decides each appeal/);
    assert.match(page.body, /name="independentAppealReview" value="1">/, 'rendered unchecked (default off)');
    assert.ok(!/<[^>]*style=/i.test(page.body), 'no inline styles');

    assert.equal((await post(h, 'enforcement', 'appeal-review', { independentAppealReview: '1' })).statusCode, 303);
    assert.equal(h.state.registry.independentAppealReview, true);
    assert.deepEqual(h.auditRows.map((r) => [r.key, r.old, r.new]), [['independentAppealReview', false, true]]);
    assert.equal(h.calls.find((c) => c.name === 'updateSettings').args[2].module, 'enforcement');
    assert.match((await get(h, 'enforcement')).body, /name="independentAppealReview" value="1" checked>/);

    // Unchecked switch: the field is absent from the form → off.
    assert.equal((await post(h, 'enforcement', 'appeal-review', {})).statusCode, 303);
    assert.equal(h.state.registry.independentAppealReview, false);
    assert.deepEqual(h.auditRows.map((r) => [r.key, r.old, r.new]), [['independentAppealReview', false, true], ['independentAppealReview', true, false]]);

    // Same value again: nothing changed, no audit row.
    await post(h, 'enforcement', 'appeal-review', {});
    assert.equal(h.auditRows.length, 2);
    assert.match((await h.sessions.get(h.session.id)).flash, /Nothing changed/);
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

test('B3: every form on a module page that picks a role posts to an Administrator-only action (or a listed field-level / XP-only one)', async () => {
    const offenders = [];
    let checked = 0;
    for (const module of MODULES) {
        const h = await setup();
        const res = await get(h, module.key);
        assert.equal(res.statusCode, 200, module.key);
        for (const [, actionPath, body] of res.body.matchAll(/<form method="post" action="\/dashboard\/([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
            // A role select: its options are "@Role name" (forms.js rolePicker).
            if (!/<option value="\d{17,20}"[^>]*>@/.test(body)) continue;
            const [moduleKey, name] = actionPath.split('/');
            const action = getAction(MODULES.find((m) => m.key === moduleKey), name);
            const id = `${moduleKey}/${name}`;
            checked += 1;
            if (!action?.admin && !FIELD_LEVEL.has(id) && !NOT_PRIVILEGED.has(id)) offenders.push(id);
        }
    }
    assert.ok(checked >= 15, `role forms found: ${checked}`);
    assert.deepEqual([...new Set(offenders)], []);
});

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
    assert.match(giveaways.body, /need the Administrator permission/);
    assert.ok(!/>End now</.test(giveaways.body), 'no End now button for an owner');
    const leveling = await get(owner, 'leveling');
    assert.match(leveling.body, /need the Administrator permission/);
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
    // The option itself says what is missing (before saving), and the warning offers Fix permissions.
    assert.match(page.body, /<optgroup label="Support"><option value="500000000000000001" selected>#general \(Mewvo lacks: View Channel, Send Messages, Embed Links\)<\/option>/);
    assert.match(page.body, /<a class="fix-link" href="\/dashboard\/fix-permissions\?channel=500000000000000001&amp;need=ViewChannel%2CSendMessages%2CEmbedLinks">Fix permissions<\/a>/);
    assert.match(page.body, /needs more permissions before this works there/);
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
    assert.deepEqual(seen[0], { userId: ADMIN, module: 'logging', excludeModules: ['owner', 'website'], page: 1, pageSize: 50 });
    assert.match(res.body, /Page 2 of 3/);
    assert.match(res.body, /&lt;u&gt;/);
    assert.match(res.body, /&lt;x&gt;/);
    assert.match(res.body, /<option value="200000000000000002" selected>/);
    const bad = await run(h, h.d.audit, { method: 'GET', headers: { cookie: h.cookie }, query: { user: '1 OR 1=1', module: "x'; drop" } });
    assert.equal(bad.statusCode, 200);
    assert.deepEqual(seen[1], { userId: null, module: null, excludeModules: ['owner', 'website'], page: 0, pageSize: 50 }, 'bad filters are ignored');
});

test('sidebar: every module listed (no Phase 2 placeholders), on/off states shown', async () => {
    const keys = NAV.flatMap((item) => (item.group ? item.items : [item])).map((i) => i.key);
    for (const module of MODULES) assert.ok(keys.includes(module.key), module.key);
    const h = await setup();
    const res = await get(h, 'automod');
    assert.match(res.body, /><span class="side-text">Automod<\/span><span class="dot dot-on"><span class="sr">on<\/span><\/span><\/a>/, 'sidebar entry with the on/off dot');
    const side = res.body.slice(res.body.indexOf('class="side-nav"'), res.body.indexOf('</nav>', res.body.indexOf('class="side-nav"')));
    assert.ok(!side.includes('<use href="#i-automod">'), 'words only in the sidebar, no icon per item');
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
    assert.match(changeSummary([{ key: 'k', old: null, new: 'x'.repeat(500) }]), /^k: \(none\) → x+…$/);
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
    assert.match(ownerPage.body, /To post the panel you need the Administrator permission/);
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
    assert.equal((res.body.match(/<tr class="module-row"/g) || []).length, settings.length);
    // State only: the main switch lives in the module page header, not on the card.
    assert.ok(!res.body.includes('class="switch-form"'), 'no switches on the cards');
    assert.match(res.body, /<span class="module-state is-(on|off)">(On|Off)<\/span>/);
    assert.ok(!res.body.includes('module-card') && !res.body.includes('module-icon'), 'a table, not a card grid');
    assert.match(res.body, /data-module-search/);
    assert.ok(!/style="|<script>/.test(res.body));
    const on = await modulesPageGet(h, { show: 'on' });
    assert.ok(!/data-state="off"/.test(on.body) && !/data-state="none"/.test(on.body));
    const off = await modulesPageGet(h, { show: 'off' });
    assert.ok(!/data-state="on"/.test(off.body));
    const junk = await modulesPageGet(h, { show: '<x>' });
    assert.equal((junk.body.match(/<tr class="module-row"/g) || []).length, settings.length, 'unknown filter = all');
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

test('"On this page" links on long module pages point at existing topics or cards', async () => {
    const h = await setup();
    const page = await get(h, 'automod');
    // Automod is grouped by topic: the links name the topics (g-…).
    const links = [...page.body.matchAll(/<a href="#([sg]-[a-z0-9-]+)">/g)].map((m) => m[1]);
    assert.ok(links.length >= 4, links.join());
    assert.ok(links.every((id) => id.startsWith('g-')), links.join());
    for (const id of links) assert.ok(page.body.includes(`id="${id}"`), id);
    // Inside a topic the card titles are h3 under the topic's h2.
    assert.match(page.body, /<section class="topic" id="g-rules"><header class="topic-head"><h2>Rules<\/h2><p>[^<]+<\/p><\/header><div class="card-grid"><section class="tile-card section" id="s-global-mode" data-card="global-mode"><header class="card-top"><h3 class="card-title">Global mode<\/h3>/);
    // A page without topics lists its cards when it has four or more (Logging: mod log, channels, events, ignore lists).
    const logging = await get(h, 'logging');
    const cards = [...logging.body.matchAll(/<a href="#(s-[a-z0-9-]+)">/g)].map((m) => m[1]);
    assert.ok(cards.length >= 4, cards.join());
    for (const id of cards) assert.ok(logging.body.includes(`id="${id}"`), id);
    assert.ok(logging.body.includes('<div class="card-grid"><section class="tile-card section"'), 'ungrouped pages: one grid');
});

test('settings cards: a long help text shows its first sentence, the rest behind "More about this"; tables take the full row', async () => {
    const { section, splitHelp } = await import('../src/services/dashboard/modules/common.js');
    const { html } = await import('../src/services/dashboard/html.js');
    assert.deepEqual(splitHelp('Short.'), ['Short.', '']);
    const long = 'Members who came back after a ban ended. Automod is stricter with them for a while: they skip straight to the next punishment step.';
    assert.deepEqual(splitHelp(long), ['Members who came back after a ban ended.', 'Automod is stricter with them for a while: they skip straight to the next punishment step.']);
    assert.deepEqual(splitHelp(['Line.', 'More.']), ['Line.', 'More.']);
    const card = String(section('Probation <b>', html`<div class="scroll"><table></table></div>`, long));
    assert.ok(card.startsWith('<section class="tile-card section size-full" id="s-probation-b" data-card="probation-b"><header class="card-top"><h2 class="card-title">Probation &lt;b&gt;</h2><p class="card-desc">Members who came back after a ban ended.</p><details class="card-more"><summary>More about this</summary>'), card);
    assert.ok(String(section('Plain', html`<p>x</p>`)).startsWith('<section class="tile-card section" id="s-plain"'));
});

test('Overview keeps the full module states (automod etc.) next to the config-based ones', async () => {
    const h = await setup();
    const res = await run(h, h.d.overview, { method: 'GET', params: {}, headers: { cookie: h.cookie }, query: {} });
    assert.equal(res.statusCode, 200);
    // Automod's state comes from the automod service, not from the guild config.
    assert.match(res.body, /Automod is on/, 'status line');
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
    assert.match(page.body, /<section class="tile-card section size-full" id="s-commands" data-card="commands"><header class="card-top"><h2 class="card-title">Commands \(1\)<\/h2>/);
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
    assert.match(res.body, /<h2>Recent dashboard changes<\/h2><a class="card-link" href="\/dashboard\/audit">Full audit log<\/a><\/header><div class="section-body"><div class="scroll"><table>/);
    assert.match(res.body, /<td>admin&lt;b&gt;<\/td><td><a href="\/dashboard\/automod">Automod<\/a><\/td>\n<td><code>[^<]+<\/code><\/td>/);
    assert.ok(res.body.includes('href="/dashboard/audit">Full audit log'));
    const { overviewPage } = await import('../src/services/dashboard/overview.js');
    const o = { checklist: [], bot: { ready: true, ping: null }, database: null, guild: null, recent: [], lockdown: undefined };
    assert.match(overviewPage({ session: { username: 'a', csrf: 't' }, overview: o, recentChanges: null }), /Recent dashboard changes<\/h2><\/header><div class="section-body"><p class="muted">Could not be loaded just now/);
    assert.match(overviewPage({ session: { username: 'a', csrf: 't' }, overview: o, recentChanges: [] }), /No dashboard changes yet/);
});

test('top bar search: ?q= filters modules by name, one-liner or keywords (every word), escaped', async () => {
    const h = await setup();
    const find = (q) => modulesPageGet(h, { q });
    const xp = await find('xp');
    assert.equal((xp.body.match(/<tr class="module-row"/g) || []).length, 1);
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
    assert.match(page, /1 of 2 done\./, 'progress in words (no ring)');
    assert.ok(!page.includes('class="ring"'));
    assert.ok(page.indexOf('Open thing') < page.indexOf('Done: Done thing'), 'open items first');
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
    const cardOf = (key) => page.slice(page.indexOf(`href="/dashboard/${key}"`), page.indexOf('</tr>', page.indexOf(`href="/dashboard/${key}"`)));
    assert.match(cardOf('tickets'), /<span class="module-state is-on">On<\/span>, <span class="module-state is-setup">needs setup \(1\)<\/span>/);
    assert.match(cardOf('welcome'), /<span class="module-state is-on">On<\/span><\/td>/);
    assert.match(cardOf('automod'), /<span class="module-state is-off">Off<\/span><\/td>/, 'off wins');
    assert.match(cardOf('enforcement'), /needs setup \(1\)/, 'no on/off state, open setup items');
    assert.ok(!cardOf('giveaways').includes('module-state'), 'no state and no checklist items: a dash');
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
    const keys = (q) => [...String(modulesPage({ session: { username: 'a', csrf: 't' }, q, checklist })).matchAll(/<tr class="module-row"[^>]*>\n<td><a href="\/dashboard\/([a-z-]+)"/g)].map((m) => m[1]);
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
    assert.match(page.body, /need the Administrator permission in this server/);
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

test('channel tools: purge limits (1–100), confirm page first, user filter, 14-day messages skipped', async () => {
    const h = await setup();
    for (const amount of ['0', '101', 'x']) {
        const res = await post(h, 'channels', 'purge', { channelId: TEXT, amount });
        assert.equal(res.statusCode, 400, `amount ${amount}`);
    }
    const badUser = await post(h, 'channels', 'purge', { channelId: TEXT, amount: '5', userId: 'bob' });
    assert.match(badUser.body, /that is not a user ID/);
    const text = h.guild.channels.cache.get(TEXT);
    const page = await post(h, 'channels', 'purge', { channelId: TEXT, amount: '5' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Confirm: delete messages in #general/);
    assert.match(page.body, /The newest 5/);
    assert.match(page.body, /deleted for good and cannot be brought back/);
    assert.deepEqual(text.deletedIds, [], 'nothing deleted by refused forms or the first submit');

    const res = await postConfirmed(h, 'channels', 'purge', { channelId: TEXT, amount: '5', userId: MEMBER, reason: 'spam' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(text.deletedIds, ['800000000000000001', '800000000000000003'], 'only the member\'s recent messages');
    assert.match((await h.sessions.get(h.session.id)).flash, /Deleted 2 messages in #general\. 1 message was older than 14 days and skipped\./);
    assert.equal(h.state.logEvents.length, 1);
    assert.equal(h.state.logEvents[0].event.action, 'Messages Purged');
    assert.match(h.state.logEvents[0].event.reason, /Dashboard \(admin<b>\): spam/);
    assert.equal(h.auditRows[0].key, `purge.${TEXT}`);

    const onlyOld = await postConfirmed(h, 'channels', 'purge', { channelId: TEXT, amount: '5', userId: MEMBER });
    assert.equal(onlyOld.statusCode, 400);
    assert.match(onlyOld.body, /older than 14 days/);
});

// ── Confirm pages instead of tick boxes (purge, delete an application) ─────

const CONFIRM_FLOWS = [
    {
        name: 'channels/purge', module: 'channels', action: 'purge', form: { channelId: TEXT, amount: '5', reason: 'spam <b>' },
        heading: /Confirm: delete messages in #general/, submit: '>Delete messages</button>',
        changed: (h) => h.guild.channels.cache.get(TEXT).deletedIds.length > 0,
    },
    {
        name: 'applications/role-delete', module: 'applications', action: 'role-delete', form: { roleId: ROLE_OK },
        heading: /Confirm: delete the Helper &lt;b&gt; application/, submit: '>Delete application</button>',
        changed: (h) => h.calls.some((c) => c.name === 'deleteApplicationRole'),
    },
    {
        name: 'messages/send', module: 'messages', action: 'send', form: { channelId: TEXT, content: 'Hello <b>', pingRole: ROLE_OK },
        heading: /Confirm: post in #general/, submit: '>Post now</button>',
        changed: (h) => h.calls.some((c) => c.name === 'postBotMessage'),
    },
];

for (const flow of CONFIRM_FLOWS) {
    test(`${flow.name}: first submit → confirm page (Confirm / Cancel); no / bad / reused / expired token → refused, nothing changed; valid → runs once`, async () => {
        const h = await setup();
        const settingsPage = await get(h, flow.module);
        assert.ok(!new RegExp(`action="/dashboard/${flow.module}/${flow.action}"[^>]*data-confirm`).test(settingsPage.body), 'no script dialog on the form');

        const page = await post(h, flow.module, flow.action, flow.form);
        assert.equal(page.statusCode, 200);
        assert.match(page.body, flow.heading);
        assert.ok(page.body.includes(flow.submit), 'the Confirm button names the action');
        assert.ok(page.body.includes(`<a class="btn" href="/dashboard/${flow.module}">Cancel</a>`), 'Cancel goes back to the module page');
        assert.ok(!page.body.includes('type="checkbox"'), 'no tick box');
        assert.match(page.body, /works once and expires in 5 minutes/);
        assert.ok(!/<style|style=|<script(?! src)/.test(page.body.replace(ALLOWED_SCRIPT, '')), 'CSP: no inline style or script');
        assert.equal(flow.changed(h), false, 'nothing changed by the first submit');
        assert.equal(h.auditRows.length, 0);

        const refused = async (form, why) => {
            const res = await post(h, flow.module, flow.action, form);
            assert.equal(res.statusCode, 400, why);
            assert.match(res.body, /expired or was already used\. Nothing was done/, why);
            assert.equal(flow.changed(h), false, `${why}: nothing changed`);
        };
        await refused({ token: 'x'.repeat(32), fh: 'y' }, 'unknown token');
        await refused({ ...tokenOf(page.body), fh: 'wrong' }, 'wrong hash');
        const expired = tokenOf((await post(h, flow.module, flow.action, flow.form)).body);
        const realNow = Date.now;
        Date.now = () => realNow() + 6 * 60 * 1000;
        try { await refused(expired, 'expired'); } finally { Date.now = realNow; }
        // A token of the other confirm flow does not work here (bound to the action).
        const other = CONFIRM_FLOWS.find((f) => f !== flow);
        await refused(tokenOf((await post(h, other.module, other.action, other.form)).body), 'token of another action');
        assert.equal(h.auditRows.length, 0);

        const t = tokenOf((await post(h, flow.module, flow.action, flow.form)).body);
        const done = await post(h, flow.module, flow.action, t);
        assert.equal(done.statusCode, 303);
        assert.equal(done.redirectedTo, `/dashboard/${flow.module}`);
        assert.equal(flow.changed(h), true);
        assert.equal(h.auditRows.length, 1);
        const reused = await post(h, flow.module, flow.action, t);
        assert.equal(reused.statusCode, 400, 'a token works once');
        assert.equal(h.auditRows.length, 1, 'ran once');
    });
}

test('applications/role-delete confirm page counts the submitted applications that go with it', async () => {
    const h = await setup();
    h.state.submitted = [{ id: 'a1', roleId: ROLE_OK }, { id: 'a2', roleId: ROLE_OK }, { id: 'a3', roleId: ROLE_OK2 }];
    const page = await post(h, 'applications', 'role-delete', { roleId: ROLE_OK });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<dt>Submitted applications<\/dt><dd>2<\/dd>/);
    assert.match(page.body, /This cannot be undone/);
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
    for (const name of ['send', 'poll', 'poll-end', 'countdown']) assert.equal(getAction(module, name).admin, true, `${name} is admin-only`);
    const h = await setup();
    const page = await get(h, 'messages');
    assert.equal(page.statusCode, 200);
    for (const action of ['send', 'poll', 'poll-end', 'countdown']) assert.ok(page.body.includes(`action="/dashboard/messages/${action}"`), `${action} form`);
    assert.match(page.body, /A Discord poll shows everyone who voted for what/, 'the anonymous switch says why it exists');
    assert.match(page.body, /never ping/);
    const owner = await setup({ userId: OWNER });
    const ownerPage = await get(owner, 'messages');
    assert.ok(!/<fieldset>/.test(ownerPage.body.replace(/<fieldset class="weekdays">/g, '')), 'owner: every form disabled');
    assert.ok((ownerPage.body.match(/<fieldset disabled>/g) || []).length >= 5, 'owner: send, schedule, poll, end poll and countdown forms disabled');
    assert.match(ownerPage.body, /To post you need the Administrator permission/);
});

test('messages: Start from a template is a grouped GET picker; ?template= fills Send and Schedule (escaped, server name); posting it goes through the normal send', async () => {
    const h = await setup();
    const page = (await get(h, 'messages')).body;
    const picker = page.slice(page.indexOf('id="s-start-from-a-template"'), page.indexOf('id="s-send-a-message"'));
    assert.match(picker, /<form method="get" action="\/dashboard\/messages#s-send-a-message"/, 'a plain GET form, no script');
    assert.ok(!/<script|onclick|onchange/i.test(picker), 'no inline JS (CSP)');
    assert.ok((picker.match(/<optgroup /g) || []).length >= 5, 'grouped');
    assert.ok((picker.match(/<option value="/g) || []).length >= 40, 'at least 40 templates');
    assert.match(picker, /<optgroup label="Support server"><option value="appeal-overview">How to appeal \(all punishments\)<\/option>/);
    assert.ok(!/ selected/.test(picker.slice(picker.indexOf('<select name="template">'), picker.indexOf('</select>'))), 'no template chosen yet');

    const filled = (await run(h, h.d.modulePage, { method: 'GET', params: { module: 'messages' }, headers: { cookie: h.cookie }, query: { template: 'support-welcome' } }));
    assert.equal(filled.statusCode, 200);
    assert.match(filled.body, /<option value="support-welcome" selected>/);
    assert.match(filled.body, /Template "Welcome to the support server" is filled in below/);
    // Both forms get the box title with the server name, escaped ("Main <b>").
    assert.equal((filled.body.match(/name="title" value="Welcome to Main &lt;b&gt;"/g) || []).length, 2, 'Send and Schedule prefilled');
    assert.ok(!filled.body.includes('Welcome to Main <b>'), 'server name escaped');
    assert.match(filled.body, /This server is for help with appeals, reports and questions\./);

    const unknown = await run(h, h.d.modulePage, { method: 'GET', params: { module: 'messages' }, headers: { cookie: h.cookie }, query: { template: '<x>' } });
    assert.equal(unknown.statusCode, 200);
    assert.match(unknown.body, /That template does not exist/);
    assert.ok(!unknown.body.includes('<x>'));

    // The admin edits the filled text and posts it: the normal send action, no pings.
    const res = await postConfirmed(h, 'messages', 'send', { channelId: TEXT, title: 'Welcome to Main', description: 'This server is for help with appeals.\r\nEdited.', colour: 'primary' });
    assert.equal(res.statusCode, 303);
    const [, content, embed] = h.calls.find((c) => c.name === 'postBotMessage').args;
    assert.equal(content, '');
    assert.equal(embed.title, 'Welcome to Main');
    assert.equal(embed.description, 'This server is for help with appeals.\nEdited.');
});

test('messages/send: text, embed and colour reach the service; hex colour wins; bad hex and footer-only embeds are refused', async () => {
    const h = await setup();
    assert.equal((await postConfirmed(h, 'messages', 'send', CASES.messages.send.form)).statusCode, 303);
    const [channelId, content, embed] = h.calls.find((c) => c.name === 'postBotMessage').args;
    assert.equal(channelId, TEXT);
    assert.equal(content, 'Hello @everyone');
    assert.equal(embed.description, 'Line 1\nLine 2', 'line breaks normalised');
    assert.equal(embed.colour, 0x9B59B6);
    assert.ok(h.auditRows.some((r) => r.key === 'message.710000000000000011' && r.new.embed.colour === '#9b59b6'));

    const hex = await setup();
    await postConfirmed(hex, 'messages', 'send', { channelId: TEXT, content: 'hi', colour: 'red', hex: '#00ff00' });
    assert.equal(hex.calls.find((c) => c.name === 'postBotMessage').args[2], null, 'no embed fields: text only');
    await postConfirmed(hex, 'messages', 'send', { channelId: TEXT, title: 't', hex: '00ff00' });
    assert.equal(hex.calls.filter((c) => c.name === 'postBotMessage')[1].args[2].colour, 0x00ff00);

    for (const [form, message] of [
        [{ channelId: TEXT, title: 't', hex: 'green' }, /colour code like #9B59B6/],
        [{ channelId: TEXT, footer: 'only a footer' }, /A footer on its own is not shown/],
        [{ channelId: TEXT }, /nothing to post/],
        [{ channelId: VOICE, content: 'x' }, /must be a text channel/],
        [{ channelId: TEXT, content: 'x'.repeat(2001) }, /at most 2000 characters/],
        [{ channelId: TEXT, title: 'x', imageUrl: 'javascript:alert(1)' }, /must start with https:\/\//],
        [{ channelId: TEXT, title: 'x', imageUrl: 'https://user:pw@example.com/a.png' }, /must start with https:\/\//],
    ]) {
        const r = await setup();
        const res = await post(r, 'messages', 'send', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form));
        assert.match(res.body, message);
        assert.ok(!r.calls.some((c) => c.name === 'postBotMessage'), 'nothing posted');
    }
});

test('messages/send: preview first (Confirm / Cancel) with channel, ping, format and buttons; nothing posted until Post now', async () => {
    const h = await setup();
    const form = {
        channelId: TEXT, title: 'News <b>', description: 'Hello', colour: 'primary', pingRole: ROLE_OK,
        button1Label: 'Rules', button1Url: 'https://example.com/rules',
    };
    const page = await post(h, 'messages', 'send', form);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Confirm: post in #general/);
    assert.ok(page.body.includes('>Post now</button>'), 'the Confirm button names the action');
    assert.ok(page.body.includes('<a class="btn" href="/dashboard/messages">Cancel</a>'));
    assert.match(page.body, /<dt>Gets a notification<\/dt><dd>@Member<\/dd>/);
    assert.match(page.body, /<dt>Format<\/dt><dd>Embed/);
    assert.match(page.body, /<dt>Buttons<\/dt><dd>Rules \(https:\/\/example\.com\/rules\)<\/dd>/);
    assert.ok(page.body.includes('News &lt;b&gt;') && !page.body.includes('News <b>'), 'the preview is escaped');
    assert.ok(!h.calls.some((c) => c.name === 'postBotMessage'), 'nothing posted by the first submit');
    assert.equal(h.auditRows.length, 0);

    assert.equal((await postConfirmed(h, 'messages', 'send', form)).statusCode, 303);
    const [, , embed, ping, buttons] = h.calls.find((c) => c.name === 'postBotMessage').args;
    assert.equal(embed.title, 'News <b>');
    assert.deepEqual(ping, { everyone: false, roleIds: [ROLE_OK], userIds: [] });
    assert.deepEqual(buttons, [{ label: 'Rules', url: 'https://example.com/rules' }]);
    assert.ok(h.auditRows.some((r) => r.key.startsWith('message.') && r.new.ping.roleIds[0] === ROLE_OK && r.new.buttons.length === 1));
});

test('messages/send: pings only what was picked (no ping by default, everyone only when ticked); plain text folds the box into the text', async () => {
    const none = await setup();
    await postConfirmed(none, 'messages', 'send', { channelId: TEXT, content: 'Hi @everyone <@&600000000000000001>' });
    assert.equal(none.calls.find((c) => c.name === 'postBotMessage').args[3], null, 'typed mentions: no ping at all');

    const all = await setup();
    await postConfirmed(all, 'messages', 'send', { channelId: TEXT, content: 'Big news', pingEveryone: '1' });
    assert.deepEqual(all.calls.find((c) => c.name === 'postBotMessage').args[3], { everyone: true, roleIds: [], userIds: [] });

    const text = await setup();
    await postConfirmed(text, 'messages', 'send', { channelId: TEXT, format: 'text', content: 'Intro', title: 'Title', description: 'Body', footer: 'Staff' });
    const [, content, embed] = text.calls.find((c) => c.name === 'postBotMessage').args;
    assert.equal(embed, null, 'no box');
    assert.equal(content, 'Intro\n\n**Title**\n\nBody\n\n-# Staff');

    for (const [form, message] of [
        [{ channelId: TEXT, content: 'x', pingRole: GUILD }, /@everyone/],
        [{ channelId: TEXT, content: 'x', pingRole: '699999999999999999' }, /not in the server|no longer exists|missing/i],
        [{ channelId: TEXT, content: 'x', mod1: MEMBER }, /New moderators template/],
        [{ channelId: TEXT, content: 'x', format: 'fancy' }, /Embed or Plain text/],
    ]) {
        const r = await setup();
        const res = await post(r, 'messages', 'send', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form));
        assert.match(res.body, message);
        assert.ok(!r.calls.some((c) => c.name === 'postBotMessage'), 'nothing posted');
    }
});

test('messages/send: link buttons are https only, label and link both needed, at most 3 fields', async () => {
    for (const [form, message] of [
        [{ button1Label: 'Site', button1Url: 'http://example.com' }, /Button 1: the link must be a full https:\/\/ link/],
        [{ button2Label: 'Site', button2Url: 'javascript:alert(1)' }, /Button 2: the link must be a full https:\/\/ link/],
        [{ button1Label: 'Site', button1Url: 'https://user:pw@example.com' }, /Button 1: the link must be a full https:\/\/ link/],
        [{ button3Label: 'Site' }, /Button 3 needs both a label and a link/],
        [{ button1Url: 'https://example.com' }, /Button 1 needs both a label and a link/],
        [{ button1Label: 'x'.repeat(81), button1Url: 'https://example.com' }, /at most 80 characters/],
    ]) {
        const r = await setup();
        const res = await post(r, 'messages', 'send', { channelId: TEXT, content: 'hi', ...form });
        assert.equal(res.statusCode, 400, JSON.stringify(form));
        assert.match(res.body, message);
        assert.ok(!r.calls.some((c) => c.name === 'postBotMessage'));
    }
    const ok = await setup();
    await postConfirmed(ok, 'messages', 'send', { channelId: TEXT, content: 'hi', button1Label: 'A', button1Url: 'https://a.example', button3Label: 'C', button3Url: 'https://c.example/x?y=1' });
    assert.deepEqual(ok.calls.find((c) => c.name === 'postBotMessage').args[4], [{ label: 'A', url: 'https://a.example' }, { label: 'C', url: 'https://c.example/x?y=1' }]);
});

test('messages: home templates in Mewvo\'s own server: New moderators pings only the picked members; changelog and server count are filled', async () => {
    const h = await setup();
    const page = (await get(h, 'messages')).body;
    assert.match(page, /<optgroup label="Mewvo \(only in Mewvo&#39;s own servers\)"><option value="mewvo-new-mods">New moderator\(s\)<\/option>/);
    assert.ok(!page.includes('name="mod1"'), 'no member pickers without the template');

    const mods = await run(h, h.d.modulePage, { method: 'GET', params: { module: 'messages' }, headers: { cookie: h.cookie }, query: { template: 'mewvo-new-mods', lang: 'de', mod1: MEMBER } });
    assert.equal(mods.statusCode, 200);
    assert.match(mods.body, /name="template" value="mewvo-new-mods"/, 'the template id goes along with the forms');
    assert.match(mods.body, new RegExp(`name="mod1" value="${MEMBER}"`), 'picked member kept');
    assert.ok(mods.body.includes('name="mod5"'));
    assert.match(mods.body, /value="Neue Moderatoren"/, 'German text filled in');
    assert.match(mods.body, /Language: Deutsch\./);

    // {mods} → the picked members' mentions; only they get pinged.
    const form = { template: 'mewvo-new-mods', channelId: TEXT, title: 'New moderators', description: 'Welcome {mods}.', mod1: MEMBER, mod2: `<@${OWNER}>` };
    assert.equal((await postConfirmed(h, 'messages', 'send', form)).statusCode, 303);
    const [, , embed, ping] = h.calls.find((c) => c.name === 'postBotMessage').args;
    assert.equal(embed.description, `Welcome <@${MEMBER}>, <@${OWNER}>.`);
    assert.deepEqual(ping, { everyone: false, roleIds: [], userIds: [MEMBER, OWNER] });
    const missing = await post(h, 'messages', 'send', { ...form, mod1: '', mod2: '' });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.body, /Pick at least one moderator for \{mods\}/);
    const schedule = await post(h, 'messages', 'schedule', { ...form, repeat: 'daily', time: '10:00', timezone: 'UTC' });
    assert.equal(schedule.statusCode, 400, 'members are pinged only from Send');
    assert.match(schedule.body, /New moderators template/);

    const changelog = await run(h, h.d.modulePage, { method: 'GET', params: { module: 'messages' }, headers: { cookie: h.cookie }, query: { template: 'mewvo-changelog', lang: 'en' } });
    assert.match(changelog.body, /name="entry" value="2026-11-08:public" checked/);
    assert.match(changelog.body, /Mewvo is public: any server can add it/);
    const count = await run(h, h.d.modulePage, { method: 'GET', params: { module: 'messages' }, headers: { cookie: h.cookie }, query: { template: 'mewvo-server-count' } });
    assert.match(count.body, /value="Mewvo is now in 2 servers"/, 'client.guilds.cache.size');
});

test('messages/scheduled: the list shows channel, next run in its zone, repeat, last result and the right buttons; text is escaped', async () => {
    const h = await setup();
    h.state.config.birthdayTimezone = 'Europe/Vilnius';
    const page = await get(h, 'messages');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('action="/dashboard/messages/schedule"'), 'schedule form');
    assert.match(page.body, /2 of 50 scheduled messages/);
    assert.ok(page.body.includes('Daily &lt;b&gt;reminder&lt;/b&gt;'), 'message text escaped');
    assert.ok(!page.body.includes('<b>reminder'), 'never raw');
    assert.match(page.body, /Mon, Wed, Fri at 09:00/);
    assert.match(page.body, /Every 6 hours from 2026-01-01 08:00/);
    assert.match(page.body, /<span class="muted">Europe\/Vilnius<\/span>/, 'next run in the message\'s own zone');
    assert.match(page.body, /missing Send Messages[\s\S]*3 of 3 failures/);
    assert.match(page.body, /state-warn">paused/);
    assert.ok(page.body.includes('name="paused" value="false"'), 'Resume for the paused one');
    assert.ok(page.body.includes('name="paused" value="true"'), 'Pause for the active one');
    assert.ok(page.body.includes('data-confirm="Delete scheduled message #1? This cannot be undone."'), 'delete confirms');
    assert.ok(page.body.includes('id="edit-1"') && page.body.includes('action="/dashboard/messages/schedule-edit"'), 'edit form per message');
    assert.ok(page.body.includes('value="Europe/Vilnius" maxlength="64" list="tz-zones"'), 'new schedule defaults to the server time zone');
    assert.ok(page.body.includes('<datalist id="tz-zones">') && page.body.includes('<option value="America/New_York">'), 'time zone picker');
    assert.ok(!/style=|<script(?! src)/.test(page.body.replace(ALLOWED_SCRIPT, '')), 'no inline style or script (CSP)');
});

test('messages/schedule: the message and schedule reach the service (zone canonicalised, weekdays from the boxes); edit prefills', async () => {
    const h = await setup();
    assert.equal((await post(h, 'messages', 'schedule', CASES.messages.schedule.form)).statusCode, 303);
    const [input] = h.calls.find((c) => c.name === 'createScheduledMessage').args;
    assert.equal(input.channelId, TEXT);
    assert.deepEqual(input.payload, { content: 'Weekly @everyone', embed: null });
    assert.deepEqual(input.schedule, { kind: 'weekly', time: '18:30', days: [1, 5] });
    assert.equal(input.timezone, 'Europe/Vilnius');
    assert.equal(input.createdBy, ADMIN);
    assert.match((await h.sessions.get(h.session.id)).flash, /Scheduled message #3 saved for #general: Mon, Fri at 18:30 \(Europe\/Vilnius\)/);

    const daily = await setup();
    await post(daily, 'messages', 'schedule', { channelId: TEXT, title: 'Hello', colour: 'red', repeat: 'daily', time: '07:05', timezone: '' });
    const [d] = daily.calls.find((c) => c.name === 'createScheduledMessage').args;
    assert.deepEqual(d.schedule, { kind: 'weekly', time: '07:05', days: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(d.timezone, 'UTC', 'empty zone → UTC');
    assert.equal(d.payload.embed.title, 'Hello');

    for (const [form, message] of [
        [{ channelId: TEXT, content: 'x', repeat: 'once', date: '2099-01-01', time: '10:00', timezone: 'Mars/Base' }, /that time zone is not known/],
        [{ channelId: TEXT, content: 'x', repeat: 'hours', date: '2099-01-01', time: '10:00', hours: '500', timezone: 'UTC' }, /between 1 and 168/],
        [{ channelId: TEXT, repeat: 'daily', time: '10:00', timezone: 'UTC' }, /nothing to post/],
        [{ channelId: TEXT, content: 'x', repeat: 'once', date: '2099-02-30', time: '10:00', timezone: 'UTC' }, /Date: use YYYY-MM-DD/],
    ]) {
        const r = await setup();
        const res = await post(r, 'messages', 'schedule', form);
        assert.equal(res.statusCode, 400, String(message));
        assert.match(res.body, message);
        assert.ok(!r.calls.some((c) => c.name === 'createScheduledMessage'), 'nothing saved');
    }

    const page = await get(h, 'messages');
    const edit2 = page.body.slice(page.body.indexOf('id="edit-2"'));
    assert.ok(edit2.includes('<option value="hours" selected>'), 'repeat prefilled');
    assert.ok(edit2.includes('name="hours" value="6"'), 'hours prefilled');
    assert.ok(edit2.includes('<option value="purple" selected>'), 'colour prefilled');
});

test('messages/schedule-*: pause, resume and run now report clearly; a paused one cannot be paused again', async () => {
    const h = await setup();
    const again = await post(h, 'messages', 'schedule-pause', { id: '2', paused: 'true' });
    assert.equal(again.statusCode, 303);
    assert.ok(!h.calls.some((c) => c.name === 'setScheduledMessagePaused'), 'nothing to change');
    assert.match((await h.sessions.get(h.session.id)).flash, /already paused/);
    await post(h, 'messages', 'schedule-pause', { id: '2', paused: 'false' });
    assert.deepEqual(h.calls.find((c) => c.name === 'setScheduledMessagePaused').args, [2, false]);
    assert.match((await h.sessions.get(h.session.id)).flash, /#2 resumed\. Next post/);
    await post(h, 'messages', 'schedule-run', { id: '1' });
    assert.match((await h.sessions.get(h.session.id)).flash, /#1 posted in #general/);
    assert.equal(h.auditRows.find((r) => r.key === 'scheduled.1.run').new.messageId, '710000000000000014');
});

test('messages: a channel where the bot lacks a permission is refused clearly, nothing posted', async () => {
    const { PermissionFlagsBits } = await import('discord.js');
    const h = await setup();
    h.guild.members.me.permissionsIn = () => ({ has: (p) => p !== PermissionFlagsBits.EmbedLinks });
    // Plain text needs no Embed Links; a box (embed) does, and the refusal offers Fix permissions.
    assert.equal((await postConfirmed(h, 'messages', 'send', { channelId: TEXT, content: 'hi' })).statusCode, 303, 'plain text posts without Embed Links');
    assert.equal(h.calls.filter((c) => c.name === 'postBotMessage').length, 1);
    const res = await post(h, 'messages', 'send', { channelId: TEXT, content: 'hi', title: 'Box' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /I am missing Embed Links in #general\.[^<]*Nothing was posted\./);
    assert.match(res.body, /href="\/dashboard\/fix-permissions\?channel=500000000000000001&amp;need=EmbedLinks">Fix permissions<\/a>/);
    assert.equal(h.calls.filter((c) => c.name === 'postBotMessage').length, 1, 'the embed post was not sent');

    const p = await setup();
    p.guild.members.me.permissionsIn = () => ({ has: (perm) => perm !== PermissionFlagsBits.AddReactions });
    assert.equal((await post(p, 'messages', 'countdown', CASES.messages.countdown.form)).statusCode, 303, 'countdown needs no reactions');
    assert.equal((await post(p, 'messages', 'poll', CASES.messages.poll.form)).statusCode, 303, 'a Discord poll needs no reactions');
    const poll = await post(p, 'messages', 'poll', { ...CASES.messages.poll.form, anonymous: '1' });
    assert.equal(poll.statusCode, 400);
    assert.match(poll.body, /missing Add Reactions/);
    assert.ok(!p.calls.some((c) => c.name === 'createPoll'));

    const n = await setup();
    n.guild.members.me.permissionsIn = () => ({ has: (perm) => perm !== PermissionFlagsBits.SendPolls });
    const native = await post(n, 'messages', 'poll', CASES.messages.poll.form);
    assert.equal(native.statusCode, 400);
    assert.match(native.body, /missing Send Polls/);
    assert.ok(!n.calls.some((c) => c.name === 'createNativePoll'));
    assert.equal((await post(n, 'messages', 'poll', { ...CASES.messages.poll.form, anonymous: '1' })).statusCode, 303, 'a reaction poll needs no Send Polls');
});

test('messages/poll: a Discord poll by default (hours, multiple answers, Discord limits); anonymous keeps the reaction poll', async () => {
    const h = await setup();
    assert.equal((await post(h, 'messages', 'poll', CASES.messages.poll.form)).statusCode, 303);
    assert.deepEqual(h.calls.find((c) => c.name === 'createNativePoll').args, [TEXT, 'Pizza?', ['Yes', 'No', 'Maybe'], 48, true]);
    assert.ok(!h.calls.some((c) => c.name === 'createPoll'));
    assert.match((await h.sessions.get(h.session.id)).flash, /Poll posted in #general\. It closes 2026-11-04 12:00 UTC/);
    assert.deepEqual(h.auditRows.find((r) => r.key === 'poll.710000000000000015').new,
        { channelId: TEXT, question: 'Pizza?', options: ['Yes', 'No', 'Maybe'], durationHours: 48, multiSelect: true, anonymous: false });

    const d = await setup();
    await post(d, 'messages', 'poll', { channelId: TEXT, question: 'Q', options: 'a\nb' });
    assert.deepEqual(d.calls.find((c) => c.name === 'createNativePoll').args, [TEXT, 'Q', ['a', 'b'], 24, false], 'defaults: 24 hours, one answer');

    for (const [hours, ok] of [['0', false], ['1', true], ['168', true], ['169', false], ['2.5', false]]) {
        const x = await setup();
        const res = await post(x, 'messages', 'poll', { channelId: TEXT, question: 'Q', options: 'a\nb', hours });
        assert.equal(res.statusCode, ok ? 303 : 400, `hours ${hours}`);
        if (!ok) assert.match(res.body, /Open for \(hours\)/);
    }
    const longOpt = await setup();
    const tooLong = await post(longOpt, 'messages', 'poll', { channelId: TEXT, question: 'Q', options: `a\n${'x'.repeat(56)}` });
    assert.equal(tooLong.statusCode, 400);
    assert.match(tooLong.body, /limited to 55 characters in a Discord poll/);
    assert.ok(!longOpt.calls.length, 'nothing posted');
    const anonLong = await setup();
    await post(anonLong, 'messages', 'poll', { channelId: TEXT, question: 'Q', options: `a\n${'x'.repeat(56)}`, anonymous: '1' });
    assert.ok(anonLong.calls.some((c) => c.name === 'createPoll'), 'a reaction poll still takes up to 100 characters');
    const longQ = await setup();
    const q = await post(longQ, 'messages', 'poll', { channelId: TEXT, question: 'q'.repeat(301), options: 'a\nb' });
    assert.equal(q.statusCode, 400);
});

test('messages/poll-end: ends the linked poll; bad links and other servers refused before the service; service refusals shown', async () => {
    const h = await setup();
    const res = await post(h, 'messages', 'poll-end', { link: POLL_LINK });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.calls.find((c) => c.name === 'endPoll').args, [POLL_LINK]);
    assert.match((await h.sessions.get(h.session.id)).flash, /Poll ended in #general/);
    assert.deepEqual(h.auditRows.map((r) => r.key), ['poll.710000000000000015.ended']);

    const other = await setup();
    const elsewhere = await post(other, 'messages', 'poll-end', { link: 'https://discord.com/channels/100000000000000999/500000000000000001/710000000000000015' });
    assert.equal(elsewhere.statusCode, 400);
    assert.match(elsewhere.body, /another server/);
    assert.ok(!other.calls.length);

    const ended = await setup();
    ended.state.endPollError = 'That poll has already ended.';
    const again = await post(ended, 'messages', 'poll-end', { link: POLL_LINK });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /already ended/);
    assert.equal(ended.auditRows.length, 0);
});

test('messages/poll (anonymous) and countdown: options one per line, reaction shortfall in the flash; duration limits', async () => {
    const h = await setup();
    await post(h, 'messages', 'poll', { ...CASES.messages.poll.form, anonymous: '1' });
    assert.deepEqual(h.calls.find((c) => c.name === 'createPoll').args, [TEXT, 'Pizza?', ['Yes', 'No', 'Maybe'], true]);
    assert.ok(!h.calls.some((c) => c.name === 'createNativePoll'));
    const few = await setup();
    few.state.pollReactions = 1;
    await post(few, 'messages', 'poll', { ...CASES.messages.poll.form, anonymous: '1' });
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

// ── welcome embeds and images, bot settings, random member, short links ────

test('welcome embed: title, colour, footer and image saved as /greet stores them; the "only with /greet" note is gone', async () => {
    const h = await setup();
    h.state.welcome.welcomeEmbed = { title: 'Old', color: 0x00ff00, thumbnail: true };
    h.state.welcome.welcomeImageRef = { channelId: TEXT, messageId: PANEL, url: 'https://cdn.example/stored.png' };
    const page = await get(h, 'welcome');
    assert.doesNotMatch(page.body, /edited with \/greet|only with \/greet/);
    assert.match(page.body, /name="welcomeColor" value="#00FF00"/);
    const res = await post(h, 'welcome', 'welcome-embed', CASES.welcome['welcome-embed'].form);
    assert.equal(res.statusCode, 303);
    const patch = h.calls.find((c) => c.name === 'updateWelcomeSettings').args[0];
    assert.deepEqual(patch.welcomeEmbed, { title: 'Hi {user}', color: 0x112233, thumbnail: true, footer: 'Enjoy' });
    assert.equal(patch.welcomeImage, 'https://example.com/a.png');
    assert.equal(patch.welcomeImageRef, null, 'a stored upload is dropped once the link changes');
    assert.ok(h.auditRows.some((r) => r.key === 'welcomeImage' && r.new === 'https://example.com/a.png'));

    // Empty fields remove the value (the defaults apply); the same link keeps its stored upload.
    const k = await setup();
    Object.assign(k.state.welcome, { welcomeEmbed: { title: 'T', footer: 'F', color: 1 }, welcomeImage: 'https://cdn.example/stored.png', welcomeImageRef: { channelId: TEXT, messageId: PANEL, url: 'https://cdn.example/stored.png' } });
    await post(k, 'welcome', 'welcome-embed', { welcomeTitle: '', welcomeColor: '', welcomeFooter: 'F', welcomeImage: 'https://cdn.example/stored.png' });
    const kept = k.calls.find((c) => c.name === 'updateWelcomeSettings').args[0];
    assert.deepEqual(kept, { welcomeEmbed: { footer: 'F' } }, 'only the embed changed; image and its stored copy kept');
});

test('welcome/goodbye image links: https only, length capped, expired Discord links refused, fresh ones warned', async () => {
    const bad = [
        [{ welcomeImage: 'ftp://example.com/a.png' }, /must start with https/],
        [{ welcomeImage: 'not a url' }, /not a valid link/],
        [{ welcomeImage: `https://example.com/${'a'.repeat(2050)}` }, /Too long: at most 2048/],
        [{ welcomeImage: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=1&hm=1' }, /has expired/],
        [{ welcomeTitle: 'x'.repeat(257) }, /at most 256/],
        [{ welcomeColor: '#12345' }, /hex colour/],
    ];
    for (const [form, message] of bad) {
        const h = await setup();
        const res = await post(h, 'welcome', 'welcome-embed', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form).slice(0, 80));
        assert.match(res.body, message);
        assert.ok(!h.calls.some((c) => c.name === 'updateWelcomeSettings'));
    }
    const h = await setup();
    const fresh = `https://cdn.discordapp.com/attachments/1/2/a.png?ex=${Math.floor(Date.now() / 1000 + 86400).toString(16)}&is=1&hm=1`;
    assert.equal((await post(h, 'welcome', 'welcome-embed', { welcomeImage: fresh })).statusCode, 303);
    assert.match((await h.sessions.get(h.session.id)).flash, /stop working after about a day/);
});

test('goodbye embed: the image goes into leaveEmbed.image; clearing it removes it', async () => {
    const h = await setup();
    h.state.welcome.leaveEmbed = { title: '👋 Goodbye', color: 0xff0000, image: { url: 'https://old.example/x.png' } };
    const page = await get(h, 'welcome');
    assert.match(page.body, /name="goodbyeImage" value="https:\/\/old.example\/x.png"/, 'older { url } images are shown');
    await post(h, 'welcome', 'goodbye-embed', CASES.welcome['goodbye-embed'].form);
    const patch = h.calls.find((c) => c.name === 'updateWelcomeSettings').args[0];
    assert.deepEqual(patch.leaveEmbed, { title: 'Bye', color: 0xaa0000, image: 'https://example.com/b.gif' });
    await post(h, 'welcome', 'goodbye-embed', { goodbyeTitle: 'Bye', goodbyeColor: '#AA0000', goodbyeImage: '' });
    const cleared = h.calls.filter((c) => c.name === 'updateWelcomeSettings')[1].args[0];
    assert.deepEqual(cleared.leaveEmbed, { title: 'Bye', color: 0xaa0000 });
});

test('welcome image upload: stored with the /greet store in the audit log channel, saved as /greet saves it, audited, one mod-log line', async () => {
    const h = await setup();
    const channel = withImageStore(h.state, h.guild);
    const res = await uploadPost(h, 'welcome-image-upload');
    assert.equal(res.statusCode, 303, String(res.body).match(/role="alert">([^<]*)/)?.[1]);
    assert.equal(res.redirectedTo, '/dashboard/welcome');
    // The same function as /greet dashboard (utils/welcomeImageStore.js), with the checked bytes.
    const [store] = h.calls.filter((c) => c.name === 'storeWelcomeImage');
    assert.ok(Buffer.isBuffer(store.args[0].data));
    assert.equal(store.args[0].name, 'welcome-image.png', 'the file name is ours, not the uploaded one');
    assert.deepEqual(store.args[1], [TEXT]);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].files[0].attachment, store.args[0].data, 'the bytes are re-posted, not a link');
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    const patch = h.calls.find((c) => c.name === 'updateWelcomeSettings').args[0];
    assert.deepEqual(patch, {
        welcomeImage: STORED_URL,
        welcomeImageRef: { channelId: TEXT, messageId: '800000000000000099', url: STORED_URL },
    });
    assert.ok(h.auditRows.some((r) => r.key === 'welcomeImage' && r.new === STORED_URL));
    assert.equal(h.auditRows[0].module, 'welcome');
    assert.equal(h.calls.filter((c) => c.name === 'postModLog').length, 1);
    assert.match((await h.sessions.get(h.session.id)).flash, /Welcome image uploaded\. A copy is kept in #general/);

    // The page: a preview from the stored message's fresh link, where the copy is kept, Remove image.
    const page = await get(h, 'welcome');
    assert.match(page.body, /<img class="image-preview" src="https:\/\/cdn\.discordapp\.com\/attachments\/[^"]*&amp;fresh=1" alt="Current welcome image"/);
    assert.match(page.body, /a copy is kept in #general/);
    assert.match(page.body, /action="\/dashboard\/welcome\/welcome-image-upload" class="settings-form" enctype="multipart\/form-data"/);
    assert.match(page.body, /action="\/dashboard\/welcome\/welcome-image-remove"/);
    assert.doesNotMatch(page.body, /action="\/dashboard\/welcome\/goodbye-image-remove"/, 'no Remove without a goodbye image');
    assert.doesNotMatch(page.body, /style=|<script(?! src)/);
});

test('goodbye image upload: into leaveEmbed.image with goodbyeImageRef (as /greet); Remove clears both and keeps the embed', async () => {
    const h = await setup();
    withImageStore(h.state, h.guild);
    h.state.welcome.leaveEmbed = { title: 'Bye', color: 1, image: 'https://old.example/x.png' };
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
    assert.equal((await uploadPost(h, 'goodbye-image-upload', { file: { name: 'x.gif', type: 'image/gif', data: gif } })).statusCode, 303);
    const url = STORED_URL.replace('welcome-image.png', 'goodbye-image.gif');
    const patch = h.calls.find((c) => c.name === 'updateWelcomeSettings').args[0];
    assert.deepEqual(patch, { leaveEmbed: { title: 'Bye', color: 1, image: url }, goodbyeImageRef: { channelId: TEXT, messageId: '800000000000000099', url } });

    const removed = await post(h, 'welcome', 'goodbye-image-remove', {});
    assert.equal(removed.statusCode, 303);
    const cleared = h.calls.filter((c) => c.name === 'updateWelcomeSettings')[1].args[0];
    assert.deepEqual(cleared, { leaveEmbed: { title: 'Bye', color: 1 }, goodbyeImageRef: null });
    assert.ok(h.auditRows.some((r) => r.key === 'goodbyeImageRef' && r.new === null));
    // Nothing left to remove: nothing changes.
    const again = await post(h, 'welcome', 'welcome-image-remove', {});
    assert.equal(again.statusCode, 303);
    assert.match((await h.sessions.get(h.session.id)).flash, /Nothing changed/);
});

test('welcome image upload refused: wrong type, too large, no file, no audit channel, bot cannot post; error in the form, nothing saved', async () => {
    const cases = [
        [{ file: { name: 'evil.png', type: 'image/png', data: Buffer.from('<script>alert(1)</script>') } }, 400, /not a PNG, JPEG, GIF or WebP/],
        [{ file: { name: 'big.png', type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]) } }, 413, /larger than 8 MB/],
        [{ file: null }, 400, /Choose an image file/],
    ];
    for (const [options, status, message] of cases) {
        const h = await setup();
        const channel = withImageStore(h.state, h.guild);
        const res = await uploadPost(h, 'welcome-image-upload', options);
        assert.equal(res.statusCode, status, String(message));
        assert.match(res.body, message);
        assert.match(res.body, /action="\/dashboard\/welcome\/welcome-image-upload"[^>]*><p class="error form-error" role="alert" id="form-error">Not saved: /, 'the error sits in the upload form');
        assert.match(res.body, /name="image" aria-invalid="true"/);
        assert.equal(channel.sent.length, 0);
        assert.ok(!h.calls.some((c) => c.name === 'updateWelcomeSettings'));
        assert.equal(h.auditRows.length, 0);
        assert.ok(!h.calls.some((c) => c.name === 'postModLog'));
    }

    const noChannel = await setup();
    const res = await uploadPost(noChannel, 'welcome-image-upload');
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /no main log channel is set/);
    assert.ok(!noChannel.calls.some((c) => c.name === 'updateWelcomeSettings'));

    const cannot = await setup();
    const channel = withImageStore(cannot.state, cannot.guild);
    channel.permissionsFor = () => ({ has: () => false });
    const refused = await uploadPost(cannot, 'welcome-image-upload');
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /could not post the picture in the main log channel \(#general\)/);
    assert.equal(channel.sent.length, 0);
    assert.ok(!cannot.calls.some((c) => c.name === 'updateWelcomeSettings'));

    // A failed save deletes the copy it just posted.
    const failing = await setup();
    const store = withImageStore(failing.state, failing.guild);
    failing.svc.updateWelcomeSettings = async () => { throw new Error('database not responding'); };
    await assert.rejects(() => uploadPost(failing, 'welcome-image-upload'), /database not responding/);
    assert.deepEqual(store.deleted, ['800000000000000099']);
});

test('welcome image upload: CSRF, Origin, edit switch, Administrator; files only for upload actions', async () => {
    const check = async (h, options, label) => {
        const channel = withImageStore(h.state, h.guild);
        const res = await uploadPost(h, 'welcome-image-upload', options);
        assert.equal(res.statusCode, 403, label);
        assert.equal(channel.sent.length, 0, `${label}: nothing posted`);
        assert.equal(h.auditRows.length, 0, `${label}: no audit row`);
        return res;
    };
    await check(await setup(), { csrf: null }, 'no CSRF');
    await check(await setup(), { csrf: 'A'.repeat(32) }, 'wrong CSRF');
    await check(await setup(), { origin: 'https://evil.example' }, 'bad Origin');
    const off = await check(await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } }), {}, 'editing off');
    assert.match(off.body, /Editing is off/);
    await check(await setup({ userId: OWNER }), {}, 'OWNER_IDS without Administrator');

    // Any other settings form refuses a multipart body without reading it.
    const h = await setup();
    const res = fakeRes();
    const req = { method: 'POST', params: { module: 'welcome', action: 'welcome-embed' }, query: {}, headers: { cookie: h.cookie, origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } };
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    assert.ok(passed);
    let next = false;
    await h.d.moduleUploadBody(req, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(res.statusCode, 415);
    // A urlencoded form passes on untouched.
    const plain = { ...req, headers: { ...req.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: { csrf: 'x' } };
    let passedOn = false;
    await h.d.moduleUploadBody(plain, fakeRes(), () => { passedOn = true; });
    assert.ok(passedOn);
});

test('welcome image upload through the real router (Express reads the multipart body after login): 303 and stored', async () => {
    const express = (await import('express')).default;
    const http = await import('node:http');
    const { dashboardRouter } = await import('../src/services/dashboard/routes.js');
    const h = await setup();
    const channel = withImageStore(h.state, h.guild);
    const app = express();
    app.use('/dashboard', dashboardRouter(h.d));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const body = multipartBody({ csrf: h.session.csrf }, { name: 'cat.png', type: 'image/png', data: PNG });
        const result = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/dashboard/welcome/welcome-image-upload',
                headers: { cookie: h.cookie, origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': String(body.length) },
            }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); });
            req.on('error', reject);
            req.end(body);
        });
        assert.equal(result.status, 303);
        assert.equal(result.location, '/dashboard/welcome');
        assert.equal(channel.sent.length, 1);
        assert.equal(h.state.welcome.welcomeImage, STORED_URL);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('bot settings: prefix as /configwizard checks it; moderator role never @everyone, a bot role or a role the bot hands out', async () => {
    const h = await setup();
    const page = await get(h, 'commands');
    assert.match(page.body, /Bot settings/);
    assert.match(page.body, /action="\/dashboard\/commands\/bot-settings"/);
    assert.equal((await post(h, 'commands', 'bot-settings', { prefix: '?', modRole: ROLE_DANGER })).statusCode, 303);
    assert.deepEqual(h.calls.filter((c) => c.name === 'updateConfigSetting').map((c) => c.args), [['prefix', '?'], ['modRole', ROLE_DANGER]]);
    assert.ok(h.auditRows.some((r) => r.key === 'modRole' && r.new === ROLE_DANGER));
    // Only changed keys are written; clearing the role writes null.
    await post(h, 'commands', 'bot-settings', { prefix: '?', modRole: '' });
    assert.deepEqual(h.calls.filter((c) => c.name === 'updateConfigSetting').slice(2).map((c) => c.args), [['modRole', null]]);

    for (const [form, message] of [
        [{ prefix: '', modRole: '' }, /The prefix must be 1 to 10/],
        [{ prefix: 'x'.repeat(11), modRole: '' }, /The prefix must be 1 to 10/],
        [{ prefix: '!', modRole: GUILD }, /@everyone/],
        [{ prefix: '!', modRole: ROLE_MANAGED }, /managed/],
        [{ prefix: '!', modRole: ROLE_OK }, /auto role given on join/],
        [{ prefix: '!', modRole: ROLE_OK2 }, /a reaction role/],
        [{ prefix: '!', modRole: MISSING }, /not in the server/],
    ]) {
        const b = await setup();
        const res = await post(b, 'commands', 'bot-settings', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form));
        assert.match(res.body, message);
        assert.ok(!b.calls.some((c) => c.name === 'updateConfigSetting'));
    }
});

test('shorten a link: the short link is shown on the page and audited; service errors are shown, nothing audited', async () => {
    const h = await setup();
    await post(h, 'commands', 'shorten', { url: 'https://example.com/x', custom: 'mine' });
    assert.deepEqual(h.calls.find((c) => c.name === 'shortenUrl').args, ['https://example.com/x', 'mine']);
    assert.match((await h.sessions.get(h.session.id)).flash, /Short link: https:\/\/is\.gd\/abc123/);
    const page = await get(h, 'commands');
    assert.match(page.body, /is\.gd\/abc123/);
    assert.ok(h.auditRows.some((r) => r.key === 'shortLink'));
    const down = await setup();
    const res = await post(down, 'commands', 'shorten', { url: 'https://example.com/x', custom: 'down' });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Unable to reach the URL shortener/);
    assert.equal(down.auditRows.length, 0);
});

test('random member: filters passed as /tools randomuser has them; the pick is shown (escaped) and audited', async () => {
    const h = await setup();
    await post(h, 'giveaways', 'random-member', { roleId: ROLE_MANAGED, includeBots: '1', onlineOnly: '1' });
    assert.deepEqual(h.calls.find((c) => c.name === 'pickRandomMember').args[0], { roleId: ROLE_MANAGED, includeBots: true, onlineOnly: true });
    assert.match((await h.sessions.get(h.session.id)).flash, new RegExp(`Picked @member<b> \\(${MEMBER}\\) from 3 matching members`));
    const page = await get(h, 'giveaways');
    assert.ok(page.body.includes('member&lt;b&gt;'));
    assert.ok(!page.body.includes('member<b>'));
    const row = h.auditRows.find((r) => r.key === 'randomMember');
    assert.equal(row.new.userId, MEMBER);
    const none = await setup();
    await post(none, 'giveaways', 'random-member', {});
    assert.deepEqual(none.calls.find((c) => c.name === 'pickRandomMember').args[0], { roleId: null, includeBots: false, onlineOnly: false });
});

// ── admin actions that replace slash commands ────────────────────────────

test('applications: submitted list (pending first, answers escaped); review sends the decision through the shared service', async () => {
    const h = await setup();
    const page = await get(h, 'applications');
    const section = page.body.slice(page.body.indexOf('id="s-submitted"'), page.body.indexOf('id="s-application-roles"'));
    assert.match(section, /1 waiting/);
    assert.ok(section.includes('I like &lt;i&gt;cats&lt;/i&gt;'), 'answers escaped');
    assert.ok(section.includes('member&lt;b&gt;'));
    assert.ok(section.includes('action="/dashboard/applications/review"'));
    assert.ok(section.indexOf('1700000000000-abc') < section.indexOf('Recently reviewed'), 'pending before reviewed');
    assert.match(section.slice(section.indexOf('Recently reviewed')), /stranger[\s\S]*Not now/);
    const res = await post(h, 'applications', 'review', { id: '1700000000000-abc', decision: 'deny', note: 'Too new' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.calls.find((c) => c.name === 'reviewApplicationAndNotify').args, ['1700000000000-abc', 'deny', 'Too new', ADMIN]);
    assert.equal(h.auditRows.at(-1).key, 'applications.submitted.1700000000000-abc');
    assert.equal(h.auditRows.at(-1).new.status, 'denied');
    assert.match((await h.sessions.get(h.session.id)).flash, /denied/);
    // Already reviewed: the service refuses; nothing audited.
    const again = await post(h, 'applications', 'review', { id: '1700000000000-abc', decision: 'approve' });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /already been reviewed/);
    assert.equal(h.auditRows.length, 1);
});

test('applications: approve reports a failed DM and a failed role in the flash; owners without Administrator only see it', async () => {
    const h = await setup();
    h.state.dmFails = true;
    h.state.roleFails = true;
    assert.equal((await post(h, 'applications', 'review', { id: '1700000000000-abc', decision: 'approve' })).statusCode, 303);
    const flash = (await h.sessions.get(h.session.id)).flash;
    assert.match(flash, /approved/);
    assert.match(flash, /could not be DMed/);
    assert.match(flash, /role could not be given/);
    const o = await setup({ userId: OWNER });
    const page = await get(o, 'applications');
    const section = page.body.slice(page.body.indexOf('id="s-submitted"'), page.body.indexOf('id="s-application-roles"'));
    assert.match(section, /To review applications here you need the Administrator permission/);
    assert.ok(!section.includes('Send decision'), 'no submit button for owners without Administrator');
    assert.equal((await post(o, 'applications', 'review', { id: '1700000000000-abc', decision: 'approve' })).statusCode, 403);
    assert.equal(o.calls.length, 0);
});

test('community: open suggestions listed (escaped) with a decision form; the decision is audited with old and new status', async () => {
    const h = await setup();
    const page = await get(h, 'community');
    const section = page.body.slice(page.body.indexOf('id="s-open-suggestions"'));
    assert.ok(section.includes('More &lt;b&gt;cats&lt;/b&gt;'));
    assert.ok(section.includes('action="/dashboard/community/suggestion-status"'));
    assert.match(section, /<option value="considering">Under consideration<\/option>/);
    const res = await post(h, 'community', 'suggestion-status', { id: '4', status: 'denied', reason: 'Not now' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.calls.find((c) => c.name === 'decideSuggestion').args, [4, 'denied', 'Not now', ADMIN]);
    const row = h.auditRows.at(-1);
    assert.equal(row.key, 'suggestion.4');
    assert.deepEqual(row.old, { status: 'pending', reason: null });
    assert.deepEqual(row.new, { status: 'denied', reason: 'Not now' });
    // Denied suggestions are closed: no longer listed.
    assert.ok(!(await get(h, 'community')).body.includes('More &lt;b&gt;cats'));
    const bad = await post(h, 'community', 'suggestion-status', { id: '4', status: 'implemented' });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /Decision: unknown choice/);
    h.state.dmFails = true;
    await post(h, 'community', 'suggestion-status', { id: '4', status: 'considering' });
    assert.match((await h.sessions.get(h.session.id)).flash, /could not be DMed/);
});

test('tickets: block from modmail (with reason in the audit); already blocked changes nothing; an open conversation is named', async () => {
    const h = await setup();
    const page = await get(h, 'tickets');
    assert.ok(page.body.includes('action="/dashboard/tickets/block"'));
    h.state.modmailOpen[STRANGER] = { id: TEXT, name: 'modmail-stranger' };
    const res = await post(h, 'tickets', 'block', { userId: STRANGER, reason: 'spam <b>' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.calls.find((c) => c.name === 'setModmailBlocked').args, [STRANGER, true]);
    assert.deepEqual(h.state.config.modmailBlocked, [MEMBER, STRANGER]);
    assert.deepEqual(h.auditRows.map((r) => r.key), ['modmailBlocked', `modmailBlocked.${STRANGER}.reason`]);
    assert.match((await h.sessions.get(h.session.id)).flash, /open conversation #modmail-stranger stays/);
    const again = await setup();
    assert.equal((await post(again, 'tickets', 'block', { userId: MEMBER })).statusCode, 303);
    assert.equal(again.calls.filter((c) => c.name === 'setModmailBlocked').length, 0);
    assert.equal(again.auditRows.length, 0);
    assert.match((await again.sessions.get(again.session.id)).flash, /already blocked/);
});

// ── Automod live operations (/automod queue, probation, lockdown-end, stats days) ──

test('Automod heads-up first: a checkbox per eligible rule, 30-day counts, saved and audited with the rule modes', async () => {
    const h = await setup();
    const page = await get(h, 'automod');
    assert.equal(page.statusCode, 200);
    for (const key of ['disrespect', 'harassment', 'sexual', 'language', 'privacy', 'custom']) {
        assert.ok(page.body.includes(`name="headsup:${key}" value="1" checked`), key);
    }
    for (const key of ['scam', 'nsfw', 'advertising', 'mentions', 'spam', 'impersonation', 'caps']) {
        assert.ok(!page.body.includes(`name="headsup:${key}"`), key);
    }
    assert.ok(page.body.includes('name="headsup-form" value="1"'));
    assert.match(page.body, /Private first warnings in the last 30 days: 7 sent, 5 fixed by the member, 2 acted on after the wait\./);
    assert.equal(h.state.headsUpDays, 30);

    // All boxes but harassment and custom posted: those two go off; nothing else changes.
    const form = { 'headsup-form': '1', 'headsup:disrespect': '1', 'headsup:sexual': '1', 'headsup:language': '1', 'headsup:privacy': '1' };
    const res = await post(h, 'automod', 'rules', form);
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.calls.filter((c) => c.name === 'setHeadsUp').map((c) => c.args), [['harassment', false], ['custom', false]]);
    assert.deepEqual(h.state.automod.headsUp, { harassment: false, custom: false });
    const keys = h.auditRows.filter((r) => r.module === 'automod').map((r) => r.key);
    assert.deepEqual(keys, ['headsUp.harassment', 'headsUp.custom']);
    const again = await get(h, 'automod');
    assert.ok(again.body.includes('name="headsup:harassment" value="1">'), 'unchecked now');

    // A form without the column (older page) never touches heads-up.
    h.calls.length = 0;
    await post(h, 'automod', 'rules', { 'rule:caps': 'off' });
    assert.equal(h.calls.filter((c) => c.name === 'setHeadsUp').length, 0);

    h.state.headsUpStatsFail = true;
    assert.match((await get(h, 'automod')).body, /The private first warning counts could not be read \(database\)\./);
});

function getWithQuery(h, module, query) {
    return run(h, h.d.modulePage, { method: 'GET', params: { module }, headers: { cookie: h.cookie }, query });
}

test('Automod page: review queue links to the cards (escaped, Discord links only), probation list, stats period chips', async () => {
    const h = await setup();
    const res = await get(h, 'automod');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Review queue \(2\)/);
    assert.ok(res.body.includes(`<a href="https://discord.com/channels/${GUILD}/${TEXT}/700000000000000010" rel="noopener noreferrer" target="_blank">Excessive caps &lt;b&gt;</a>`));
    assert.ok(!res.body.includes('javascript:'), 'a non-Discord URL is never a link');
    assert.match(res.body, /Extra-watch period after a ban \(1\)/);
    assert.ok(res.body.includes('action="/dashboard/automod/probation-end"'));
    assert.ok(res.body.includes(`name="user" value="${MEMBER}"`));
    assert.ok(res.body.includes('href="/dashboard/cases/abc234x"'));
    assert.match(res.body, /No lockdown right now\./);
    assert.ok(!res.body.includes('/dashboard/automod/lockdown-end'), 'no End lockdown button without a lockdown');
    assert.equal(h.state.statsDays, 7, 'default 7 days');
    assert.match(res.body, /class="chip is-active" href="\/dashboard\/automod\?days=7" aria-current="page"/);
    for (const [days, expected] of [['1', 1], ['30', 30], ['5', 7], ['abc', 7]]) {
        const page = await getWithQuery(h, 'automod', { days });
        assert.equal(page.statusCode, 200);
        assert.equal(h.state.statsDays, expected, `?days=${days}`);
        assert.match(page.body, expected === 1 ? /automatic actions in the last day/ : new RegExp(`automatic actions in ${expected} days`));
    }
    // A failing read shows "could not be read", never "nothing".
    h.svc.collectOpenReviews = async () => { throw new Error('discord down'); };
    h.svc.listProbations = async () => { throw new Error('db down'); };
    const broken = await get(h, 'automod');
    assert.equal(broken.statusCode, 200);
    assert.match(broken.body, /review queue could not be read/);
    assert.match(broken.body, /Extra-watch periods could not be read/);
});

test('Automod lockdown: active → shown first with End lockdown; ending calls endLockdown as the admin; none → 400; owner without Administrator → 403', async () => {
    const h = await setup();
    h.state.lockdown = { active: true, startedAt: '2026-10-28T10:00:00Z', joinerIds: ['1', '2', '3'] };
    const page = await get(h, 'automod');
    assert.match(page.body, /A raid lockdown is active<\/b> since 2026-10-28 10:00 UTC, 3 raid joiners/);
    assert.ok(page.body.indexOf('/dashboard/automod/lockdown-end') < page.body.indexOf('action="/dashboard/automod/mode"'), 'before the settings while active');
    const res = await post(h, 'automod', 'lockdown-end', {});
    assert.equal(res.statusCode, 303);
    const [call] = h.calls.filter((c) => c.name === 'endLockdown');
    assert.equal(call.args[0].id, ADMIN);
    assert.equal(h.auditRows[0].key, 'lockdown');
    assert.equal(h.auditRows[0].new, null);
    assert.match((await h.sessions.get(h.session.id)).flash, /Lockdown ended/);
    // Nothing left to end: refused, endLockdown not called again.
    const again = await post(h, 'automod', 'lockdown-end', {});
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /There is no lockdown right now/);
    assert.equal(h.calls.filter((c) => c.name === 'endLockdown').length, 1);
    // From the Overview: back=overview returns there.
    h.state.lockdown = { active: true, startedAt: '2026-10-28T10:00:00Z', joinerIds: [] };
    const fromOverview = await post(h, 'automod', 'lockdown-end', { back: 'overview' });
    assert.equal(fromOverview.redirectedTo, '/dashboard/overview');
    // OWNER_IDS without Administrator: the button is disabled and the POST refused.
    const owner = await setup({ userId: OWNER });
    owner.state.lockdown = { active: true, startedAt: '2026-10-28T10:00:00Z', joinerIds: [] };
    const ownerPage = await get(owner, 'automod');
    assert.match(ownerPage.body, /To end a lockdown you need the Administrator permission/);
    assert.equal((await post(owner, 'automod', 'lockdown-end', {})).statusCode, 403);
    assert.equal(owner.calls.length, 0);
});

test('Automod probation end: ends it early (audited); a member not on probation → 400', async () => {
    const h = await setup();
    const res = await post(h, 'automod', 'probation-end', { user: MEMBER });
    assert.equal(res.statusCode, 303);
    assert.equal(h.auditRows[0].key, `probation:${MEMBER}`);
    assert.equal(h.auditRows[0].old.caseCode, 'abc234x');
    assert.match((await h.sessions.get(h.session.id)).flash, /Extra-watch period for .* ended early/);
    const again = await post(h, 'automod', 'probation-end', { user: MEMBER });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /not in an extra-watch period/);
    assert.equal(h.auditRows.length, 1);
    const owner = await setup({ userId: OWNER });
    assert.equal((await post(owner, 'automod', 'probation-end', { user: MEMBER })).statusCode, 403);
});

// ── Automod test run (backtest) ──

const testRunCard = (body) => body.slice(body.indexOf('id="s-test-run"'), body.indexOf('</section>', body.indexOf('id="s-test-run"')));

test('Automod test run: idle form; start passes channels, days, settings, running custom rules and the draft; running shows progress and no form', async () => {
    const h = await setup();
    seedCustomRules(h.state);
    const idle = testRunCard((await get(h, 'automod')).body);
    assert.ok(idle.includes('action="/dashboard/automod/test-run"'));
    assert.match(idle, /<select name="channels" multiple/);
    for (const days of ['1', '3', '7']) assert.ok(idle.includes(`<option value="${days}"`), days);
    assert.ok(idle.includes('name="draftWords"'));
    assert.ok(!/—/.test(idle), 'no em dashes');

    const res = await post(h, 'automod', 'test-run', { channels: [TEXT], days: '3', draftName: 'Promo', draftWords: 'promo code\nbuy now' });
    assert.equal(res.statusCode, 303);
    assert.equal(res.redirectedTo, '/dashboard/automod');
    const [call] = h.calls.filter((c) => c.name === 'startAutomodBacktest');
    const params = call.args[0];
    assert.deepEqual(params.channelIds, [TEXT]);
    assert.equal(params.days, 3);
    assert.equal(params.guild.id, GUILD);
    assert.equal(params.startedBy, ADMIN);
    assert.deepEqual(params.draft, { name: 'Promo', words: 'promo code\nbuy now' });
    assert.deepEqual(params.customRules.map((r) => r.id), [CUSTOM_A], 'only rules that run (B is off)');
    assert.equal(params.settings.mode, 'enforce');
    assert.equal(h.auditRows.length, 0, 'read only: no audit');
    assert.ok(!h.calls.some((c) => c.name === 'postModLog'), 'no mod log');
    assert.match((await h.sessions.get(h.session.id)).flash, /Test run started/);

    // No draft fields → draft null.
    await post(h, 'automod', 'test-run', { channels: [TEXT], days: '1' });
    assert.equal(h.calls.filter((c) => c.name === 'startAutomodBacktest')[1].args[0].draft, null);

    h.state.backtest.progress.read = 1234;
    const running = testRunCard((await get(h, 'automod')).body);
    assert.match(running, /Test run in progress\.<\/b> 1,234 of at most 2,000 messages read so far/);
    assert.ok(running.includes('href="/dashboard/automod#s-test-run"'), 'reload hint');
    assert.ok(!running.includes('action="/dashboard/automod/test-run"'), 'no form while running');
});

test('Automod test run: done shows per-rule counts, masked examples (escaped, Discord links only), cap and skipped checks; failed shows the error and the form', async () => {
    const h = await setup();
    h.state.backtest = {
        guildId: GUILD, status: 'done', startedAt: Date.now() - 60000, finishedAt: Date.now(),
        params: { channelIds: [TEXT, TEXT2], days: 7, automodEnabled: false, draft: { name: 'Promo', words: 2 } },
        progress: { read: 2000 },
        result: {
            read: 2000, checked: 1900, skippedBots: 80, skippedAdmins: 20, hitMessages: 3, capped: true, invitesUnchecked: 0,
            byRule: {
                language: { label: 'Inappropriate language', count: 2, on: 1, monitor: 1 },
                draft: { label: 'Draft: Promo', count: 1, on: 0, monitor: 0, draft: true },
            },
            examples: [
                { at: Date.now() - 1000, author: 'amy<b>', authorId: MEMBER, channelId: TEXT, channelName: 'general', url: `https://discord.com/channels/${GUILD}/${TEXT}/800000000000000001`, rules: ['Inappropriate language'], excerpt: 'you f**k <i>' },
                { at: Date.now() - 2000, author: 'bob', authorId: MEMBER, channelId: TEXT, channelName: 'general', url: 'javascript:alert(1)', rules: ['Draft: Promo'], excerpt: null },
            ],
            channels: [],
        },
        error: null,
    };
    const card = testRunCard((await get(h, 'automod')).body);
    assert.match(card, /Read 2,000 messages from 2 channels in the last 7 days: 1,900 checked, 80 from bots skipped, 20 from administrators skipped\. 3 messages broke a rule\./);
    assert.match(card, /Stopped at the limit of 2,000 messages\. Older messages in that time may not have been checked\./);
    assert.match(card, /Automod is off right now/);
    assert.match(card, /Not checked in a test run: Spam/);
    assert.match(card, /<td>Inappropriate language<\/td><td>2<\/td><td>0<\/td><td>0\.1%<\/td><td>acts, report only \(don&#39;t delete\)<\/td>/);
    assert.match(card, /<td>Draft: Promo<\/td><td>1<\/td><td>0<\/td><td>0\.1%<\/td><td>draft, not saved<\/td>/);
    assert.ok(card.includes('you f**k &lt;i&gt;'), 'excerpt escaped');
    assert.ok(card.includes('amy&lt;b&gt;'));
    assert.ok(card.includes(`href="https://discord.com/channels/${GUILD}/${TEXT}/800000000000000001"`));
    assert.ok(!card.includes('javascript:'), 'a non-Discord URL is never a link');
    assert.match(card, /hidden \(the match could not be masked safely\)/);
    assert.ok(card.includes('action="/dashboard/automod/test-run"'), 'a new run can be started');
    assert.ok(!/—/.test(card), 'no em dashes');

    h.state.backtest = { ...h.state.backtest, status: 'failed', error: 'I could not read #general: I am missing View Channel or Read Message History there.', result: { read: 120 } };
    const failed = testRunCard((await get(h, 'automod')).body);
    assert.match(failed, /class="error" role="alert">The last test run failed: I could not read #general: I am missing View Channel or Read Message History there\./);
    assert.match(failed, /120 messages were read before it stopped/);
    assert.ok(failed.includes('action="/dashboard/automod/test-run"'));

    h.state.backtestReadFails = true;
    assert.match(testRunCard((await get(h, 'automod')).body), /The test run state could not be read/);
});

/** A finished test run with noisy, quiet, custom, off and draft rules (backtest.js result shape). */
function seedFixableRun(state) {
    state.backtest = {
        guildId: GUILD, status: 'done', startedAt: Date.now() - 60000, finishedAt: Date.now(),
        params: { channelIds: [TEXT], days: 7, automodEnabled: true, draft: { name: 'Promo <b>', words: 2, list: ['promo code', 'buy now'] } },
        progress: { read: 500 },
        result: {
            read: 500, checked: 400, skippedBots: 100, skippedAdmins: 0, hitMessages: 50, capped: false, invitesUnchecked: 0,
            byRule: {
                language: { label: 'Inappropriate language', count: 40, members: 6, on: 40, monitor: 0, mayBeTooStrict: true, words: [{ word: 'n***s', count: 30 }, { word: 's<b>t', count: 10 }], moreWords: 2 },
                caps: { label: 'Excessive caps', count: 3, members: 1, on: 0, monitor: 3, mayBeTooStrict: false },
                [`custom-${CUSTOM_A}`]: { label: 'Ads <b>', count: 2, members: 2, on: 2, monitor: 0, mayBeTooStrict: false, words: [{ word: 'f*** n***o', count: 2 }], moreWords: 0 },
                draft: { label: 'Draft: Promo <b>', count: 5, members: 2, on: 0, monitor: 0, draft: true, mayBeTooStrict: false },
            },
            offRules: { english: { label: 'English only', count: 12, members: 4, mayBeTooStrict: true } },
            examples: [],
            channels: [],
        },
        error: null,
    };
}

test('Automod test run fixes: members, share and a cautious "may be too strict" note; masked word breakdown; buttons only where they change something', async () => {
    const h = await setup();
    seedCustomRules(h.state);
    h.state.automod.ruleModes = { english: 'off' };
    seedFixableRun(h.state);
    const card = testRunCard((await get(h, 'automod')).body);
    assert.match(card, /<td>Inappropriate language<\/td><td>40<\/td><td>6<\/td><td>10%<\/td><td>acts<\/td><td><span class="warn">Catches a lot, may be too strict<\/span><\/td>/);
    assert.match(card, /<td>Excessive caps<\/td><td>3<\/td><td>1<\/td><td>0\.8%<\/td><td>report only \(don&#39;t delete\)<\/td><td><\/td>/);
    assert.match(card, /at least 10 messages, from at least 3 different members, and at least 2% of the checked messages\. It is only a hint/);
    assert.ok(!/false positive/i.test(card), 'never claims certainty');
    assert.ok(!/—/.test(card), 'no em dashes');
    const button = (rule, mode) => new RegExp(`action="/dashboard/automod/test-run-rule"[^>]*>[^]*?name="rule" value="${rule}">\\s*<input type="hidden" name="mode" value="${mode}">`);
    const hasButton = (rule, mode) => card.split('</form>').some((form) => button(rule, mode).test(form));
    // Acting rule: watch only and off. Watch-only rule: off only. Off rule: Turn on (default).
    assert.ok(hasButton('language', 'monitor') && hasButton('language', 'off'));
    assert.ok(!hasButton('caps', 'monitor') && hasButton('caps', 'off'));
    assert.match(card, /<h3>Turned off, but would have caught messages<\/h3>/);
    assert.ok(hasButton('english', 'default'));
    assert.match(card, /Turn on English only for the whole server\? It follows the main setting\./);
    // Custom rule: Turn off through custom-toggle (rule name escaped in the confirm).
    assert.match(card, new RegExp(`action="/dashboard/automod/custom-toggle"[^>]*data-confirm="Turn off the custom rule &quot;Ads &lt;b&gt;&quot;\\?"[^]*?name="id" value="${CUSTOM_A}">\\s*<input type="hidden" name="enabled" value="false">`));
    // Word breakdown: the masked words only, escaped, with the rest counted.
    assert.match(card, /<h3>Matched words<\/h3>/);
    assert.ok(card.includes('<code>n***s</code> 30, <code>s&lt;b&gt;t</code> 10 <span class="muted">and 2 more</span>'));
    assert.ok(card.includes('<code>f*** n***o</code> 2'));
    // Draft: "Add this rule" posts the cleaned draft to custom-add as a delete rule.
    assert.match(card, /action="\/dashboard\/automod\/custom-add"[^>]*data-confirm="Add the custom rule &quot;Promo &lt;b&gt;&quot;\?/);
    assert.ok(card.includes('name="name" value="Promo &lt;b&gt;"'));
    assert.ok(card.includes('name="action" value="delete"'));
    assert.ok(card.includes('name="words" value="promo code\nbuy now"'));

    // Current settings decide the buttons: language already watch only → no watch-only button.
    h.state.automod.ruleModes = { language: 'monitor', caps: 'off' };
    const later = testRunCard((await get(h, 'automod')).body);
    const laterHas = (rule, mode) => later.split('</form>').some((form) => button(rule, mode).test(form));
    assert.ok(!laterHas('language', 'monitor') && laterHas('language', 'off'));
    assert.ok(!laterHas('caps', 'off'));
    assert.match(later, /<td>Excessive caps<\/td>[^]*?<span class="muted">off now<\/span>/);
    assert.match(later, /<td>English only<\/td>[^]*?<span class="muted">on now<\/span>/);
});

test('Automod test run fixes: test-run-rule re-checks the rule and mode, writes through setRuleMode and audits like the Rule modes form; the draft goes through custom-add with its plan limit', async () => {
    const h = await setup();
    seedCustomRules(h.state);
    h.state.automod.ruleModes = { english: 'off' };
    seedFixableRun(h.state);

    const watch = await post(h, 'automod', 'test-run-rule', { rule: 'language', mode: 'monitor' });
    assert.equal(watch.statusCode, 303);
    assert.equal(h.state.automod.ruleModes.language, 'monitor');
    assert.deepEqual(h.calls.filter((c) => c.name === 'setRuleMode').map((c) => c.args), [['language', 'monitor']]);
    assert.deepEqual(h.auditRows.filter((r) => r.module === 'automod').map((r) => [r.key, r.old, r.new]), [['ruleModes.language', null, 'monitor']]);
    assert.match((await h.sessions.get(h.session.id)).flash, /Inappropriate language is now report only \(don't delete\)\./);

    // Same again: nothing written, nothing audited.
    const auditCount = h.auditRows.length;
    await post(h, 'automod', 'test-run-rule', { rule: 'language', mode: 'monitor' });
    assert.equal(h.calls.filter((c) => c.name === 'setRuleMode').length, 1);
    assert.equal(h.auditRows.length, auditCount);
    assert.match((await h.sessions.get(h.session.id)).flash, /Nothing changed/);

    // Turn on = back to the main setting (the override is removed).
    await post(h, 'automod', 'test-run-rule', { rule: 'english', mode: 'default' });
    assert.equal('english' in h.state.automod.ruleModes, false);
    assert.match((await h.sessions.get(h.session.id)).flash, /English only is on\. It follows the main setting\./);
    await post(h, 'automod', 'test-run-rule', { rule: 'caps', mode: 'off' });
    assert.equal(h.state.automod.ruleModes.caps, 'off');

    // Invalid keys and modes are refused, whatever the stored result says.
    h.calls.length = 0;
    for (const form of [{ rule: `custom-${CUSTOM_A}`, mode: 'off' }, { rule: 'draft', mode: 'off' }, { rule: '__proto__', mode: 'off' }, { rule: 'caps', mode: 'on' }, { rule: 'caps' }, {}]) {
        const res = await post(h, 'automod', 'test-run-rule', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form));
        assert.match(res.body, /unknown choice/);
    }
    assert.equal(h.calls.filter((c) => c.name === 'setRuleMode').length, 0);

    // "Add this rule" posts exactly what the button carries; it lands as a cleaned delete rule.
    const added = await post(h, 'automod', 'custom-add', { name: 'Promo <b>', action: 'delete', muteDuration: '', words: 'promo code\nbuy now' });
    assert.equal(added.statusCode, 303);
    const saved = h.state.registry.automodCustomRules.at(-1);
    assert.deepEqual([saved.name, saved.words, saved.action, saved.enabled], ['Promo <b>', ['promo code', 'buy now'], 'delete', true]);
    assert.ok(h.auditRows.some((r) => r.key === 'automodCustomRules'), 'audited by the settings service');

    // At the plan limit: no Add button, a note instead, and custom-add still refuses.
    const full = await setup();
    full.state.plan = 'normal';
    full.state.registry.automodCustomRules = Array.from({ length: 5 }, (_, i) => ({ id: `full${i}aaa`, name: `Rule ${i}`, words: ['abc'], action: 'warn', muteDuration: null, enabled: true }));
    seedFixableRun(full.state);
    const fullCard = testRunCard((await get(full, 'automod')).body);
    assert.ok(!fullCard.includes('action="/dashboard/automod/custom-add"'));
    assert.match(fullCard, /This server already has 5 custom rules, the most its plan allows/);
    const refused = await post(full, 'automod', 'custom-add', { name: 'Promo', action: 'delete', muteDuration: '', words: 'promo code\nbuy now' });
    assert.equal(refused.statusCode, 400);
    assert.equal(full.state.registry.automodCustomRules.length, 5);

    const free = await setup();
    free.state.plan = 'free';
    seedFixableRun(free.state);
    const freeCard = testRunCard((await get(free, 'automod')).body);
    assert.ok(!freeCard.includes('action="/dashboard/automod/custom-add"'));
    assert.match(freeCard, /Custom rules come with the Normal, Pro and Max plans/);

    // Read-only access (editing off): the buttons are disabled.
    const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    seedFixableRun(off.state);
    const offCard = testRunCard((await get(off, 'automod')).body);
    assert.ok(offCard.includes('action="/dashboard/automod/test-run-rule"'));
    assert.ok(!/<button type="submit"[^>]*>Turn off<\/button>/.test(offCard), 'no submit buttons without edit rights');
});

test('Automod test run refusals: too many channels, an ignored channel, a refused start (already running, permissions); OWNER_IDS without Administrator', async () => {
    const h = await setup();
    const many = Array.from({ length: 21 }, (_, i) => `5000000000000001${String(i).padStart(2, '0')}`);
    const tooMany = await post(h, 'automod', 'test-run', { channels: many, days: '7' });
    assert.equal(tooMany.statusCode, 400);
    assert.match(tooMany.body, /Pick at most 20 channels \(21 picked\)/);
    const none = await post(h, 'automod', 'test-run', { days: '7' });
    assert.equal(none.statusCode, 400);
    assert.match(none.body, /Pick at least one channel/);
    const badDays = await post(h, 'automod', 'test-run', { channels: [TEXT], days: '30' });
    assert.equal(badDays.statusCode, 400);
    // TEXT2 is an ignored channel in the fake settings.
    const ignored = await post(h, 'automod', 'test-run', { channels: [TEXT, TEXT2], days: '7' });
    assert.equal(ignored.statusCode, 400);
    assert.match(ignored.body, /Automod ignores #&lt;script&gt;x&lt;\/script&gt;, so a test run there finds nothing/);
    assert.equal(h.calls.filter((c) => c.name === 'startAutomodBacktest').length, 0);

    h.state.backtestRefuse = 'A test run is already running. Wait for it to finish, then start a new one.';
    const busy = await post(h, 'automod', 'test-run', { channels: [TEXT], days: '7' });
    assert.equal(busy.statusCode, 400);
    assert.match(busy.body, /A test run is already running/);
    assert.equal(h.auditRows.length, 0);

    const owner = await setup({ userId: OWNER });
    const page = testRunCard((await get(owner, 'automod')).body);
    assert.match(page, /To start a test run you need the Administrator permission/);
    assert.match(page, /<fieldset disabled>/);
    assert.equal((await post(owner, 'automod', 'test-run', { channels: [TEXT], days: '7' })).statusCode, 403);
    assert.equal(owner.calls.length, 0);
});

test('Automod custom rules: list (escaped), add saves a cleaned rule, toggle and remove; at the limit or on Free the form is a note with /pricing', async () => {
    const h = await setup();
    seedCustomRules(h.state);
    const page = await get(h, 'automod');
    assert.match(page.body, /Custom rules/);
    assert.ok(page.body.includes('Ads &lt;b&gt;'), 'rule name escaped');
    assert.ok(!page.body.includes('Ads <b>'));
    assert.match(page.body, /1 of 25 custom rules run on the Pro plan\./);
    assert.ok(page.body.includes('action="/dashboard/automod/custom-add"'));
    assert.ok(page.body.includes('action="/dashboard/automod/custom-toggle"'));
    assert.ok(!/—/.test(page.body.slice(page.body.indexOf('Custom rules'), page.body.indexOf('Channel exceptions'))), 'no em dashes in the section');

    const added = await post(h, 'automod', 'custom-add', { name: '  Links  ', action: 'delete', muteDuration: '5h', words: 'Bit.ly\nbit.ly\n' });
    assert.equal(added.statusCode, 303);
    const saved = h.state.registry.automodCustomRules;
    assert.equal(saved.length, 3);
    assert.deepEqual({ ...saved[2], id: 'x' }, { id: 'x', name: 'Links', words: ['bit.ly'], action: 'delete', muteDuration: null, enabled: true });
    assert.match((await h.sessions.get(h.session.id)).flash, /Custom rule "Links" added/);

    assert.ok(page.body.includes('action="/dashboard/automod/custom-edit"'));
    assert.equal((await post(h, 'automod', 'custom-edit', { id: CUSTOM_B, action: 'mute', muteDuration: '2h', words: 'Promo code\npromo code\nfree gift' })).statusCode, 303);
    const edited = h.state.registry.automodCustomRules.find((r) => r.id === CUSTOM_B);
    assert.deepEqual([edited.words, edited.action, edited.muteDuration], [['promo code', 'free gift'], 'mute', '2h']);
    assert.equal((await post(h, 'automod', 'custom-toggle', { id: CUSTOM_B, enabled: 'true' })).statusCode, 303);
    assert.equal(h.state.registry.automodCustomRules.find((r) => r.id === CUSTOM_B).enabled, true);
    assert.equal((await post(h, 'automod', 'custom-remove', { id: CUSTOM_A })).statusCode, 303);
    assert.deepEqual(h.state.registry.automodCustomRules.map((r) => r.id).includes(CUSTOM_A), false);

    // Plan dropped to Normal with 7 stored rules: nothing deleted, 5 run, the rest are marked, no add form.
    const over = await setup();
    over.state.plan = 'normal';
    over.state.registry.automodCustomRules = Array.from({ length: 7 }, (_, i) => ({ id: `over${i}aaa`, name: `Rule ${i}`, words: ['abc'], action: 'warn', muteDuration: null, enabled: true }));
    const overPage = await get(over, 'automod');
    assert.match(overPage.body, /5 of 5 custom rules run on the Normal plan\. 2 turned-on rules over the limit do not run\./);
    assert.equal((overPage.body.match(/not running \(over the plan's limit\)/g) || []).length, 2);
    assert.ok(!overPage.body.includes('action="/dashboard/automod/custom-add"'));
    assert.ok(overPage.body.includes('href="/pricing"'));
    const refused = await post(over, 'automod', 'custom-add', { name: 'More', action: 'warn', words: 'abc' });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /the most the Normal plan allows/);
    assert.equal(over.state.registry.automodCustomRules.length, 7);

    const free = await setup();
    free.state.plan = 'free';
    const freePage = await get(free, 'automod');
    assert.match(freePage.body, /Custom rules come with the Normal, Pro and Max plans/);
    assert.ok(freePage.body.includes('href="/pricing"'));
    assert.ok(!freePage.body.includes('action="/dashboard/automod/custom-add"'));
    const freeAdd = await post(free, 'automod', 'custom-add', { name: 'X', action: 'warn', words: 'abc' });
    assert.equal(freeAdd.statusCode, 400);
    assert.equal(free.calls.filter((c) => c.name === 'updateSettings').length, 0);
});

test('Overview "Needs you": an active lockdown gets an End lockdown form for admins (back to the Overview), a link otherwise', async () => {
    const { overviewPage } = await import('../src/services/dashboard/overview.js');
    const o = { checklist: [], bot: { ready: true, ping: null }, database: null, guild: null, recent: [], lockdown: { active: true, since: '2026-10-28T10:00:00Z' } };
    const admin = String(overviewPage({ session: { username: 'a', csrf: 'tok' }, access: { canAct: true }, overview: o, editEnabled: true }));
    assert.match(admin, /<form method="post" action="\/dashboard\/automod\/lockdown-end" class="inline-form" data-confirm="[^"]+"><input type="hidden" name="csrf" value="tok"><input type="hidden" name="back" value="overview"><button type="submit" class="btn small danger">End lockdown<\/button><\/form>/);
    for (const page of [
        overviewPage({ session: { username: 'a', csrf: 'tok' }, access: { canAct: false }, overview: o, editEnabled: true }),
        overviewPage({ session: { username: 'a', csrf: 'tok' }, access: { canAct: true }, overview: o, editEnabled: false }),
    ]) {
        assert.ok(!String(page).includes('lockdown-end'));
        assert.match(String(page), /<a class="btn primary small" href="\/dashboard\/automod">Automod<\/a>/);
    }
});

test('transparency report switch: off by default, an administrator turns it on (saved + audited), owners without Administrator cannot', async () => {
    const admin = await setup();
    const page = await get(admin, 'enforcement');
    assert.match(page.body, /Transparency report/);
    assert.match(page.body, /action="\/dashboard\/enforcement\/transparency"/);
    assert.match(page.body, /aria-label="Publish a monthly transparency report on the website: turn on"/, 'off by default');
    const res = await post(admin, 'enforcement', 'transparency', { enabled: 'true' });
    assert.equal(res.statusCode, 303);
    assert.equal(admin.state.registry.transparencyReportEnabled, true);
    const update = admin.calls.find((c) => c.name === 'updateSettings');
    assert.deepEqual(update.args[1], { transparencyReportEnabled: true });
    assert.equal(update.args[2].userId, ADMIN);
    assert.ok(admin.auditRows.some((r) => r.key === 'transparencyReportEnabled' && r.old === false && r.new === true), 'audited old → new');
    // Again with the same value: nothing changes, nothing is audited.
    const rows = admin.auditRows.length;
    assert.equal((await post(admin, 'enforcement', 'transparency', { enabled: 'true' })).statusCode, 303);
    assert.equal(admin.auditRows.length, rows);
    const owner = await setup({ userId: OWNER });
    const refused = await post(owner, 'enforcement', 'transparency', { enabled: 'true' });
    assert.equal(refused.statusCode, 403);
    assert.equal(owner.state.registry.transparencyReportEnabled, undefined);
    assert.ok(!(await get(owner, 'enforcement')).body.includes('aria-label="Publish a monthly transparency report on the website: turn on"'), 'owners see the state only (no switch button)');
});

test('trust card switch: off by default, an administrator turns it on (saved + audited, link shown), owners without Administrator cannot', async () => {
    const admin = await setup();
    const page = await get(admin, 'enforcement');
    assert.match(page.body, /Trust card/);
    assert.match(page.body, /action="\/dashboard\/enforcement\/trust-card"/);
    assert.match(page.body, /aria-label="Publish trust card: turn on"/, 'off by default');
    assert.ok(!page.body.includes('href="/trust"'), 'no link while off');
    const res = await post(admin, 'enforcement', 'trust-card', { enabled: 'true' });
    assert.equal(res.statusCode, 303);
    assert.equal(admin.state.registry.trustCardEnabled, true);
    const update = admin.calls.find((c) => c.name === 'updateSettings');
    assert.deepEqual(update.args[1], { trustCardEnabled: true });
    assert.equal(update.args[2].userId, ADMIN);
    assert.ok(admin.auditRows.some((r) => r.key === 'trustCardEnabled' && r.old === false && r.new === true), 'audited old → new');
    const on = await get(admin, 'enforcement');
    assert.match(on.body, /aria-label="Publish trust card: turn off"/);
    assert.match(on.body, /<a href="\/trust">\/trust<\/a>/, 'link to the page while on');
    const rows = admin.auditRows.length;
    assert.equal((await post(admin, 'enforcement', 'trust-card', { enabled: 'true' })).statusCode, 303);
    assert.equal(admin.auditRows.length, rows, 'same value: nothing audited');
    const owner = await setup({ userId: OWNER });
    const refused = await post(owner, 'enforcement', 'trust-card', { enabled: 'true' });
    assert.equal(refused.statusCode, 403);
    assert.equal(owner.state.registry.trustCardEnabled, undefined);
    assert.ok(!(await get(owner, 'enforcement')).body.includes('aria-label="Publish trust card: turn on"'), 'owners see the state only');
});

// ── Rules page ────────────────────────────────────────────────────────────

test('rules: add, edit, move, delete — stored as the serverRules setting with a fresh date; audit rows and a mod-log line naming the rule', async () => {
    const h = await setup();
    assert.equal((await post(h, 'rules', 'rule-add', { title: 'No spam', text: 'Line one\r\nLine two' })).statusCode, 303);
    assert.equal((await post(h, 'rules', 'rule-add', { title: 'Be kind', text: '' })).statusCode, 303);
    let stored = h.state.registry.serverRules;
    assert.deepEqual(stored.rules.map((r) => [r.title, r.text]), [['No spam', 'Line one\nLine two'], ['Be kind', '']]);
    assert.match(stored.rules[0].id, /^[a-z0-9]{8}$/);
    assert.ok(Date.parse(stored.updatedAt) > Date.now() - 60000, 'updatedAt set');
    const [first, second] = stored.rules.map((r) => r.id);
    assert.equal(h.auditRows.filter((r) => r.key === 'serverRules').length, 2, 'one audit row per save (settings service)');
    const modLog = h.calls.filter((c) => c.name === 'postModLog').map((c) => c.args[1].description);
    assert.match(modLog[0], /changed Rules: rule 1: \(none\) → No spam: Line one Line two/);

    assert.equal((await post(h, 'rules', 'rule-edit', { id: second, title: 'Be very kind', text: 'Always.' })).statusCode, 303);
    assert.deepEqual(h.state.registry.serverRules.rules[1], { id: second, title: 'Be very kind', text: 'Always.' });
    assert.equal((await post(h, 'rules', 'rule-move', { id: second, direction: 'up' })).statusCode, 303);
    assert.deepEqual(h.state.registry.serverRules.rules.map((r) => r.id), [second, first], 'ids keep their rule when moved');
    assert.match((await h.sessions.get(h.session.id)).flash, /is now rule 1/);

    assert.equal((await post(h, 'rules', 'links', { link_spam: first, link_harassment: second })).statusCode, 303);
    assert.deepEqual(h.state.registry.reasonRuleLinks, { spam: first, harassment: second });
    const before = h.auditRows.length;
    assert.equal((await post(h, 'rules', 'rule-delete', { id: first })).statusCode, 303);
    stored = h.state.registry.serverRules;
    assert.deepEqual(stored.rules.map((r) => r.id), [second]);
    assert.deepEqual(h.state.registry.reasonRuleLinks, { harassment: second }, 'the link to the deleted rule is removed with it');
    assert.deepEqual(h.auditRows.slice(before).map((r) => r.key).sort(), ['reasonRuleLinks', 'serverRules']);
    assert.equal(h.calls.filter((c) => c.name === 'updateSettings').at(-1).args[2].module, 'rules');
});

test('rules: limits and validation — 30 rules at most, title ≤ 80 and one line, text ≤ 1000; nothing saved when refused', async () => {
    const h = await setup();
    h.state.registry.serverRules = { rules: Array.from({ length: 30 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, title: `Rule ${i}`, text: '' })), updatedAt: null };
    const full = await post(h, 'rules', 'rule-add', { title: 'One more' });
    assert.equal(full.statusCode, 400);
    assert.match(full.body, /already has 30 rules/);
    assert.equal(h.state.registry.serverRules.rules.length, 30);
    assert.match((await get(h, 'rules')).body, /the most there can be/, 'no add form at the limit');

    const e = await setup();
    const longTitle = await post(e, 'rules', 'rule-add', { title: 'x'.repeat(81) });
    assert.equal(longTitle.statusCode, 400);
    assert.match(longTitle.body, /at most 80 characters/);
    const longText = await post(e, 'rules', 'rule-add', { title: 'Ok', text: 'y'.repeat(1001) });
    assert.equal(longText.statusCode, 400);
    assert.match(longText.body, /at most 1000 characters/);
    assert.equal((await post(e, 'rules', 'rule-add', { title: 'Ok', text: 'y'.repeat(1000) })).statusCode, 303, '1000 is allowed');
    const twoLines = await post(e, 'rules', 'rule-add', { title: 'Two\nlines' });
    assert.equal(twoLines.statusCode, 400);
    assert.match(twoLines.body, /one line/);
    const badMove = await post(e, 'rules', 'rule-move', { id: e.state.registry.serverRules.rules[0].id, direction: 'sideways' });
    assert.equal(badMove.statusCode, 400);
    assert.equal(e.state.registry.serverRules.rules.length, 1);
});

test('rules: links — one select per prebuilt reason; unchanged → "Nothing changed", no audit; unknown fields ignored', async () => {
    const h = await setup();
    seedRules(h.state);
    const page = (await get(h, 'rules')).body;
    for (const key of ['slurs', 'spam', 'harassment', 'staff_disrespect']) assert.ok(page.includes(`name="link_${key}"`), key);
    assert.ok(page.includes(`<option value="${RULE_A}">Rule 1: No spam</option>`));
    assert.ok(page.includes('Do not &lt;b&gt;spam&lt;/b&gt;.'), 'rule text escaped');
    assert.ok(page.includes('data-confirm="Delete rule 1'), 'delete asks first');
    const res = await post(h, 'rules', 'links', { link_spam: '', link_nope: RULE_A });
    assert.equal(res.statusCode, 303);
    assert.equal(h.auditRows.length, 0);
    assert.match((await h.sessions.get(h.session.id)).flash, /Nothing changed/);
    await post(h, 'rules', 'links', { link_spam: RULE_B, link_nope: RULE_A });
    assert.deepEqual(h.state.registry.reasonRuleLinks, { spam: RULE_B });
    const line = h.calls.filter((c) => c.name === 'postModLog').at(-1).args[1].description;
    assert.match(line, /reason spam: \(none\) → rule 2: Be kind/);
});

const sectionOf = (body, title, nextTitle) => body.slice(body.indexOf(`>${title}</h2>`), nextTitle ? body.indexOf(`>${nextTitle}</h2>`) : undefined);

test('rules v2: consequence in the add and edit forms and in the table; too long or two lines refused; edit keeps the library key', async () => {
    const h = await setup();
    assert.equal((await post(h, 'rules', 'rule-add', { title: 'No spam', text: 'x', consequence: ' 1-hour <b>mute</b> ' })).statusCode, 303);
    const stored = h.state.registry.serverRules.rules[0];
    assert.equal(stored.consequence, '1-hour <b>mute</b>');
    const page = (await get(h, 'rules')).body;
    assert.ok(page.includes('<td>1-hour &lt;b&gt;mute&lt;/b&gt;</td>'), 'shown escaped in the table');
    assert.ok(page.includes('name="consequence" value="1-hour &lt;b&gt;mute&lt;/b&gt;"'), 'edit form prefilled');
    const long = await post(h, 'rules', 'rule-add', { title: 'X', consequence: 'c'.repeat(101) });
    assert.equal(long.statusCode, 400);
    assert.match(long.body, /Consequence is too long: at most 100 characters \(you wrote 101\)/);
    const twoLines = await post(h, 'rules', 'rule-add', { title: 'X', consequence: 'a\nb' });
    assert.equal(twoLines.statusCode, 400);
    assert.match(twoLines.body, /Consequence must be one line/);
    assert.equal(h.state.registry.serverRules.rules.length, 1, 'nothing saved when refused');

    h.state.registry.serverRules.rules[0].preset = 'spam';
    assert.equal((await post(h, 'rules', 'rule-edit', { id: stored.id, title: 'No spam', text: 'x', consequence: '' })).statusCode, 303);
    assert.deepEqual(h.state.registry.serverRules.rules[0], { id: stored.id, title: 'No spam', text: 'x', preset: 'spam' });
    const modLog = h.calls.filter((c) => c.name === 'postModLog').at(-1).args[1].description;
    assert.match(modLog, /No spam: x \(consequence: 1-hour <b>mute<\/b>\) → No spam: x/);
    const same = await post(h, 'rules', 'rule-edit', { id: stored.id, title: 'No spam', text: 'x', consequence: '' });
    assert.equal(same.statusCode, 303);
    assert.match((await h.sessions.get(h.session.id)).flash, /Nothing changed/);
});

test('rules library: Add sets the library key and links its reason only when that reason is free; added ones show as Added; plain English, no em dashes', async () => {
    const h = await setup();
    let page = (await get(h, 'rules')).body;
    const library = sectionOf(page, 'Add from the library', 'Reasons linked to rules');
    assert.ok(library.includes('Be respectful') && library.includes('Listen to staff'), 'every library rule listed');
    assert.equal((library.match(/>Add<\/button>/g) || []).length, 22);
    assert.ok(!/—/.test(library), 'no em dashes');

    assert.equal((await post(h, 'rules', 'library-add', { key: 'spam' })).statusCode, 303);
    let { rules } = h.state.registry.serverRules;
    assert.deepEqual(rules[0], { id: rules[0].id, title: 'No spam', text: 'No message floods, walls of emoji, copy-paste chains or mass mentions.', consequence: 'Message removed and a warning, then a 1-hour mute. Spam bots are banned', preset: 'spam' });
    assert.deepEqual(h.state.registry.reasonRuleLinks, { spam: rules[0].id });
    assert.match((await h.sessions.get(h.session.id)).flash, /Rule 1 "No spam" added\. The reason "Spam" now points to it\./);

    // "No swearing" and "No hate speech" share the slurs reason: only the first one links it.
    await post(h, 'rules', 'library-add', { key: 'swearing' });
    await post(h, 'rules', 'library-add', { key: 'hate' });
    rules = h.state.registry.serverRules.rules;
    assert.equal(h.state.registry.reasonRuleLinks.slurs, rules[1].id, 'a reason already linked is never re-pointed');
    assert.ok(!/now points/.test((await h.sessions.get(h.session.id)).flash));
    // A library rule without a reason links nothing.
    await post(h, 'rules', 'library-add', { key: 'tos' });
    assert.deepEqual(Object.keys(h.state.registry.reasonRuleLinks).sort(), ['slurs', 'spam']);

    const again = await post(h, 'rules', 'library-add', { key: 'spam' });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /already in your rules/);
    assert.equal(h.state.registry.serverRules.rules.length, 4);

    page = (await get(h, 'rules')).body;
    const after = sectionOf(page, 'Add from the library', 'Reasons linked to rules');
    assert.equal((after.match(/>Added<\/span>/g) || []).length, 4);
    assert.equal((after.match(/>Add<\/button>/g) || []).length, 18);
    // A custom rule still works next to library ones.
    assert.equal((await post(h, 'rules', 'rule-add', { title: 'Custom', text: '' })).statusCode, 303);
    assert.equal(h.state.registry.serverRules.rules.at(-1).preset, undefined);

    const full = await setup();
    full.state.registry.serverRules = { rules: Array.from({ length: 30 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, title: `Rule ${i}`, text: '' })), updatedAt: null };
    const refused = await post(full, 'rules', 'library-add', { key: 'spam' });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /already has 30 rules/);
    assert.ok(!sectionOf((await get(full, 'rules')).body, 'Add from the library', 'Reasons linked to rules').includes('>Add</button>'), 'no Add buttons when full');
});

test('rules post design: saved as rulesPost; hex colour wins; link checks; preview escaped with the colour edge and the message count', async () => {
    const h = await setup();
    seedRules(h.state);
    let page = (await get(h, 'rules')).body;
    assert.match(page, /Pick a channel in the design above and save it/);
    assert.ok(!page.includes('Update posted message'), 'no Update button before a post');
    const form = { channelId: TEXT, title: 'Our <b>rules</b>', colour: 'green', hex: '#123abc', intro: 'Hello\r\nall', footer: 'Be nice', layout: 'fields', bannerUrl: 'https://example.com/b.png', thumbnailUrl: '' };
    assert.equal((await post(h, 'rules', 'post-design', form)).statusCode, 303);
    const saved = h.state.registry.rulesPost;
    assert.deepEqual(saved, {
        channelId: TEXT, title: 'Our <b>rules</b>', colour: 0x123abc, intro: 'Hello\nall', footer: 'Be nice', layout: 'fields',
        banner: { url: 'https://example.com/b.png', ref: null }, thumbnail: null, posted: null,
    });
    const modLog = h.calls.filter((c) => c.name === 'postModLog').at(-1).args[1].description;
    assert.match(modLog, /rules post colour/);

    page = (await get(h, 'rules')).body;
    const postPart = sectionOf(page, 'Post to Discord');
    assert.ok(postPart.includes('fill="#123ABC"'), 'colour edge');
    assert.ok(postPart.includes('<p class="rules-embed-title">Our &lt;b&gt;rules&lt;/b&gt;</p>'), 'title escaped');
    assert.ok(postPart.includes('Do not &lt;b&gt;spam&lt;/b&gt;.'), 'rule text escaped');
    assert.ok(postPart.includes('<p class="rules-embed-field-name">1. No spam</p>'), 'one box per rule');
    assert.ok(postPart.includes('<p class="rules-embed-footer">Be nice</p>'));
    assert.ok(postPart.includes('Posting needs <strong>1 message</strong>'));
    assert.ok(postPart.includes('>Post to #general</button>'));
    assert.ok(postPart.includes('Banner: https://example.com/b.png'), 'a non-Discord picture is named, not loaded (CSP)');
    assert.ok(!/—/.test(postPart), 'no em dashes');
    assert.ok(!/\sstyle=/.test(postPart), 'no inline styles');

    // List layout: bold rule titles in one description.
    await post(h, 'rules', 'post-design', { ...form, layout: 'list' });
    assert.ok(sectionOf((await get(h, 'rules')).body, 'Post to Discord').includes('<strong>1. No spam</strong>'));

    const bad = await setup();
    for (const [patch, message] of [
        [{ bannerUrl: 'http://example.com/b.png' }, /must start with https/],
        [{ hex: 'blue' }, /colour code like #9B59B6/],
        [{ layout: 'grid' }, /unknown choice/],
        [{ title: 'a'.repeat(257) }, /Title is too long: at most 256/],
        [{ intro: 'i'.repeat(1001) }, /Intro is too long: at most 1000/],
        [{ channelId: VOICE }, /must be a text channel/],
    ]) {
        const res = await post(bad, 'rules', 'post-design', { ...form, ...patch });
        assert.equal(res.statusCode, 400, JSON.stringify(patch));
        assert.match(res.body, message);
    }
    assert.equal(bad.state.registry.rulesPost, undefined, 'nothing saved');
});

test('rules post: Post sends the built messages through the service and stores the ids; Discord errors refuse readably; Update edits in place', async () => {
    const h = await setup();
    seedRulesPost(h.state);
    h.state.registry.serverRules.rules[0].consequence = 'Warning';
    assert.equal((await post(h, 'rules', 'post', {})).statusCode, 303);
    const [channelId, messages] = h.calls.find((c) => c.name === 'postRulesMessages').args;
    assert.equal(channelId, TEXT);
    assert.equal(messages.length, 1);
    const embed = messages[0].embeds[0].data;
    assert.equal(embed.title, 'Our <b>rules</b>');
    assert.equal(embed.color, 0x9b59b6);
    assert.match(embed.description, /\*\*1\. No spam\*\*\nDo not <b>spam<\/b>\.\n\*Consequence: Warning\*/);
    assert.deepEqual(h.state.registry.rulesPost.posted.messageIds, ['710000000000000100']);
    assert.equal(h.state.registry.rulesPost.posted.channelId, TEXT);
    assert.match((await h.sessions.get(h.session.id)).flash, /The rules were posted in #general/);

    const page = (await get(h, 'rules')).body;
    assert.ok(page.includes('>Update posted message</button>'));
    assert.ok(page.includes('data-confirm="Post the rules in #general as a new copy?'), 'posting again warns it makes a new copy');

    assert.equal((await post(h, 'rules', 'post-update', {})).statusCode, 303);
    const [posted] = h.calls.find((c) => c.name === 'updateRulesMessages').args;
    assert.deepEqual(posted.messageIds, ['710000000000000100']);
    assert.deepEqual(h.state.registry.rulesPost.posted.messageIds, ['710000000000000200']);
    assert.match((await h.sessions.get(h.session.id)).flash, /posted rules in #general were updated/);

    // Left-over old messages are deleted only after the new ids are saved.
    const shorter = await setup();
    seedRulesPost(shorter.state, { posted: true });
    shorter.state.rulesLeftovers = ['710000000000000091'];
    assert.equal((await post(shorter, 'rules', 'post-update', {})).statusCode, 303);
    assert.deepEqual(shorter.state.rulesDeleted, ['710000000000000091']);
    // The save fails: the new messages are removed again, the old ones kept, the stored ids untouched.
    const saveFails = await setup();
    seedRulesPost(saveFails.state, { posted: true });
    saveFails.state.rulesLeftovers = ['710000000000000091'];
    const realUpdate = saveFails.svc.updateSettings;
    saveFails.svc.updateSettings = async (...args) => (args[1].rulesPost?.posted ? Promise.reject(new Error('database not responding')) : realUpdate(...args));
    await assert.rejects(post(saveFails, 'rules', 'post-update', {}), /database not responding/);
    assert.deepEqual(saveFails.state.rulesDeleted, ['710000000000000200'], 'only the new message deleted');
    assert.deepEqual(saveFails.state.registry.rulesPost.posted.messageIds, ['710000000000000090']);

    const gone = await setup();
    seedRulesPost(gone.state, { posted: true });
    gone.state.rulesPostGone = true;
    const refused = await post(gone, 'rules', 'post-update', {});
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /was deleted in #general\. Use Post to send a new copy/);
    assert.deepEqual(gone.state.registry.rulesPost.posted.messageIds, ['710000000000000090'], 'stored post unchanged');

    const failing = await setup();
    seedRulesPost(failing.state);
    failing.state.rulesPostFails = true;
    const res = await post(failing, 'rules', 'post', {});
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Discord refused the post\. Nothing was posted\. Discord said: Missing Access/);
    assert.equal(failing.state.registry.rulesPost.posted, null);
    assert.equal(failing.auditRows.length, 0);

    const empty = await setup();
    seedRulesPost(empty.state);
    empty.state.registry.serverRules = { rules: [], updatedAt: null };
    const none = await post(empty, 'rules', 'post', {});
    assert.equal(none.statusCode, 400);
    assert.match(none.body, /no rules to post yet/);
    assert.ok(!empty.calls.some((c) => c.name === 'postRulesMessages'));

    const missing = await setup();
    seedRulesPost(missing.state);
    missing.state.registry.rulesPost.channelId = MISSING;
    assert.match((await get(missing, 'rules')).body, /The saved channel no longer exists/);
    assert.match((await post(missing, 'rules', 'post', {})).body, /The saved channel no longer exists/);
});

test('rules post images: an upload is stored in the log channel with a rules text, saved with its ref, attached at post time; Remove clears it', async () => {
    const h = await setup();
    seedRulesPost(h.state);
    const channel = withImageStore(h.state, h.guild);
    const res = await post(h, 'rules', 'banner-upload', {}, { upload: { file: { field: 'image', filename: 'cat.png', data: PNG } } });
    assert.equal(res.statusCode, 303);
    assert.match(channel.sent[0].content, /^Stored banner for the server rules post \(dashboard Rules page\)/);
    assert.ok(!/welcome/i.test(channel.sent[0].content), 'not the welcome text');
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    const banner = h.state.registry.rulesPost.banner;
    assert.equal(banner.ref.messageId, '800000000000000099');
    assert.equal(banner.url, banner.ref.url);
    assert.match((await h.sessions.get(h.session.id)).flash, /Banner uploaded\. A copy is kept in #general/);

    // Saving the design with the same link keeps the stored copy; the preview names the upload.
    await post(h, 'rules', 'post-design', { channelId: TEXT, title: 'Rules', colour: 'primary', layout: 'list', bannerUrl: banner.url, thumbnailUrl: '' });
    assert.deepEqual(h.state.registry.rulesPost.banner, banner);
    assert.ok((await get(h, 'rules')).body.includes('Do not delete that message, because Mewvo loads the picture from it'));

    await post(h, 'rules', 'post', {});
    const [, messages] = h.calls.find((c) => c.name === 'postRulesMessages').args;
    assert.deepEqual(messages[0].files, [{ attachment: `${banner.url}&fresh=1`, name: 'rules-banner.png' }]);
    assert.equal(messages[0].embeds[0].data.image.url, 'attachment://rules-banner.png');

    // A day later the upload's Discord link has expired: saving the design still works (the post loads a fresh link).
    const expiredUrl = 'https://cdn.discordapp.com/attachments/500000000000000001/800000000000000099/rules-banner-image.png?ex=1&is=1&hm=1';
    h.state.registry.rulesPost.banner = { url: expiredUrl, ref: { ...banner.ref, url: expiredUrl } };
    const later = await post(h, 'rules', 'post-design', { channelId: TEXT, title: 'Rules', colour: 'primary', layout: 'list', footer: 'New footer', bannerUrl: expiredUrl, thumbnailUrl: '' });
    assert.equal(later.statusCode, 303, String(later.body).match(/role="alert">([^<]*)/)?.[1]);
    assert.equal(h.state.registry.rulesPost.banner.url, expiredUrl);
    assert.ok(!/attachment links stop working/.test((await h.sessions.get(h.session.id)).flash), 'no link warning for an upload');
    // A pasted expired Discord link that is not the saved upload is still refused.
    const pasted = await post(h, 'rules', 'post-design', { channelId: TEXT, title: 'Rules', colour: 'primary', layout: 'list', bannerUrl: expiredUrl.replace('ex=1', 'ex=2'), thumbnailUrl: '' });
    assert.equal(pasted.statusCode, 400);
    assert.match(pasted.body, /has expired/);

    assert.equal((await post(h, 'rules', 'banner-remove', {})).statusCode, 303);
    assert.equal(h.state.registry.rulesPost.banner, null);

    // The welcome store itself still writes its own text.
    const w = await setup();
    const wChannel = withImageStore(w.state, w.guild);
    await post(w, 'welcome', 'welcome-image-upload', {}, { upload: { file: { field: 'image', filename: 'cat.png', data: PNG } } });
    assert.match(wChannel.sent[0].content, /for the welcome & goodbye settings/);
});

test('rules: refused without CSRF, with editing off, and for users without access; nothing saved', async () => {
    const h = await setup();
    assert.equal((await post(h, 'rules', 'rule-add', { title: 'X' }, { csrf: null })).statusCode, 403);
    const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
    assert.equal((await post(off, 'rules', 'rule-add', { title: 'X' })).statusCode, 403);
    assert.ok(!(await get(off, 'rules')).body.includes('>Add rule</button>'), 'read-only page has no submit');
    const stranger = await setup({ userId: STRANGER });
    assert.equal((await post(stranger, 'rules', 'rule-add', { title: 'X' })).statusCode, 404);
    for (const x of [h, off, stranger]) assert.equal(x.state.registry.serverRules, undefined);
});

// ── Settings backup (Bot → Settings backup) ───────────────────────────────

test('settings backup: download, check a file (no write), CSRF/Origin/Administrator, one-time token', async () => {
    const { exportSettings } = await import('../src/services/settings/settingsBackup.js');
    const h = await setup();
    const get = (handler) => run(h, handler, { method: 'GET', params: {}, query: {}, headers: { cookie: h.cookie } });
    const page = await get(h.d.backup);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Download settings/);
    assert.match(page.body, /enctype="multipart\/form-data"/);
    const download = await get(h.d.backupDownload);
    assert.equal(download.statusCode, 200);
    assert.match(download.headers['Content-Disposition'], /^attachment; filename="mewvo-settings-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.equal(JSON.parse(download.body).format, 'mewvo-settings-v1');

    const file = exportSettings({ env: ENV });
    file.guilds.main.settings.openChannelCap = (file.guilds.main.settings.openChannelCap || 20) === 33 ? 34 : 33;
    const upload = { file: { data: Buffer.from(JSON.stringify(file)) } };
    const preview = (opts = {}, hh = h) => run(hh, hh.d.backupPreview, {
        method: 'POST', params: {}, query: {}, upload: opts.upload ?? upload,
        headers: { cookie: hh.cookie, ...(opts.origin === null ? {} : { origin: opts.origin || ORIGIN }) },
        body: opts.csrf === null ? {} : { csrf: opts.csrf || hh.session.csrf },
    });
    assert.equal((await preview({ csrf: null })).statusCode, 403, 'no CSRF');
    assert.equal((await preview({ origin: 'https://evil.example' })).statusCode, 403, 'bad Origin');
    const owner = await setup({ userId: OWNER });
    assert.equal((await preview({}, owner)).statusCode, 403, 'not an Administrator');
    const bad = await preview({ upload: { file: { data: Buffer.from('{"format":"x"}') } } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /not a Mewvo settings backup/);

    const ok = await preview();
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /1 setting would change/);
    const token = ok.body.match(/name="token" value="([^"]+)"/)[1];
    assert.equal(h.calls.filter((c) => c.name === 'updateSettings').length, 0, 'checking writes nothing');

    const apply = (tok, hh = h) => run(hh, hh.d.backupApply, { method: 'POST', params: {}, query: {}, headers: { cookie: hh.cookie, origin: ORIGIN }, body: { csrf: hh.session.csrf, token: tok } });
    const other = await setup();
    const stolen = await apply(token, other);
    assert.equal(stolen.statusCode, 400, 'a token works only for the admin who checked the file');
    const unknown = await apply('nope');
    assert.equal(unknown.statusCode, 400);
    assert.match(unknown.body, /expired or was already used/);

    // D9: the token is spent only after a successful apply (one transaction in applyBackup).
    let fail = true;
    const applied = [];
    h.svc.applySettingsBackup = async (plan) => { if (fail) throw new Error('db down'); applied.push(plan); return plan.changes.length; };
    const failed = await apply(token);
    assert.equal(failed.statusCode, 503);
    assert.match(failed.body, /not applied/);
    assert.match(failed.body, new RegExp(`name="token" value="${token}"`), 'the same check can be applied again');
    fail = false;
    const done = await apply(token);
    assert.equal(done.statusCode, 303, 'the other admin\'s attempt and the failure did not spend the token');
    assert.equal(applied.length, 1);
    assert.equal((await apply(token)).statusCode, 400, 'spent after the success');
});

test('bot in this server: not an image refused; below Pro the page says so and every action refuses', async () => {
    const h = await setup();
    const notImage = await post(h, 'appearance', 'avatar', {}, { upload: { file: { field: 'image', filename: 'x.txt', data: Buffer.from('hello') } } });
    assert.equal(notImage.statusCode, 400);
    assert.match(notImage.body, /not a PNG, JPEG, GIF or WebP/);
    const free = await setup();
    free.state.plan = 'normal';
    const page = await run(free, free.d.modulePage, { method: 'GET', params: { module: 'appearance' }, headers: { cookie: free.cookie }, query: {} });
    assert.match(page.body, /come with Mewvo Pro and Max/);
    assert.ok(!page.body.includes('action="/dashboard/appearance/nickname"'));
    const refused = await post(free, 'appearance', 'nickname', { nickname: 'x' });
    assert.equal(refused.statusCode, 403);
    assert.equal(free.calls.filter((c) => c.name === 'setBotNickname').length, 0);
});

test('handover note: on the Overview for moderators and admins; save (audited through updateSettings), clear, CSRF, Origin', async () => {
    const h = await setup();
    const page = await run(h, h.d.overview, { method: 'GET', params: {}, headers: { cookie: h.cookie }, query: {} });
    assert.match(page.body, /<h2>Note for the next shift<\/h2>/);
    assert.match(page.body, /action="\/dashboard\/handover"/);
    const post = (body, origin = ORIGIN) => run(h, h.d.handover, { method: 'POST', params: {}, headers: { cookie: h.cookie, origin }, body, query: {} });
    const saves = () => h.calls.filter((c) => c.name === 'updateSettings');
    assert.equal((await post({ csrf: 'wrong', text: 'x' })).statusCode, 403);
    assert.equal((await post({ csrf: h.session.csrf, text: 'x' }, 'https://evil.example')).statusCode, 403);
    assert.equal(saves().length, 0);
    const ok = await post({ csrf: h.session.csrf, text: '  watch #general  ' });
    assert.equal(ok.statusCode, 303);
    const note = saves()[0].args[1].staffHandoverNote;
    assert.equal(note.text, 'watch #general');
    assert.equal(note.by, h.session.userId ?? note.by);
    await post({ csrf: h.session.csrf, text: '' });
    assert.equal(saves()[1].args[1].staffHandoverNote, null, 'empty clears it');
    assert.equal((await post({ csrf: h.session.csrf, text: 'x'.repeat(1001) })).statusCode, 400);
});

test('saved case searches: save the current filters, list them as links, delete; checks and limits', async () => {
    const h = await setup();
    const post = (action, body, origin = ORIGIN) => run(h, h.d[action], { method: 'POST', params: {}, headers: { cookie: h.cookie, origin }, body, query: {} });
    const saves = () => h.calls.filter((c) => c.name === 'updateSettings' && c.args[1].savedCaseSearches);
    assert.equal((await post('searchSave', { csrf: 'x', name: 'Scam', tag: 'scam' })).statusCode, 403);
    assert.equal((await post('searchSave', { csrf: h.session.csrf, name: 'Nothing' })).statusCode, 400, 'no filters');
    assert.equal((await post('searchSave', { csrf: h.session.csrf, name: 'Bad', type: 'nuke' })).statusCode, 400, 'invalid filter');
    const ok = await post('searchSave', { csrf: h.session.csrf, name: 'Scam cases', tag: 'scam', type: 'ban' });
    assert.equal(ok.statusCode, 303);
    assert.equal(ok.redirectedTo, '/dashboard/cases?type=ban&tag=scam');
    assert.deepEqual(saves()[0].args[1].savedCaseSearches, [{ name: 'Scam cases', query: { type: 'ban', tag: 'scam' } }]);
    assert.equal((await post('searchDelete', { csrf: h.session.csrf, name: 'Nope' })).statusCode, 400);
});

test('scheduled messages: preview of the message and the next posting times', async () => {
    const { messagePreview, upcomingRuns } = await import('../src/services/dashboard/modules/messages.js');
    const view = String(messagePreview({ content: 'Hi <b>all</b>', embed: { title: 'News', description: 'Line', imageUrl: '', footer: 'Staff' } }));
    assert.ok(view.includes('Hi &lt;b&gt;all&lt;/b&gt;'), 'escaped');
    assert.ok(view.includes('<b>News</b>') && view.includes('Staff'));
    const daily = { paused: false, nextRunAt: Date.parse('2026-11-02T09:00:00Z'), timezone: 'UTC', schedule: { kind: 'interval', hours: 24, date: '2026-11-02', time: '09:00' } };
    const runs = upcomingRuns(daily);
    assert.ok(runs.length >= 1 && runs[0] === daily.nextRunAt);
    for (let i = 1; i < runs.length; i += 1) assert.ok(runs[i] > runs[i - 1], 'increasing');
    assert.deepEqual(upcomingRuns({ ...daily, paused: true }), []);
    assert.deepEqual(upcomingRuns({ ...daily, nextRunAt: null }), []);
});

test('leveling: the Server cat section shows the picture and name; the name is saved cleaned, the switch audited; a failed cat read only shows a note', async () => {
    const h = await setup();
    const page = await get(h, 'leveling');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('src="/img/cat/young-happy.png"'), 'cat picture');
    assert.ok(page.body.includes('name="catName" value="Mewvo"'), 'default name');
    assert.ok(page.body.includes('action="/dashboard/leveling/cat-announce"'));

    const saved = await post(h, 'leveling', 'cat-name', { catName: '  Mochi @everyone <b> ' });
    assert.equal(saved.statusCode, 303);
    assert.equal(h.state.registry.catName, 'Mochi everyone b');
    assert.equal(h.auditRows.find((r) => r.key === 'catName').new, 'Mochi everyone b');
    const same = await post(h, 'leveling', 'cat-name', { catName: 'Mochi everyone b' });
    assert.equal(same.statusCode, 303);
    assert.equal(h.calls.filter((c) => c.name === 'updateSettings').length, 1, 'unchanged name: nothing saved');
    const tooLong = await post(h, 'leveling', 'cat-name', { catName: 'x'.repeat(33) });
    assert.equal(tooLong.statusCode, 400, 'never cut silently');

    await post(h, 'leveling', 'cat-announce', { enabled: 'false' });
    assert.equal(h.state.registry.catAnnounce, false);
    assert.ok(h.auditRows.some((r) => r.key === 'catAnnounce' && r.new === false));

    const broken = await setup();
    broken.state.catFails = true;
    const fallback = await get(broken, 'leveling');
    assert.equal(fallback.statusCode, 200, 'the page still renders');
    assert.match(fallback.body, /The cat could not be loaded right now/);
    assert.ok(fallback.body.includes('Least XP per message'), 'the rest of the page is there');
});

test('leveling: the level-up card is off by default; turning it on and picking a colour is saved and audited; a bad colour code is refused', async () => {
    const h = await setup();
    const page = await get(h, 'leveling');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('action="/dashboard/leveling/card"'), 'card form');
    assert.match(page.body, /name="levelUpCard" value="1">/, 'switch is off when nothing is saved');
    assert.ok(page.body.includes('<option value="primary" selected>'), 'Mewvo blue is the default colour');
    const cardSection = page.body.match(/id="s-level-up-card"[\s\S]*?<\/section>/)?.[0] || '';
    assert.ok(cardSection, 'card section is on the page');
    assert.ok(!/\u2014/.test(cardSection), 'no em dash in the card section');

    // Saving the defaults writes nothing.
    const same = await post(h, 'leveling', 'card', { colour: 'primary', hex: '' });
    assert.equal(same.statusCode, 303);
    assert.equal(h.calls.filter((c) => c.name === 'updateLevelingConfig').length, 0, 'defaults: nothing saved');

    const on = await post(h, 'leveling', 'card', { levelUpCard: '1', colour: 'purple', hex: '' });
    assert.equal(on.statusCode, 303);
    assert.equal(h.state.leveling.levelUpCard, true);
    assert.equal(h.state.leveling.cardAccent, '#9B59B6');
    assert.ok(h.auditRows.some((r) => r.key === 'leveling.levelUpCard' && r.new === true));
    assert.ok(h.auditRows.some((r) => r.key === 'leveling.cardAccent' && r.new === '#9B59B6'));

    const custom = await post(h, 'leveling', 'card', { levelUpCard: '1', colour: 'purple', hex: '#12ab34' });
    assert.equal(custom.statusCode, 303);
    assert.equal(h.state.leveling.cardAccent, '#12AB34', 'a typed code wins and is stored upper case');
    const again = await get(h, 'leveling');
    assert.ok(again.body.includes('value="#12AB34"'), 'custom code shown in the field');
    assert.match(again.body, /name="levelUpCard" value="1" checked>/, 'switch shows on');

    const writes = h.calls.filter((c) => c.name === 'updateLevelingConfig').length;
    for (const hex of ['#12', 'red', '#GGGGGG']) {
        const res = await post(h, 'leveling', 'card', { levelUpCard: '1', hex });
        assert.equal(res.statusCode, 400, hex);
        assert.match(res.body, /colour code like #9B59B6/);
    }
    const unknown = await post(h, 'leveling', 'card', { levelUpCard: '1', colour: 'rainbow', hex: '' });
    assert.equal(unknown.statusCode, 400);
    assert.equal(h.calls.filter((c) => c.name === 'updateLevelingConfig').length, writes, 'refused input: nothing saved');

    await post(h, 'leveling', 'card', { colour: 'purple', hex: '#12AB34' });
    assert.equal(h.state.leveling.levelUpCard, false, 'switch off is saved');
});

test('leveling: XP boosts are listed, added and removed with audit rows; bad boosts are refused; the reward mode is saved', async () => {
    const h = await setup();
    h.state.leveling.channelMultipliers = { [TEXT]: 1.5 };
    h.state.leveling.roleMultipliers = { [ROLE_MANAGED]: 2 };
    const page = await get(h, 'leveling');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('action="/dashboard/leveling/boost-add"'), 'add boost forms');
    assert.ok(page.body.includes('action="/dashboard/leveling/reward-mode"'), 'reward mode form');
    assert.match(page.body, /x1\.5/);
    assert.match(page.body, /x2\.0/);
    assert.ok(page.body.includes('step="0.1"'), 'decimal input');
    assert.ok(page.body.includes('<option value="keep" selected>'), 'keep all is the default');
    assert.ok(!/—/.test(page.body.match(/id="s-xp-boosts"[\s\S]*?<\/section>/)?.[0] || ''), 'no em dash in the boosts card');

    // A managed role (e.g. Server Booster) may be boosted; a decimal comma is read as a point.
    const role = await post(h, 'leveling', 'boost-add', { type: 'role', id: ROLE_OK2, multiplier: '2,5' });
    assert.equal(role.statusCode, 303);
    assert.equal(h.state.leveling.roleMultipliers[ROLE_OK2], 2.5);
    assert.ok(h.auditRows.some((r) => r.key === `leveling.roleMultipliers.${ROLE_OK2}` && r.old === null && r.new === 2.5));

    const changed = await post(h, 'leveling', 'boost-add', { type: 'channel', id: TEXT, multiplier: '3' });
    assert.equal(changed.statusCode, 303);
    assert.ok(h.auditRows.some((r) => r.key === `leveling.channelMultipliers.${TEXT}` && r.old === 1.5 && r.new === 3));

    const same = await post(h, 'leveling', 'boost-add', { type: 'channel', id: TEXT, multiplier: '3.0' });
    assert.equal(same.statusCode, 303);
    assert.equal(h.calls.filter((c) => c.name === 'setLevelBoost').length, 2, 'unchanged boost: nothing saved');

    for (const [form, message] of [
        [{ type: 'channel', id: TEXT, multiplier: '1.0' }, /between 1.1 and 5/],
        [{ type: 'channel', id: TEXT, multiplier: '1.25' }, /at most 1 decimal/],
        [{ type: 'channel', id: TEXT, multiplier: 'abc' }, /must be a number/],
        [{ type: 'channel', id: CAT, multiplier: '2' }, /must be a text channel or voice channel or forum/],
        [{ type: 'role', id: GUILD, multiplier: '2' }, /@everyone/],
        [{ type: 'role', id: MISSING, multiplier: '2' }, /not in the server/],
    ]) {
        const res = await post(h, 'leveling', 'boost-add', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form));
        assert.match(res.body, message);
    }

    const removed = await post(h, 'leveling', 'boost-remove', { type: 'role', id: ROLE_MANAGED });
    assert.equal(removed.statusCode, 303);
    assert.equal(h.state.leveling.roleMultipliers[ROLE_MANAGED], undefined);
    assert.ok(h.auditRows.some((r) => r.key === `leveling.roleMultipliers.${ROLE_MANAGED}` && r.old === 2 && r.new === null));
    const writes = h.calls.filter((c) => c.name === 'setLevelBoost').length;
    await post(h, 'leveling', 'boost-remove', { type: 'role', id: ROLE_MANAGED });
    assert.equal(h.calls.filter((c) => c.name === 'setLevelBoost').length, writes, 'removing a missing boost writes nothing');

    await post(h, 'leveling', 'reward-mode', { rewardMode: 'highest' });
    assert.equal(h.state.leveling.rewardMode, 'highest');
    assert.ok(h.auditRows.some((r) => r.key === 'leveling.rewardMode' && r.new === 'highest'));
    const modeWrites = h.calls.filter((c) => c.name === 'updateLevelingConfig').length;
    await post(h, 'leveling', 'reward-mode', { rewardMode: 'highest' });
    assert.equal(h.calls.filter((c) => c.name === 'updateLevelingConfig').length, modeWrites, 'same mode: nothing saved');
});

test('leveling: changing a member level on the dashboard re-syncs reward roles; a failed sync only adds a note', async () => {
    const h = await setup();
    h.state.levelSync = { added: [ROLE_OK], removed: [], skipped: [], errors: 0 };
    const res = await post(h, 'leveling', 'member', { userId: MEMBER, op: 'set', levels: '7' });
    assert.equal(res.statusCode, 303);
    const sync = h.calls.find((c) => c.name === 'syncLevelRolesForMember');
    assert.ok(sync, 'sync called');
    assert.equal(sync.args[0].level, 7);
    assert.equal(sync.args[0].removeUnearned, true);
    const session = await h.sessions.get(h.session.id);
    assert.match(JSON.stringify(session), /gave 1 reward role/);

    const broken = await setup();
    broken.state.levelSyncFails = true;
    const ok = await post(broken, 'leveling', 'member', { userId: MEMBER, op: 'add', levels: '1' });
    assert.equal(ok.statusCode, 303, 'the level change still counts');
    assert.equal(broken.state.levels[MEMBER], 4);
    assert.match(JSON.stringify(await broken.sessions.get(broken.session.id)), /could not be changed/);
});

// ── Rules quiz (Verification page) ────────────────────────────────────────

test('verification / rules quiz: bad questions are refused (400, nothing saved); a valid form maps the correct answer', async () => {
    const base = { q1: 'Is spam allowed?', q1a1: 'No', q1a2: 'Yes', q1c: '1', cooldownMinutes: '5' };
    for (const [form, message] of [
        [{ ...base, q1: 'x'.repeat(151) }, /Too long: at most 150/],
        [{ ...base, q1a2: 'y'.repeat(81) }, /Too long: at most 80/],
        [{ ...base, q1c: '3' }, /correct answer \(answer 3\) is empty/],
        [{ ...base, q1c: '9' }, /correct answer must be between 1 and 4/],
        [{ ...base, q1a2: 'no' }, /must all be different/],
        [{ ...base, q1: '' }, /Question 1: write the question/],
        [{ ...base, cooldownMinutes: '0' }, /between 1 and 60/],
        [{ ...base, cooldownMinutes: '61' }, /between 1 and 60/],
    ]) {
        const h = await setup();
        const res = await post(h, 'verification', 'quiz', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form).slice(0, 80));
        assert.match(res.body, message);
        assert.ok(!h.calls.some((c) => c.name === 'updateVerificationSettings'), 'nothing saved');
    }
    const h = await setup();
    const res = await post(h, 'verification', 'quiz', { q2: 'Second slot', q2a1: 'One', q2a3: 'Three', q2c: '3', q1: '', cooldownMinutes: '10' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.state.verification.quiz, { questions: [{ question: 'Second slot', answers: ['One', 'Three'], correctIndex: 1 }], cooldownMinutes: 10 });
});

test('verification / rules quiz: on with no questions warns it is treated as off; moving and removing questions', async () => {
    const h = await setup();
    h.state.verification.quiz = { enabled: true, questions: [] };
    let page = await get(h, 'verification');
    assert.match(page.body, /no valid questions, so it is treated as off/);
    assert.match(page.body, /action="\/dashboard\/verification\/quiz"/);
    seedQuiz(h.state);
    page = await get(h, 'verification');
    assert.ok(!/treated as off/.test(page.body));
    assert.match(page.body, /Right answer: E/);
    assert.equal((await post(h, 'verification', 'quiz-move', { index: '1', direction: 'up', question: 'Q two' })).statusCode, 303);
    assert.deepEqual(h.state.verification.quiz.questions.map((q) => q.question), ['Q two', 'Q one']);
    assert.equal((await post(h, 'verification', 'quiz-remove', { index: '0', question: 'Q two' })).statusCode, 303);
    assert.deepEqual(h.state.verification.quiz.questions.map((q) => q.question), ['Q one']);
    assert.equal(h.state.verification.quiz.enabled, true, 'the switch is kept');
});

test('verification / rules quiz: "Suggest questions from my rules" fills drafts from the rules and saves nothing', async () => {
    const h = await setup();
    seedRules(h.state);
    const page = await run(h, h.d.modulePage, { method: 'GET', params: { module: 'verification' }, headers: { cookie: h.cookie }, query: { quiz: 'suggest' } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /2 suggested questions are filled in below/);
    assert.match(page.body, /name="q1" value="Which of these is a rule here\?"/);
    assert.match(page.body, /value="No spam"/);
    assert.match(page.body, /value="Be kind"/);
    assert.equal(h.calls.filter((c) => c.name === 'updateVerificationSettings').length, 0);
    assert.equal(h.auditRows.length, 0);
    // Without rules: a hint instead of drafts.
    const empty = await setup();
    const none = await run(empty, empty.d.modulePage, { method: 'GET', params: { module: 'verification' }, headers: { cookie: empty.cookie }, query: { quiz: 'suggest' } });
    assert.match(none.body, /no server rules to suggest from yet/);
});

// ── Member fields and open polls (no more typed IDs or pasted links) ─────

test('member fields: Tickets block, Purge "only from" and Logging ignore search by name; Find a member fills the ID back in', async () => {
    const h = await setup();
    const pages = { tickets: ['userId', 'block_user', 'modmail-blocked-members', true], channels: ['userId', 'purge_user', 'purge-messages', true], logging: ['id', 'ignore_user', 'ignore-lists', false] };
    for (const [module, [field, pick, anchor, bans]] of Object.entries(pages)) {
        const page = await get(h, module);
        assert.equal(page.statusCode, 200, module);
        assert.ok(page.body.includes(`data-member-search="/dashboard/members/search.json${bans ? '?bans=1' : ''}"`), `${module}: type-ahead`);
        assert.ok(page.body.includes(`href="/dashboard/members/search?for=${pick}&amp;back=%2Fdashboard%2F${module}&amp;at=${anchor}${bans ? '&amp;bans=1' : ''}"`), `${module}: Find link`);
        assert.ok(!page.body.includes('Copy User ID'), `${module}: no Developer Mode instructions`);
        const picked = await run(h, h.d.modulePage, { method: 'GET', params: { module }, headers: { cookie: h.cookie }, query: { [pick]: MEMBER } });
        assert.ok(picked.body.includes(`name="${field}" value="${MEMBER}"`), `${module}: the picked ID is filled in`);
        const junk = await run(h, h.d.modulePage, { method: 'GET', params: { module }, headers: { cookie: h.cookie }, query: { [pick]: '"><b>x' } });
        assert.ok(!junk.body.includes('"><b>x') && !junk.body.includes('&quot;&gt;&lt;b&gt;x'), `${module}: only an ID is taken from the query`);
    }
});

test('member fields: an @mention is accepted where a user ID was (tickets block, purge, logging ignore)', async () => {
    const h = await setup();
    assert.equal((await post(h, 'tickets', 'block', { userId: `<@${STRANGER}>` })).statusCode, 303);
    assert.ok(h.calls.some((c) => c.name === 'setModmailBlocked' && c.args.includes(STRANGER)), 'blocked by the mentioned ID');
    const p = await setup();
    assert.equal((await postConfirmed(p, 'channels', 'purge', { channelId: TEXT, amount: '5', userId: `<@!${MEMBER}>` })).statusCode, 303);
    assert.deepEqual(p.guild.channels.cache.get(TEXT).deletedIds, ['800000000000000001', '800000000000000003']);
    const l = await setup();
    assert.equal((await post(l, 'logging', 'ignore-add', { type: 'user', id: `<@${MEMBER}>` })).statusCode, 303);
    assert.ok(l.calls.some((c) => c.name === 'updateIgnoreList' && JSON.stringify(c.args).includes(MEMBER)));
    const bad = await post(await setup(), 'channels', 'purge', { channelId: TEXT, amount: '5', userId: 'bob' });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /Find a member/);
});

test('End a poll: Mewvo\'s open polls listed (escaped) with an End button each; the button ends that poll; the link stays as a fallback', async () => {
    const h = await setup();
    h.svc.openPollsFor = async () => ({ partial: false, polls: [{ messageId: '710000000000000015', channelId: TEXT, channelName: 'general', question: 'Pizza <b>?', endsAt: Date.UTC(2026, 10, 9), url: null }] });
    const page = await get(h, 'messages');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('Pizza &lt;b&gt;?') && !page.body.includes('Pizza <b>?'));
    assert.ok(page.body.includes('name="messageId" value="710000000000000015"'));
    assert.ok(page.body.includes(`name="channelId" value="${TEXT}"`));
    assert.match(page.body, /A poll is not in the list\? End it by its link/);
    assert.ok(page.body.includes('name="link"'), 'link fallback kept');
    const res = await post(h, 'messages', 'poll-end', { channelId: TEXT, messageId: '710000000000000015' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(h.calls.find((c) => c.name === 'endPoll').args, [`https://discord.com/channels/${GUILD}/${TEXT}/710000000000000015`], 'always this server');
    assert.deepEqual(h.auditRows.map((r) => r.key), ['poll.710000000000000015.ended']);
    // Bad IDs fall back to the (empty) link and are refused before the service.
    const bad = await setup();
    const refused = await post(bad, 'messages', 'poll-end', { channelId: 'x', messageId: '710000000000000015' });
    assert.equal(refused.statusCode, 400);
    assert.ok(!bad.calls.some((c) => c.name === 'endPoll'));

    const none = await setup();
    none.svc.openPollsFor = async () => ({ partial: true, polls: [] });
    const empty = await get(none, 'messages');
    assert.match(empty.body, /Mewvo has no open polls in this server\./);
    assert.match(empty.body, /some polls may be missing/);
    const failing = await setup();
    failing.svc.openPollsFor = async () => { throw new Error('db down'); };
    assert.match((await get(failing, 'messages')).body, /The open polls could not be loaded/);
});

test('setup step forms: the module save route returns to the step (back=setup&step=key); a bad step key is dropped', async () => {
    const h = await setup();
    const res = await post(h, 'automod', 'channels', { reviewChannelId: TEXT, alertsChannelId: '', back: 'setup', step: 'review' });
    assert.equal(res.redirectedTo, '/dashboard/setup?step=review');
    const odd = await post(h, 'automod', 'channels', { reviewChannelId: TEXT, alertsChannelId: '', back: 'setup', step: '../owner' });
    assert.equal(odd.redirectedTo, '/dashboard/setup');
    const page = await run(h, h.d.setup, { method: 'GET', headers: { cookie: h.cookie }, query: { step: 'review' } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /action="\/dashboard\/automod\/channels"/, 'the review step has its form');

    // A one-field post (what the setup step sends) changes only that field; the rest stays as stored.
    const p = await setup();
    const patches = () => p.calls.filter((c) => c.name === 'updateSettings').map((c) => Object.keys(c.args[1]));
    assert.equal((await post(p, 'enforcement', 'channels', { modLogChannelId: TEXT, back: 'setup', step: 'modLog' })).redirectedTo, '/dashboard/setup?step=modLog');
    assert.equal((await post(p, 'automod', 'channels', { alertsChannelId: TEXT, back: 'setup', step: 'alerts' })).redirectedTo, '/dashboard/setup?step=alerts');
    assert.equal((await post(p, 'enforcement', 'roles', { mutedRoleId: '', back: 'setup', step: 'muted' })).statusCode, 303);
    for (const keys of patches()) assert.ok(keys.length === 1 && ['modLogChannelId', 'alertsChannelId', 'mutedRoleId'].includes(keys[0]) || keys.length === 0, `only the sent field: ${keys}`);
    assert.ok(!patches().flat().includes('warnRoleIds') && !patches().flat().includes('evidenceChannelId') && !patches().flat().includes('reviewChannelId'));
    assert.equal((await post(p, 'logging', 'channels', { audit: TEXT })).statusCode, 303);
    assert.deepEqual(p.calls.filter((c) => c.name === 'setLogChannels').map((c) => Object.keys(c.args[0])), [['audit']], 'the other log channels are not touched');
    assert.equal((await post(p, 'birthdays', 'settings', { channelId: TEXT })).statusCode, 303);
    assert.deepEqual(Object.keys(p.calls.find((c) => c.name === 'updateBirthdaySettings').args[0]), ['channelId']);
});

// ── Audit fixes D7, D11, D12, D16, D17 (dashboard level) ─────────────────

test('D12: a cleared welcome / goodbye message is saved as cleared, an absent one stays; a cleared support invite is refused', async () => {
    const h = await setup();
    const cleared = await post(h, 'welcome', 'welcome', { channelId: TEXT, welcomeMessage: '', dmMessage: '' });
    assert.equal(cleared.statusCode, 303);
    assert.equal(h.calls.find((c) => c.name === 'updateWelcomeSettings').args[0].welcomeMessage, '', 'cleared, not "Nothing changed"');
    assert.equal(h.state.welcome.welcomeMessage, '');
    await post(h, 'welcome', 'goodbye', { goodbyeChannelId: TEXT, leaveMessage: '' });
    assert.equal(h.state.welcome.leaveMessage, '');
    const before = h.calls.filter((c) => c.name === 'updateWelcomeSettings').length;
    await post(h, 'welcome', 'welcome', { channelId: TEXT });
    const patch = h.calls.filter((c) => c.name === 'updateWelcomeSettings').slice(before)[0]?.args[0] || {};
    assert.ok(!('welcomeMessage' in patch) && !('dmMessage' in patch), 'a field absent from the form is left as stored');
    const invite = await post(h, 'enforcement', 'channels', { supportServerInvite: '' });
    assert.equal(invite.statusCode, 400);
    assert.match(invite.body, /support server invite cannot be empty/);
});

test('D11: module states are not cached as "off" after a failed read', async () => {
    const h = await setup();
    let fail = true;
    let calls = 0;
    const real = h.svc.getAutomodSettings;
    h.svc.getAutomodSettings = async (...args) => { calls += 1; if (fail) throw new Error('db down'); return real(...args); };
    const get = () => run(h, h.d.backup, { method: 'GET', params: {}, query: {}, headers: { cookie: h.cookie } });
    await get();
    await get();
    assert.equal(calls, 2, 'the failed read was not cached: the next request reads again');
    fail = false;
    await get();
    await get();
    assert.equal(calls, 3, 'a good read is cached');
});

test('D7: community pages and actions refuse with "database not responding" while the caches are not loaded', async () => {
    const h = await setup();
    h.svc.ensureCommunityCaches = async () => { throw Object.assign(new Error('not loaded'), { type: 'database', userMessage: 'The database is not responding right now.' }); };
    const page = await run(h, h.d.modulePage, { method: 'GET', params: { module: 'community' }, headers: { cookie: h.cookie }, query: {} });
    assert.equal(page.statusCode, 503);
    assert.match(page.body, /database is not responding/);
    assert.ok(!page.body.includes('name="starboardThreshold"'), 'no form of defaults');
    const before = h.calls.filter((c) => c.name === 'updateCommunitySettings').length;
    await post(h, 'community', 'suggestions', { channelId: TEXT }).catch(() => null);
    assert.equal(h.calls.filter((c) => c.name === 'updateCommunitySettings').length, before, 'nothing saved');
});

test('D16: custom automod rules are changed through one locked build (updateSettings gets a function)', async () => {
    const h = await setup();
    const seen = [];
    const real = h.svc.updateSettings;
    h.svc.updateSettings = async (guildId, patch, actor) => { seen.push(typeof patch); return real(guildId, patch, actor); };
    const res = await post(h, 'automod', 'custom-add', { name: 'No spam', action: 'delete', muteDuration: '', words: 'buy now' });
    assert.equal(res.statusCode, 303);
    assert.deepEqual(seen, ['function']);
    const id = h.state.registry.automodCustomRules.find((r) => r.name === 'No spam').id;
    assert.equal((await post(h, 'automod', 'custom-remove', { id })).statusCode, 303);
    assert.ok(!h.state.registry.automodCustomRules.some((r) => r.id === id));
    const gone = await post(h, 'automod', 'custom-remove', { id });
    assert.equal(gone.statusCode, 400, 'a rule removed meanwhile is "gone", read under the lock');
});

test('D17: the counter type select in the list has a (screen-reader) label; type names are translated', async () => {
    const h = await setup();
    const page = await run(h, h.d.modulePage, { method: 'GET', params: { module: 'counters' }, headers: { cookie: h.cookie }, query: {} });
    assert.equal(page.statusCode, 200);
    assert.ok(!page.body.includes('<label><select name="type"'), 'no empty label');
    assert.match(page.body, /<label><span class="sr">What it counts<\/span><select name="type">/);
    assert.match(page.body, /Members \+ Bots/);
});

test('leveling: Voice XP is off by default; a save sends only the changed fields, audited as leveling.voice.*; bad input refused', async () => {
    const h = await setup();
    const page = await get(h, 'leveling');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('action="/dashboard/leveling/voice"'), 'voice form');
    assert.match(page.body, /name="voiceEnabled" value="1">/, 'switch is off when nothing is saved');
    assert.match(page.body, /name="voiceCap"[^>]*value="120"|value="120"[^>]*name="voiceCap"/, 'daily cap default 120');
    const voiceSection = page.body.match(/id="s-voice-xp"[\s\S]*?<\/section>/)?.[0] || '';
    assert.ok(voiceSection, 'voice section is on the page');
    assert.ok(voiceSection.includes(`value="${VOICE}"`), 'voice channels are offered in the excluded picker');
    assert.ok(!voiceSection.includes(`<option value="${TEXT}"`), 'text channels are not offered');
    assert.ok(!/—/.test(voiceSection), 'no em dash in the voice section');

    const defaults = { voiceXpMin: '3', voiceXpMax: '7', voiceCap: '120', voiceMinHumans: '2' };
    const same = await post(h, 'leveling', 'voice', defaults);
    assert.equal(same.statusCode, 303);
    assert.equal(h.calls.filter((c) => c.name === 'updateVoiceXpConfig').length, 0, 'defaults: nothing saved');

    const on = await post(h, 'leveling', 'voice', { ...defaults, voiceEnabled: '1', voiceCap: '60', voiceExcluded: [VOICE] });
    assert.equal(on.statusCode, 303);
    const sent = h.calls.filter((c) => c.name === 'updateVoiceXpConfig').at(-1).args[0];
    assert.deepEqual(sent, { enabled: true, dailyCapMinutes: 60, excludedChannels: [VOICE] }, 'only the changed fields');
    assert.equal(h.state.leveling.voice.enabled, true);
    assert.ok(h.auditRows.some((r) => r.key === 'leveling.voice.enabled' && r.new === true));
    assert.ok(h.auditRows.some((r) => r.key === 'leveling.voice.dailyCapMinutes' && r.old === 120 && r.new === 60));
    assert.ok(h.auditRows.some((r) => r.key === 'leveling.voice.excludedChannels'));

    const writes = h.calls.filter((c) => c.name === 'updateVoiceXpConfig').length;
    for (const [form, message] of [
        [{ ...defaults, voiceCap: '1441' }, /between 0 and 1,?440/],
        [{ ...defaults, voiceMinHumans: '1' }, /between 2 and 10/],
        [{ ...defaults, voiceXpMax: '51' }, /between 1 and 50/],
        [{ ...defaults, voiceXpMin: '8' }, /Least XP per minute cannot be more than Most XP per minute/],
        [{ ...defaults, voiceExcluded: [TEXT] }, /voice/i],
    ]) {
        const res = await post(h, 'leveling', 'voice', form);
        assert.equal(res.statusCode, 400, JSON.stringify(form));
        assert.match(res.body, message);
    }
    assert.equal(h.calls.filter((c) => c.name === 'updateVoiceXpConfig').length, writes, 'nothing saved after bad input');
});
