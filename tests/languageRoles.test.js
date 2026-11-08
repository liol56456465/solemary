// Language roles: resolveBotLanguage's first step (a member's language role), purpose 'member',
// the prefix-command rule, the /language switch and panel, the registry setting and its seeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
    BOT_PURPOSES, memberLanguage, resetBotLanguageLogForTests, resolveBotLanguage, textForGuild, textForInteraction,
} from '../src/utils/botText.js';
import {
    LANGUAGE_ROLE_HOME_DEFAULT, defaultValue, getSettingEntry, neutralValue, seedValue, validatePatch, validateSetting,
} from '../src/services/settings/settingsRegistry.js';
import { resetSettingsCacheForTests, resolveSetting, setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';
import {
    LanguageRoleError, languagePanelRows, languagePickerRow, languageRolesFor, offeredLanguages, switchLanguageRole,
} from '../src/services/languageRoleService.js';
import languageButton from '../src/interactions/buttons/language/languageRole.js';
import languageSelect from '../src/interactions/selectMenus/language/languagePick.js';
import languageCommand, { languagePanelMessage, languageSetReply } from '../src/commands/Reaction_roles/language.js';
import { isEveryoneCommand } from '../src/config/commands/commandAccess.js';
import { dashboardPageFor } from '../src/config/commands/retirement.js';
import { botText } from '../src/utils/botText.js';
import { logger } from '../src/utils/logger.js';

const GUILD = '100000000000000777';
const R = { en: '700000000000000001', ru: '700000000000000002', de: '700000000000000003', pl: '700000000000000004', 'pt-BR': '700000000000000005' };
const MAP = { en: R.en, ru: R.ru, de: R.de, pl: R.pl, 'pt-BR': R['pt-BR'] };
const PROD_MAIN = '1527697154926182492';

/** resolve(guildId, key) stub: languageRoles → map, botLanguage → server language. */
const resolver = (map = MAP, server = 'pl') => (guildId, key) => (key === 'languageRoles' ? map : server);
const memberWith = (...roleIds) => ({ id: '300000000000000001', roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } });

// ── resolution order ────────────────────────────────────────────────────

test('purposes: reply, dm, member, public', () => {
    assert.deepEqual([...BOT_PURPOSES], ['reply', 'dm', 'member', 'public']);
});

test('a language role wins for reply, dm and member; a channel-wide public post keeps the server language', () => {
    const resolve = resolver();
    const member = memberWith(R.de);
    const interaction = { locale: 'fr', guildId: GUILD, member, user: { id: member.id } };
    assert.equal(resolveBotLanguage({ interaction, purpose: 'reply', resolve }), 'de', 'reply: role before Discord locale');
    assert.equal(resolveBotLanguage({ guildId: GUILD, member, purpose: 'dm', resolve }), 'de');
    assert.equal(resolveBotLanguage({ guildId: GUILD, member, purpose: 'member', resolve }), 'de');
    assert.equal(resolveBotLanguage({ guildId: GUILD, member, purpose: 'public', resolve }), 'pl', 'public never looks at a role');
});

test('without a role (or without a member) the old rule applies unchanged', () => {
    const resolve = resolver();
    const member = memberWith('799999999999999999');
    const interaction = { locale: 'fr', guildId: GUILD, member, user: { id: member.id } };
    assert.equal(resolveBotLanguage({ interaction, purpose: 'reply', resolve }), 'fr');
    assert.equal(resolveBotLanguage({ guildId: GUILD, member, purpose: 'dm', resolve }), 'pl');
    assert.equal(resolveBotLanguage({ guildId: GUILD, member, purpose: 'member', resolve }), 'pl', "'member' without a role: the server language");
    assert.equal(resolveBotLanguage({ guildId: GUILD, userId: member.id, purpose: 'dm', resolve }), 'pl', 'userId only: no role lookup');
    assert.equal(resolveBotLanguage({ guildId: null, member: memberWith(R.de), purpose: 'member', resolve }), 'en', 'no server: English');
});

