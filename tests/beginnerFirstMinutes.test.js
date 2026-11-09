// Beginner audit Wave 2 (docs/beginner-audit-2026-11-09.md): a new server owner's first 10
// minutes in a server that is not one of Mewvo's own. Server language from Discord, role
// position, checklist essentials vs optional, /help first step, join welcome + owner DM,
// level-up / cat announcement defaults, home-server wording, translated category names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
process.env.MAIN_GUILD_ID ??= MAIN;
process.env.SUPPORT_GUILD_ID ??= SUPPORT;
process.env.PUBLIC_URL ??= 'https://bot.example/';
const OTHER = '130000000000000013';
const OLD = '140000000000000014'; // a server that added Mewvo before this change (has a settings row)
const BOT = '999999999999999999';
const OWNER_ID = '600000000000000006';
const LANGS = ['en', 'ru', 'de', 'fr', 'it', 'pl', 'es', 'pt-BR'];

const { botText, languageFromLocale, serverLanguage, detectedServerLanguage, setGuildLocaleResolver, textForGuild } = await import('../src/utils/botText.js');
const { setSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const { memberReach, reachOk, botPermissionReport } = await import('../src/services/dashboard/botPermissions.js');
const { gettingStarted, essentialSteps, optionalSteps, overviewPage, permissionsList } = await import('../src/services/dashboard/overview.js');
const { glossaryPage, setupPage } = await import('../src/services/dashboard/helpPages.js');
const { dashboardText } = await import('../src/services/dashboard/language.js');
const { createInitialHelpMenu, helpMenuOptions } = await import('../src/commands/Core/help.js');
const { categoryLabel } = await import('../src/config/commands/commandCategories.js');
const guide = await import('../src/services/setup/setupGuide.js');
const welcome = await import('../src/services/setup/joinWelcome.js');
const { defaultLevelingConfig } = await import('../src/services/leveling/leveling.js');
const { catSettings } = await import('../src/services/community/catService.js');
const { neutralValue, getSettingEntry } = await import('../src/services/settings/settingsRegistry.js');

// ── 2.1 Server language from Discord ──────────────────────────────────────

test('Discord locales map to the 8 languages; anything else is English', () => {
    const cases = {
        de: 'de', fr: 'fr', it: 'it', pl: 'pl', 'es-ES': 'es', 'es-419': 'es', 'pt-BR': 'pt-BR', ru: 'ru',
        'en-US': 'en', 'en-GB': 'en', ja: 'en', uk: 'en', 'zh-CN': 'en', '': 'en', 'x<script>': 'en',
    };
    for (const [locale, lang] of Object.entries(cases)) assert.equal(languageFromLocale(locale), lang, locale);
    assert.equal(languageFromLocale(undefined), 'en');
    assert.equal(detectedServerLanguage(OTHER, { locale: 'en-US' }), 'en');
    assert.equal(detectedServerLanguage(OTHER, { locale: 'ko' }), null, 'not one of the 8: nothing detected');
});

test('server language: saved > the server\'s Discord language > English; home servers unchanged', () => {
    const locales = new Map([[OTHER, 'de'], [OLD, 'pt-BR'], [MAIN, 'fr']]);
    setGuildLocaleResolver((id) => locales.get(id) || null);
    try {
        setSettingsCacheForTests(OTHER, {});
        assert.equal(serverLanguage(OTHER), 'de', 'never chosen: the server\'s Discord language');
        assert.equal(textForGuild(OTHER, { purpose: 'public' }).lang, 'de', 'public posts and DMs follow it');
        setSettingsCacheForTests(OTHER, { botLanguage: 'fr' });
        assert.equal(serverLanguage(OTHER), 'fr', 'a saved language always wins');
        setSettingsCacheForTests(OTHER, { botLanguage: 'en' });
        assert.equal(serverLanguage(OTHER), 'en', 'English saved on purpose stays English');
        // A server that had Mewvo before: a row with other settings, no botLanguage. Nothing is written.
        setSettingsCacheForTests(OLD, { catName: 'Mochi' });
        assert.equal(serverLanguage(OLD), 'pt-BR', 'existing servers get it too (read each time, no seed)');
        locales.set(OLD, 'ja');
        assert.equal(serverLanguage(OLD), 'en', 'a language Mewvo does not have: English');
        // Mewvo's own server: stored → English, as before (its Discord language is ignored).
        assert.equal(serverLanguage(MAIN), 'en');
        // Injected reads (the old test form) skip the detection step.
        assert.equal(serverLanguage(OTHER, { resolve: () => 'it' }), 'it');
        assert.equal(serverLanguage(OTHER, { resolve: () => 'en', source: () => 'default', locale: 'pl', isHome: () => false }), 'pl');
        assert.equal(serverLanguage(OTHER, { resolve: () => 'ru', source: () => 'database', locale: 'pl', isHome: () => false }), 'ru');
        // A failed read is cosmetic: English (logged once).
        assert.equal(serverLanguage(OTHER, { resolve: () => { throw new Error('db down'); } }), 'en');
    } finally {
        setGuildLocaleResolver(null);
        setSettingsCacheForTests(OTHER, null);
        setSettingsCacheForTests(OLD, null);
    }
});

// ── 2.6 Role position ─────────────────────────────────────────────────────

function perms(names = []) {
    const bits = new Set(names.map((n) => PermissionFlagsBits[n]));
    return { has: (bit) => bits.has(bit) };
}

/** A guild whose bot role sits at `top`; members [{ id, top, admin, bot }]. Any member fetch fails the test. */
function reachGuild(list, { top = 5, memberCount = list.length + 1 } = {}) {
    const guild = { id: OTHER, name: 'Cats', ownerId: OWNER_ID, memberCount };
    const role = (id, name, position) => ({ id, name, position });
    const botRole = role('botrole', 'Mewvo', top);
    const cache = new Map();
    const me = { id: BOT, user: { bot: true }, permissions: perms(['ViewChannel']), roles: { highest: botRole } };
    cache.set(BOT, me);
    for (const m of list) {
        cache.set(m.id, {
            id: m.id, user: { bot: Boolean(m.bot) }, permissions: perms(m.admin ? ['Administrator'] : []),
            roles: { highest: m.top === 0 ? role(OTHER, '@everyone', 0) : role(`r${m.top}`, m.name || `Role ${m.top}`, m.top) },
        });
    }
    guild.members = { me, cache, fetch: async () => assert.fail('no member fetch for the role position check') };
    return guild;
}

test('role position: members at or above Mewvo\'s role, from the cache only; admins, bots and the owner left out', () => {
    const guild = reachGuild([
        { id: '1', top: 8, name: 'VIP' }, { id: '2', top: 8, name: 'VIP' }, { id: '3', top: 5, name: 'Same' },
        { id: '4', top: 2 }, { id: '5', top: 0 }, { id: '6', top: 9, admin: true }, { id: '7', top: 9, bot: true },
        { id: OWNER_ID, top: 10 },
    ]);
    const reach = memberReach(guild);
    assert.equal(reach.count, 3, 'two VIPs and one at the same position');
    assert.deepEqual(reach.roles.map((r) => [r.name, r.members]), [['VIP', 2], ['Same', 1]]);
    assert.equal(reach.partial, false);
    assert.equal(reach.botRole, 'Mewvo');
    assert.equal(memberReach(reachGuild([{ id: '1', top: 2 }])).count, 0);
    const partial = memberReach(reachGuild([{ id: '1', top: 9 }], { memberCount: 500 }));
    assert.equal(partial.partial, true, 'cache holds fewer than 90%: "at least"');
    // A new server: the cache holds almost nobody, but a "Members" role sits above Mewvo. Not "fine".
    const fresh = reachGuild([], { memberCount: 300 });
    fresh.roles = { cache: new Map([
        ['m', { id: 'm', name: 'Members', position: 7, managed: false, permissions: perms([]) }],
        ['a', { id: 'a', name: 'Admins', position: 9, managed: false, permissions: perms(['Administrator']) }],
        ['b', { id: 'b', name: 'OtherBot', position: 8, managed: true, permissions: perms([]) }],
        ['l', { id: 'l', name: 'Low', position: 1, managed: false, permissions: perms([]) }],
    ]) };
    const unsure = memberReach(fresh);
    assert.deepEqual([unsure.count, unsure.partial, unsure.rolesAbove.map((r) => r.name)], [0, true, ['Members']]);
    assert.equal(reachOk(unsure), false, 'an almost empty cache does not pass as verified');
    const step = gettingStarted({ config: {}, welcome: null, settings: {}, mutedRole: null, home: false, reach: unsure }).find((i) => i.key === 'rolePosition');
    assert.equal(step.done, false);
    assert.match(step.hint, /Roles above Mewvo's role: @Members\. Mewvo can't moderate members who have them/);
    assert.match(String(permissionsList({ ...botPermissionReport(fresh), reach: unsure }, dashboardText('en'))), /Roles above Mewvo&#39;s role: @Members/);
    const setupRow = guide.checklistRows({ settings: {}, modules: {}, home: false, languageSource: 'database', reach: unsure }, botText('en'))[0];
    assert.equal(setupRow.done, false);
    assert.match(setupRow.text, /^Roles above Mewvo's role: @Members\./);
    fresh.roles.cache.delete('m');
    assert.equal(reachOk(memberReach(fresh)), true, 'no role members can hold sits above: verified from the role list');
    assert.equal(memberReach({ members: {} }), null);
    assert.equal(memberReach(null), null);

    const tr = dashboardText('en');
    const report = { ...botPermissionReport(guild), reach };
    const card = String(permissionsList(report, tr));
    assert.match(card, /Members Mewvo can&#39;t moderate: 3/);
    assert.match(card, /Drag Mewvo higher in Server Settings → Roles\./);
    assert.match(card, /@VIP, @Same/);
    const atLeast = String(permissionsList({ ...report, reach: partial }, tr));
    assert.match(atLeast, /can&#39;t moderate: at least 1/);
});

// ── 2.5 Checklist: essentials and optional ────────────────────────────────

const BASE = { config: {}, welcome: null, settings: {}, mutedRole: null };
const keys = (items) => items.map((i) => i.key);

test('checklist outside Mewvo\'s servers: role position first, essentials then optional, progress counts essentials only', () => {
    const reach = { count: 4, partial: false, roles: [{ id: 'r', name: 'Members', members: 4 }], botRole: 'Mewvo' };
    const items = gettingStarted({
        ...BASE, home: false, reach, permissions: { ok: true }, language: { saved: false, code: 'en', detected: 'de' },
    });
    assert.deepEqual(keys(essentialSteps(items)), ['rolePosition', 'permissions', 'language', 'modLog', 'logChannel', 'review', 'appealsHome']);
    assert.deepEqual(keys(optionalSteps(items)), ['modRole', 'alerts', 'muted', 'appeals', 'welcome', 'ticketCategory', 'ticketStaff', 'verification', 'leveling', 'birthdays']);
    for (const home of ['appealPanel', 'bannedRole']) assert.ok(!keys(items).includes(home), `${home}: home only`);
    const role = items[0];
    assert.equal(role.done, false);
    assert.equal(role.href, '/dashboard/setup?step=rolePosition');
    assert.match(role.hint, /Members Mewvo can't moderate: 4\. Their top role \(@Members\)/);
    const lang = items.find((i) => i.key === 'language');
    assert.equal(lang.done, false);
    assert.equal(lang.languageCode, 'de', 'the setup form preselects the detected language');
    assert.match(lang.hint, /Mewvo uses Deutsch, your server's language in Discord/);
    assert.equal(items.find((i) => i.key === 'modRole').href, '/dashboard/commands#s-bot-settings');

    // Where members appeal: done only once chosen (and with an invite for "own server").
    const appeals = (settings) => gettingStarted({ ...BASE, home: false, settings }).find((i) => i.key === 'appealsHome').done;
    assert.equal(appeals({ appealsHome: 'mewvo', appealsHomeSaved: false }), false, 'the default is not a choice');
    assert.equal(appeals({ appealsHome: 'mewvo', appealsHomeSaved: true }), true);
    assert.equal(appeals({ appealsHome: 'own', appealsHomeSaved: true }), false, 'own server without an invite');
    assert.equal(appeals({ appealsHome: 'own', appealsHomeSaved: true, appealsInvite: 'https://discord.gg/abc' }), true);
    assert.equal(gettingStarted({ ...BASE, home: false, language: { saved: true, code: 'fr' } }).find((i) => i.key === 'language').done, true);

    // The page: two groups, the progress counts essentials only.
    const o = { bot: { ready: true, ping: null }, database: null, guild: null, recent: [], lockdown: undefined, checklist: items };
    const page = overviewPage({ session: { username: 'a', csrf: 't' }, overview: o });
    assert.match(page, /1 of 7 essentials done\./);
    assert.ok(page.indexOf('>Essentials</h3>') < page.indexOf('>Optional</h3>'));
    assert.ok(page.indexOf('Mewvo&#39;s role position') < page.indexOf('Mewvo&#39;s permissions'), 'role position is the first step');
    const setup = String(setupPage({ session: { username: 'a' }, steps: items, query: {} }));
    assert.match(setup, /1 of 7 essentials done\./);
    assert.match(setup, /<h2>Mewvo&#39;s role position<\/h2>/, 'the first open step is the role position');
    assert.match(setup, /Discord lets Mewvo moderate only members whose top role is below/);
});

test('checklist in Mewvo\'s own server: the appeals category stays an essential, no role row without a report', () => {
    const items = gettingStarted({ ...BASE, permissions: { ok: true }, appealPanel: null, supportServer: true });
    assert.deepEqual(keys(essentialSteps(items)), ['permissions', 'modLog', 'logChannel', 'review', 'appeals', 'appealPanel', 'bannedRole']);
    assert.ok(!keys(items).includes('appealsHome') && !keys(items).includes('rolePosition'));
});

test('checklist labels and hints exist in all 8 languages, with no placeholder left', () => {
    const reach = { count: 2, partial: true, roles: [{ id: 'r', name: 'VIP', members: 2 }], botRole: 'Mewvo' };
    for (const lang of LANGS) {
        const tr = dashboardText(lang);
        const items = gettingStarted({ ...BASE, home: false, reach, permissions: { ok: true }, language: { saved: false, code: 'en', detected: 'it' } }, tr);
        for (const item of items) {
            assert.ok(item.label && !item.label.startsWith('overview.'), `${lang}: ${item.key}`);
            assert.ok(item.hint && !/\{[a-zA-Z]+\}/.test(item.hint) && !item.hint.includes('overview.'), `${lang}: ${item.key} ${item.hint}`);
        }
        for (const key of ['overview.start.essentials', 'overview.start.optional', 'help.setup.rolePosition', 'botLanguage.form.detected', 'botLanguage.form.notChosen']) {
            assert.ok(tr.has(key), `${lang}: ${key}`);
        }
    }
});

// ── 2.7 / 4.8 /help ───────────────────────────────────────────────────────

const helpClient = { commands: new Map(), user: { username: 'Mewvo', displayAvatarURL: () => 'https://x/a.png' } };

test('/help: /setup first everywhere; boosting line only in Mewvo\'s servers; modmail only when the server has it', async () => {
    const other = (await createInitialHelpMenu(helpClient, OTHER, true, botText('en'))).embeds[0].data;
    assert.equal(other.description, 'Moderation, automod, appeals, tickets and more for this server.');
    assert.ok(other.fields[0].value.startsWith('1. **/setup**'));
    const home = (await createInitialHelpMenu(helpClient, MAIN, true, botText('en'))).embeds[0].data;
    assert.equal(home.description, 'support us by boosting');
    for (const lang of LANGS) {
        const data = (await createInitialHelpMenu(helpClient, OTHER, false, botText(lang))).embeds[0].data;
        assert.ok(!/boost/i.test(data.description), `${lang}: no boosting line outside home`);
        assert.ok(!data.fields[0].value.includes('\n'), `${lang}: no modmail line by default`);
        const mm = (await createInitialHelpMenu(helpClient, OTHER, false, botText(lang), { modmail: true })).embeds[0].data;
        assert.equal(mm.fields[0].value.split('\n').length, 2, `${lang}: modmail line when on`);
    }

    // helpMenuOptions: modmail set up = a modmail or ticket category that exists; unreadable config = not mentioned.
    const category = { id: '700000000000000001', type: 4 };
    const guild = { id: OTHER, channels: { cache: new Map([[category.id, category]]) } };
    const client = { guilds: { cache: new Map([[OTHER, guild]]) } };
    setSettingsCacheForTests(OTHER, {});
    try {
        assert.deepEqual(await helpMenuOptions(client, OTHER, { ticketCategoryId: category.id }), { home: false, modmail: true });
        assert.deepEqual(await helpMenuOptions(client, OTHER, {}), { home: false, modmail: false });
        assert.deepEqual(await helpMenuOptions(client, OTHER, null, { getConfig: async () => { throw new Error('db down'); } }), { home: false, modmail: false });
    } finally {
        setSettingsCacheForTests(OTHER, null);
    }
});

test('category names are translated in /help and /setup (keys in all 8 languages), with localized command descriptions', () => {
    const folders = ['Birthday', 'Community', 'Core', 'Enforcement', 'Fun', 'Giveaway', 'JoinToCreate', 'Leveling', 'Logging', 'Moderation',
        'Owner', 'Reaction_roles', 'Search', 'ServerStats', 'Ticket', 'Tools', 'Utility', 'Verification', 'Welcome'];
    for (const lang of LANGS) for (const folder of folders) assert.ok(botText(lang).has(`core.categories.${folder}`), `${lang}: ${folder}`);
    assert.equal(categoryLabel('Reaction_roles', botText('en')), 'Reaction Roles', 'English: the old readable folder name');
    assert.equal(categoryLabel('Enforcement', botText('de')), 'Strafen');
    assert.equal(categoryLabel('NoSuchFolder', botText('de')), 'No Such Folder', 'unknown: the folder name');

    const command = { category: 'Enforcement', data: { toJSON: () => ({ name: 'warnx', description: 'Warn someone', description_localizations: { de: 'Jemanden verwarnen' } }) } };
    const client = { commands: new Map([['warnx', command]]) };
    const [de] = guide.commandCategories(client, OTHER, botText('de'));
    assert.equal(de.label, 'Strafen');
    assert.equal(de.commands[0].description, 'Jemanden verwarnen');
    const [en] = guide.commandCategories(client, OTHER, botText('en'));
    assert.equal(en.commands[0].description, 'Warn someone');
    const reply = guide.categoryReply({ client, guildId: OTHER, userId: '1', category: 'Enforcement', tr: botText('de') }).embeds[0].toJSON();
    assert.match(reply.title, /Strafen/);
    assert.match(reply.description, /Jemanden verwarnen/);
});

test('/setup checklist: role position row first, detected language shown', () => {
    const tr = botText('en');
    const state = {
        settings: { botLanguage: 'en' }, modules: {}, home: false, languageSource: 'default', detectedLanguage: 'de',
        reach: { count: 3, partial: true, roles: [{ name: 'VIP' }] },
    };
    const rows = guide.checklistRows(state, tr);
    assert.equal(rows[0].key, 'rolePosition');
    assert.equal(rows[0].done, false);
    assert.equal(rows[0].text, 'Members Mewvo can\'t moderate: at least 3 (top role @VIP). Drag Mewvo\'s role higher: Server Settings → Roles.');
    assert.equal(rows.find((r) => r.key === 'language').text, 'Deutsch (your server\'s language in Discord). Change it on the dashboard (Bot language).');
    const ok = guide.checklistRows({ ...state, reach: { count: 0, roles: [] }, detectedLanguage: null }, tr);
    assert.equal(ok[0].done, true);
    assert.match(ok.find((r) => r.key === 'language').text, /^English \(default\)/);
    assert.equal(guide.checklistRows({ ...state, reach: null }, tr)[0].key, 'modLog', 'not checkable: no row');
});

// ── 2.9 Join welcome ──────────────────────────────────────────────────────

function joinGuild({ channel = null, owner = undefined } = {}) {
    const guild = {
        id: OTHER, name: 'Cats & Co', ownerId: OWNER_ID, systemChannel: channel,
        channels: { cache: new Map(channel ? [[channel.id, channel]] : []) },
        members: { me: { id: BOT, permissions: perms([]) } },
        fetchOwner: async () => {
            if (owner instanceof Error) throw owner;
            return owner;
        },
    };
    return guild;
}
const silentLog = () => {
    const lines = [];
    return { lines, warn: (m) => lines.push(['warn', m]), info: (m) => lines.push(['info', m]), debug: () => {} };
};
const joinDeps = (log, extra = {}) => ({
    getGuildConfig: async () => ({}), stampWelcome: async () => {}, blacklistHit: () => null, textFor: () => botText('en'), log, ...extra,
});

test('join welcome: an admin line, the dashboard button says it is for admins, optional features (leveling) named', () => {
    const payload = welcome.welcomeMessage({ id: OTHER, name: 'Cats' }, botText('en'));
    const text = payload.embeds[0].toJSON().description;
    assert.ok(text.startsWith('**Admins:** run **/setup** or open the dashboard to get started.'));
    assert.match(text, /leveling \(level-up posts stay off until you turn them on\)/);
    const labels = payload.components[0].toJSON().components.map((b) => b.label);
    assert.deepEqual(labels, ['Dashboard (for admins)', 'Mewvo support server']);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    for (const lang of LANGS) {
        const tr = botText(lang);
        for (const key of ['setup.welcome.body', 'setup.welcome.ownerDm', 'setup.welcome.optional', 'setup.welcome.dashboardButton']) assert.ok(tr.has(key), `${lang}: ${key}`);
        assert.ok(tr.t('setup.welcome.ownerDm', { server: 'X' }).includes('**/setup**'), lang);
    }
});

test('join welcome: no writable channel → the server owner gets one DM (no mentions); never throws', async () => {
    const dms = [];
    const owner = { id: OWNER_ID, user: { bot: false }, send: async (p) => dms.push(p) };
    const log = silentLog();
    const result = await welcome.welcomeOnJoin(joinGuild({ owner }), { user: { id: BOT } }, { deps: joinDeps(log) });
    assert.equal(result.posted, null);
    assert.equal(result.ownerDm, true);
    assert.equal(dms.length, 1);
    assert.match(dms[0].embeds[0].toJSON().description, /^Mewvo was added to \*\*Cats & Co\*\*, but it can't post in any channel there/);
    assert.deepEqual(dms[0].allowedMentions, { parse: [] });

    // A channel took the post: no owner DM.
    const sent = [];
    const channel = { id: '200000000000000001', isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: async (p) => sent.push(p) };
    const posted = await welcome.welcomeOnJoin(joinGuild({ channel, owner: { id: OWNER_ID, send: async () => assert.fail('no owner DM when posted') } }), { user: { id: BOT } }, { deps: joinDeps(silentLog()) });
    assert.equal(posted.posted, channel.id);
    assert.equal(posted.ownerDm, false);

    // A blacklisted owner, an owner with DMs closed, no owner known: nothing thrown.
    const blocked = await welcome.welcomeOnJoin(joinGuild({ owner: { id: OWNER_ID, send: async () => assert.fail('blacklisted') } }), { user: { id: BOT } },
        { deps: joinDeps(silentLog(), { blacklistHit: ({ userId }) => (userId === OWNER_ID ? { kind: 'user' } : null) }) });
    assert.equal(blocked.ownerDm, false);
    const closedLog = silentLog();
    const closed = await welcome.welcomeOnJoin(joinGuild({ owner: { id: OWNER_ID, send: async () => { throw new Error('Cannot send messages to this user'); } } }), { user: { id: BOT } }, { deps: joinDeps(closedLog) });
    assert.equal(closed.ownerDm, false);
    assert.ok(closedLog.lines.some(([level, m]) => level === 'warn' && /no DM to the owner/.test(m)));
    const unknown = await welcome.welcomeOnJoin(joinGuild({ owner: new Error('Unknown Member') }), { user: { id: BOT } }, { deps: joinDeps(silentLog()) });
    assert.equal(unknown.ownerDm, false);
});

test('join welcome: the owner who added Mewvo and got the DM is not DMed twice', async () => {
    const dms = [];
    const owner = { id: OWNER_ID, bot: false, user: { bot: false }, send: async (p) => dms.push(p) };
    const guild = joinGuild({ owner });
    guild.members.me.permissions = perms(['ViewAuditLog']);
    guild.fetchAuditLogs = async () => ({ entries: new Map([['1', { target: { id: BOT }, createdTimestamp: Date.now(), executor: owner }]]) });
    const result = await welcome.welcomeOnJoin(guild, { user: { id: BOT } }, { deps: joinDeps(silentLog()) });
    assert.equal(result.dm, true);
    assert.equal(result.ownerDm, false);
    assert.equal(dms.length, 1);
});

// ── 2.10 / D5 Level-up posts and cat announcements ────────────────────────

test('level-up posts: off by default outside Mewvo\'s servers, on at home; a saved config keeps its value', () => {
    assert.equal(defaultLevelingConfig(OTHER).announceLevelUp, false);
    assert.equal(defaultLevelingConfig(MAIN).announceLevelUp, true);
    assert.equal(defaultLevelingConfig(SUPPORT).announceLevelUp, true);
    assert.equal(defaultLevelingConfig().announceLevelUp, true, 'no server: as before');
    assert.equal(defaultLevelingConfig(OTHER).enabled, true, 'XP itself still runs');
});

test('cat announcements: off by default outside Mewvo\'s servers; a saved value wins; home unchanged', () => {
    assert.equal(neutralValue(getSettingEntry('catAnnounce')), false);
    setSettingsCacheForTests(OTHER, {});
    setSettingsCacheForTests(OLD, { catAnnounce: true });
    try {
        assert.equal(catSettings(OTHER).announce, false);
        assert.equal(catSettings(OLD).announce, true, 'a server that turned it on keeps it');
        setSettingsCacheForTests(MAIN, {});
        assert.equal(catSettings(MAIN).announce, true, 'home default stays on');
    } finally {
        setSettingsCacheForTests(OTHER, null);
        setSettingsCacheForTests(OLD, null);
        setSettingsCacheForTests(MAIN, null);
    }
});

// ── 2.13 Home-server wording ──────────────────────────────────────────────

const MAIN_SERVER_WORDS = /main server|Hauptserver|основн\S* сервер|serveur principal|server principale|główn\S* serwer|serwer\S* główn|servidor principal/i;
const ENV_NAME = /\b[A-Z]{3,}_[A-Z0-9_]{3,}\b/;

test('dashboard texts for any server: no "main server" and no environment variable names', () => {
    const keysToCheck = [
        'help.words.server.text', 'inbox.conversation.editingOff', 'inbox.conversation.needsAdmin', 'errors.editingOffText',
        'errors.noAccessLogin', 'errors.noAccessLost', 'frame.module.readOnly', 'members.notice.readOnly',
        'members.notice.viewOnly.actions', 'members.notice.viewOnly.cases', 'members.notice.viewOnly.appeals', 'members.notice.viewOnly.orders',
        'members.list.empty', 'members.list.unavailable', 'members.bans.empty', 'moduleList.page.readOnly', 'memberTools.notice.readOnly',
        'memberTools.notice.viewOnly', 'memberTools.insights.noGuild', 'moderation.access.needModRole', 'moderation.access.needAdmin',
        'moderation.access.enforcementAdmin', 'permissionFix.page.adminOnly', 'permissionFix.route.noServerText',
        'permissionFix.route.noServerNothing', 'permissionFix.route.adminOnly',
    ];
    for (const lang of LANGS) {
        const tr = dashboardText(lang);
        for (const key of keysToCheck) {
            const text = tr.t(key, { action: 'Ban', count: 3 });
            assert.ok(!MAIN_SERVER_WORDS.test(text), `${lang} ${key}: ${text}`);
            assert.ok(!ENV_NAME.test(text), `${lang} ${key}: ${text}`);
        }
        assert.ok(!MAIN_SERVER_WORDS.test(tr.t('members.bans.bannedCount', { count: 3 })), lang);
    }
});

test('rendered pages of another server (glossary, overview checklist, setup) name no main server and no env names', () => {
    for (const lang of LANGS) {
        const items = gettingStarted({ ...BASE, home: false, permissions: { ok: true }, language: { saved: false, code: 'en', detected: null } }, dashboardText(lang));
        const session = { username: 'a', csrf: 't', lang, isHomeServer: false };
        const o = { bot: { ready: true, ping: null }, database: null, guild: { name: 'Cats', memberCount: 3 }, recent: [], lockdown: undefined, checklist: gettingStarted({ ...BASE, home: false, permissions: { ok: true } }, dashboardText(lang)) };
        const pages = {
            glossary: String(glossaryPage({ session })),
            overview: String(overviewPage({ session, overview: o })),
            setup: String(setupPage({ session, steps: items, query: {} })),
        };
        for (const [name, page] of Object.entries(pages)) {
            const visible = page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ');
            assert.ok(!MAIN_SERVER_WORDS.test(visible), `${lang} ${name}: ${visible.match(MAIN_SERVER_WORDS)?.[0]}`);
            assert.ok(!ENV_NAME.test(visible), `${lang} ${name}: ${visible.match(ENV_NAME)?.[0]}`);
        }
    }
});

// ── Dashboard → Bot language: the detected language until one is saved ───

test('Bot language page: shows the detected language until saved; saving it (even English) stores the choice', async () => {
    const { default: page } = await import('../src/services/dashboard/modules/botLanguage.js');
    const env = { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT };
    const saved = [];
    const ctx = (preferredLocale) => ({
        guildId: OTHER, env, guild: { id: OTHER, preferredLocale, roles: { cache: new Map() }, members: { me: null } },
        canEdit: true, canAct: true, csrf: 't', actor: { userId: '1', username: 'a' },
        services: { updateSettings: async (guildId, patch) => { saved.push([guildId, patch]); return { changes: Object.entries(patch).map(([key, v]) => ({ key, old: null, new: v })) }; } },
    });
    setSettingsCacheForTests(OTHER, {});
    try {
        const data = await page.load(ctx('de'));
        assert.deepEqual([data.language, data.saved, data.detected], ['de', false, 'de']);
        const html = String(page.render(ctx('de'), data));
        assert.match(html, /Not chosen yet: Mewvo uses Deutsch, your server&#39;s language in Discord\. Save to keep it\./);
        assert.match(html, /<option value="de" selected>/);
        const english = await page.load(ctx('en-US'));
        assert.equal(english.language, 'en');
        assert.match(String(page.render(ctx('en-US'), english)), /Not chosen yet: Mewvo uses English\./);
        const result = await page.actions.language.run(ctx('en-US'), { botLanguage: 'en' });
        assert.deepEqual(saved, [[OTHER, { botLanguage: 'en' }]], 'English saved on purpose');
        assert.equal(result.changes.length, 1);

        setSettingsCacheForTests(OTHER, { botLanguage: 'en' });
        const after = await page.load(ctx('de'));
        assert.deepEqual([after.language, after.saved], ['en', true], 'saved: the detected language no longer applies');
        assert.doesNotMatch(String(page.render(ctx('de'), after)), /Not chosen yet/);
        assert.deepEqual(await page.actions.language.run(ctx('de'), { botLanguage: 'en' }), { changes: [] }, 'same saved value: nothing changed');
    } finally {
        setSettingsCacheForTests(OTHER, null);
    }
});