test('several language roles: a fixed order decides (en, ru, de, fr, it, pl, es, pt-BR)', () => {
    const resolve = resolver();
    assert.equal(memberLanguage(GUILD, memberWith(R['pt-BR'], R.de, R.ru), { resolve }), 'ru');
    assert.equal(memberLanguage(GUILD, memberWith(R['pt-BR'], R.pl), { resolve }), 'pl');
    assert.equal(memberLanguage(GUILD, memberWith(R.en, R.de), { resolve }), 'en');
});

test('an API member (roles as an array of ids) works too; an unset language never matches', () => {
    const resolve = resolver({ ...MAP, fr: null });
    assert.equal(memberLanguage(GUILD, { roles: [R['pt-BR']] }, { resolve }), 'pt-BR');
    assert.equal(memberLanguage(GUILD, { roles: [] }, { resolve }), null);
    assert.equal(memberLanguage(GUILD, { roles: null }, { resolve }), null);
});

test('a failed languageRoles read falls through to the next step, logged once', () => {
    resetBotLanguageLogForTests();
    const warnings = [];
    const realWarn = logger.warn;
    logger.warn = (message) => { warnings.push(String(message)); };
    try {
        const resolve = (guildId, key) => { if (key === 'languageRoles') throw new Error('database not responding'); return 'it'; };
        const member = memberWith(R.de);
        assert.equal(resolveBotLanguage({ guildId: GUILD, member, purpose: 'member', resolve }), 'it');
        assert.equal(resolveBotLanguage({ guildId: GUILD, member, purpose: 'dm', resolve }), 'it');
        assert.equal(warnings.filter((w) => w.includes('Language roles')).length, 1);
    } finally {
        logger.warn = realWarn;
        resetBotLanguageLogForTests();
    }
});

test('prefix commands: the answer is a channel post → language role, else the server language (not English)', () => {
    const resolve = resolver();
    const prefix = { _isPrefixCommand: true, guildId: GUILD, member: memberWith(), user: { id: '1' } };
    assert.equal(resolveBotLanguage({ interaction: prefix, purpose: 'reply', resolve }), 'pl');
    assert.equal(resolveBotLanguage({ interaction: { ...prefix, member: memberWith(R.ru) }, purpose: 'reply', resolve }), 'ru');
    // Real path through the settings cache (non-home server): textForInteraction on a prefix mock.
    resetSettingsCacheForTests();
    try {
        setSettingsCacheForTests(GUILD, { botLanguage: 'es', languageRoles: { de: R.de } });
        assert.equal(textForInteraction(prefix).lang, 'es');
        assert.equal(textForInteraction({ ...prefix, member: memberWith(R.de) }).lang, 'de');
        assert.equal(textForInteraction({ locale: 'fr', guildId: GUILD, member: memberWith(), user: { id: '1' } }).lang, 'fr', 'slash replies keep the locale');
        assert.equal(textForGuild(GUILD, { member: memberWith(R.de), purpose: 'member' }).lang, 'de');
        assert.equal(textForGuild(GUILD, { member: memberWith(R.de), purpose: 'public' }).lang, 'es');
    } finally {
        resetSettingsCacheForTests();
    }
});

// ── the setting and its seeds ───────────────────────────────────────────

test('languageRoles: a guild "main" json key for every server, validated as role ids, one role per language', () => {
    const entry = getSettingEntry('languageRoles');
    assert.equal(entry.guild, 'main');
    assert.ok(!entry.homeOnly, 'works in every server');
    assert.equal(validatePatch({ languageRoles: { en: R.en } }, 'other').languageRoles.en, R.en);
    assert.ok(validateSetting('languageRoles', { en: R.en, de: R.de }).ok);
    assert.ok(validateSetting('languageRoles', {}).ok);
    assert.ok(validateSetting('languageRoles', { fr: null }).ok);
    assert.match(validateSetting('languageRoles', { de: R.de, fr: R.de }).error, /its own role/);
    assert.equal(validateSetting('languageRoles', { en: 'abc' }).ok, false);
    assert.equal(validateSetting('languageRoles', { lt: R.en }).ok, false, 'only the 8 languages');
});

test('seed: the owner\'s roles are the main server\'s home default (production only)', () => {
    const entry = getSettingEntry('languageRoles');
    const prod = { NODE_ENV: 'production' };
    assert.deepEqual(defaultValue(entry, prod), {
        en: '1569098172578402344', ru: '1569098287590670356', de: '1569098415282069544', fr: '1569099080125259776', it: '1569099182042648727',
        pl: '1569099300103786708', es: '1569099459923677337', 'pt-BR': '1569099585551601764',
    });
    assert.equal(seedValue(entry, prod).fr, '1569099080125259776', 'French from the corrected list');
    assert.equal(new Set(Object.values(LANGUAGE_ROLE_HOME_DEFAULT)).size, Object.keys(LANGUAGE_ROLE_HOME_DEFAULT).length);
    assert.ok(validateSetting('languageRoles', LANGUAGE_ROLE_HOME_DEFAULT).ok);
    assert.deepEqual(defaultValue(entry, { NODE_ENV: 'test' }), {}, 'never in test mode');
    assert.deepEqual(neutralValue(entry), {}, 'never in another server');
    resetSettingsCacheForTests();
    try {
        const env = { NODE_ENV: 'production', MAIN_GUILD_ID: PROD_MAIN };
        assert.equal(resolveSetting(PROD_MAIN, 'languageRoles', env).de, '1569098415282069544');
        setSettingsCacheForTests(GUILD, {});
        assert.deepEqual(resolveSetting(GUILD, 'languageRoles', env), {});
    } finally {
        resetSettingsCacheForTests();
    }
});

// ── the switch ──────────────────────────────────────────────────────────

function makeGuild({ manageRoles = true, botTop = 10, positions = {}, perms = {}, managed = {} } = {}) {
    const roleObj = (code, id, i) => ({
        id, name: `Lang ${code}`, position: positions[code] ?? i + 1, managed: Boolean(managed[code]),
        permissions: { has: (p) => (perms[code] || []).includes(p) },
    });
    const roles = new Map(Object.entries(MAP).map(([code, id], i) => [id, roleObj(code, id, i)]));
    return {
        id: GUILD,
        roles: { cache: roles },
        members: { me: { permissions: { has: (p) => (p === PermissionFlagsBits.ManageRoles ? manageRoles : true) }, roles: { highest: { position: botTop } } } },
    };
}

function liveMember(...roleIds) {
    const cache = new Map(roleIds.map((id) => [id, { id }]));
    const calls = [];
    return {
        id: '300000000000000001',
        calls,
        roles: {
            cache,
            add: async (id) => { calls.push(['add', id]); cache.set(id, { id }); },
            remove: async (ids) => { calls.push(['remove', [ids].flat()]); for (const id of [ids].flat()) cache.delete(id); },
        },
    };
}

test('switch: gives the chosen role and removes the member\'s other language roles', async () => {
    const guild = makeGuild();
    const member = liveMember(R.en, R.ru, '799999999999999999');
    const result = await switchLanguageRole({ guild, member, lang: 'de', map: MAP });
    assert.deepEqual(result, { lang: 'de', added: true, removed: [R.en, R.ru] });
    assert.deepEqual(member.calls, [['add', R.de], ['remove', [R.en, R.ru]]], 'add first, then remove');
    assert.ok(member.roles.cache.has('799999999999999999'), 'other roles untouched');
});

test('switch: already the only language role → nothing changes; a stray second role is removed', async () => {
    const guild = makeGuild();
    const only = liveMember(R.de);
    assert.deepEqual(await switchLanguageRole({ guild, member: only, lang: 'de', map: MAP }), { lang: 'de', added: false, removed: [] });
    assert.deepEqual(only.calls, []);
    const two = liveMember(R.de, R.pl);
    assert.deepEqual(await switchLanguageRole({ guild, member: two, lang: 'de', map: MAP }), { lang: 'de', added: false, removed: [R.pl] });
});

test('switch: hierarchy, Manage Roles, staff permissions, managed and missing roles are refused before any change', async () => {
    const cases = [
        [{ guild: makeGuild({ manageRoles: false }) }, 'noManageRoles'],
        [{ guild: makeGuild({ positions: { de: 10 } }) }, 'hierarchy'],
        [{ guild: makeGuild({ positions: { en: 20 } }), roles: [R.en] }, 'hierarchy', 'a role to remove above the bot'],
        [{ guild: makeGuild({ perms: { de: ['ManageMessages'] } }) }, 'dangerous'],
        [{ guild: makeGuild({ managed: { de: true } }) }, 'managed'],
        [{ guild: makeGuild(), map: { ...MAP, de: '788888888888888888' } }, 'roleMissing'],
        [{ guild: makeGuild(), lang: 'fr' }, 'notOffered'],
        [{ guild: makeGuild(), lang: 'xx' }, 'unknown'],
    ];
    for (const [{ guild, roles = [], map = MAP, lang = 'de' }, code, label = code] of cases) {
        const member = liveMember(...roles);
        await assert.rejects(switchLanguageRole({ guild, member, lang, map }), (error) => error instanceof LanguageRoleError && error.code === code, label);
        assert.deepEqual(member.calls, [], `${label}: nothing changed`);
        assert.ok(botText('de').t(`language.error.${code}`, { role: 'x', language: 'y' }), `${code} has a text`);
    }
});

test('switch: a Discord error is a "failed" LanguageRoleError', async () => {
    const member = liveMember();
    member.roles.add = async () => { throw new Error('Missing Permissions'); };
    await assert.rejects(switchLanguageRole({ guild: makeGuild(), member, lang: 'de', map: MAP }), (error) => error.code === 'failed');
});

test('languageRolesFor: only set languages; a read error is "dbDown" (no role change on a guess)', () => {
    assert.deepEqual(languageRolesFor(GUILD, { resolve: () => ({ en: R.en, fr: null }) }), { en: R.en });
    assert.throws(() => languageRolesFor(GUILD, { resolve: () => { throw new Error('down'); } }), (error) => error.code === 'dbDown');
    assert.deepEqual(offeredLanguages(MAP), ['en', 'ru', 'de', 'pl', 'pt-BR']);
});

// ── command, panel, handlers ────────────────────────────────────────────

test('access: /language set is for everyone, /language panel stays Administrator-only', () => {
    assert.equal(isEveryoneCommand('language set'), true);
    assert.equal(isEveryoneCommand('language panel'), false);
    assert.equal(isEveryoneCommand('language'), false);
    assert.equal(dashboardPageFor('language panel'), 'bot-language');
    const json = languageCommand.data.toJSON();
    assert.deepEqual(json.options.map((o) => o.name), ['set', 'panel']);
    assert.ok(json.description_localizations.de, 'descriptions localized via commandLocalizations');
});

test('panel: one button per language with a role, native names, no flags, at most 5 per row', () => {
    const full = { en: R.en, ru: R.ru, de: R.de, fr: '700000000000000009', it: '700000000000000010', pl: R.pl, es: '700000000000000011', 'pt-BR': R['pt-BR'] };
    const rows = languagePanelRows(full).map((row) => row.toJSON());
    const buttons = rows.flatMap((row) => row.components);
    assert.equal(buttons.length, 8);
    assert.ok(rows.every((row) => row.components.length <= 5));
    assert.deepEqual(buttons.map((b) => b.custom_id), ['en', 'ru', 'de', 'fr', 'it', 'pl', 'es', 'pt-BR'].map((c) => `langrole:set:${c}`));
    assert.deepEqual(buttons.map((b) => b.label), ['English', 'Русский', 'Deutsch', 'Français', 'Italiano', 'Polski', 'Español', 'Português (Brasil)']);
    assert.ok(buttons.every((b) => !b.emoji && !/\p{Regional_Indicator}/u.test(b.label)), 'flag-free');
    resetSettingsCacheForTests();
    try {
        setSettingsCacheForTests(GUILD, { botLanguage: 'de' });
        const message = languagePanelMessage(GUILD, MAP);
        assert.deepEqual(message.allowedMentions, { parse: [] });
        assert.equal(message.embeds[0].toJSON().title, botText('de').t('language.panel.title'), 'a channel post: the server language');
    } finally {
        resetSettingsCacheForTests();
    }
});

test('/language set: a private select of the offered languages; none set up → a clear message', () => {
    const interaction = { locale: 'en-US', guildId: GUILD, member: memberWith(R.ru), user: { id: '300000000000000001' } };
    const reply = languageSetReply(interaction, { resolve: resolver() });
    const menu = reply.components[0].toJSON().components[0];
    assert.equal(menu.custom_id, 'langrole:pick:300000000000000001');
    assert.deepEqual(menu.options.map((o) => o.value), ['en', 'ru', 'de', 'pl', 'pt-BR']);
    assert.equal(menu.options.find((o) => o.default)?.value, 'ru');
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    const none = languageSetReply(interaction, { resolve: resolver({}) });
    assert.equal(none.components.length, 0);
    assert.match(none.embeds[0].toJSON().description, /no language roles/);
    const picker = languagePickerRow(botText('en'), MAP, { userId: '1' }).toJSON();
    assert.equal(picker.components[0].options.length, 5);
});

function fakeInteraction({ member, values = null, userId = '300000000000000001', guild = makeGuild() } = {}) {
    const calls = [];
    return {
        calls,
        locale: 'en-US', guildId: GUILD, guild, member, user: { id: userId }, values,
        deferReply: async (o) => { calls.push(['deferReply', o]); },
        deferUpdate: async () => { calls.push(['deferUpdate']); },
        editReply: async (p) => { calls.push(['editReply', p]); },
        reply: async (p) => { calls.push(['reply', p]); },
    };
}

test('panel button: ephemeral defer first, switches roles, answers in the chosen language', async () => {
    const member = liveMember(R.en);
    const interaction = fakeInteraction({ member });
    await languageButton.execute(interaction, {}, ['set', 'de'], { resolve: resolver() });
    assert.equal(interaction.calls[0][0], 'deferReply', 'acknowledged before any work');
    assert.ok(interaction.calls[0][1].flags, 'ephemeral');
    const payload = interaction.calls[1][1];
    assert.equal(payload.embeds[0].toJSON().description, botText('de').t('language.done', { language: 'Deutsch' }));
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.ok(member.roles.cache.has(R.de) && !member.roles.cache.has(R.en));
});

test('panel button: a hierarchy problem is a clear private error, nothing changed', async () => {
    const member = liveMember();
    const interaction = fakeInteraction({ member, guild: makeGuild({ positions: { de: 99 } }) });
    await languageButton.execute(interaction, {}, ['set', 'de'], { resolve: resolver() });
    assert.match(interaction.calls[1][1].embeds[0].toJSON().description, /not below my highest role/);
    assert.deepEqual(member.calls, []);
});

test('select: only the member who ran /language set; deferUpdate then the result replaces the menu', async () => {
    const other = fakeInteraction({ member: liveMember(), userId: '300000000000000002', values: ['de'] });
    await languageSelect.execute(other, {}, ['pick', '300000000000000001'], { resolve: resolver() });
    assert.equal(other.calls[0][0], 'reply');
    assert.match(other.calls[0][1].content, /belongs to someone else/);

    const member = liveMember(R.pl);
    const own = fakeInteraction({ member, values: ['pt-BR'] });
    await languageSelect.execute(own, {}, ['pick', '300000000000000001'], { resolve: resolver() });
    assert.equal(own.calls[0][0], 'deferUpdate');
    assert.deepEqual(own.calls[1][1].components, [], 'the menu is removed');
    assert.ok(member.roles.cache.has(R['pt-BR']) && !member.roles.cache.has(R.pl));
});

test('the counting notice: English unchanged, translated for a member with a language role', () => {
    assert.equal(botText('en').t('fun.count.broke', { user: '<@1>' }), '<@1> broke the count. Start again from **1**.');
    const lang = resolveBotLanguage({ guildId: GUILD, member: memberWith(R.de), purpose: 'member', resolve: resolver() });
    assert.match(botText(lang).t('fun.count.broke', { user: '<@1>' }), /^<@1> hat die Zählung/);
});
