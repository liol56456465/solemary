// The bot's own messages in 8 languages (utils/botText.js, src/content/bot/): catalog parity,
// Discord locale mapping, the server-language setting and its English fallback, translated DMs
// with their placeholders intact, and English output unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DASHBOARD_CATALOG, LANG_CODES, PLURAL_CATEGORIES, placeholdersOf } from '../src/services/site/i18n.js';
import {
    BOT_CATALOG, botText, languageFromLocale, resetBotLanguageLogForTests, resolveBotLanguage, serverLanguage, textForGuild, textForInteraction,
} from '../src/utils/botText.js';
import { BOT_LANGUAGE_CODES, getSettingEntry, validateSetting } from '../src/services/settings/settingsRegistry.js';
import { resetSettingsCacheForTests, setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';
import {
    appealAcceptedDm, appealDeniedDm, banDm, banEndedDm, caseVoidedDm, durationIn, kickDm, muteDm, muteEndedDm, warnDm,
} from '../src/services/enforcement/dmTemplates.js';
import { formatDuration } from '../src/services/enforcement/format.js';
import { ErrorTypes, createError, getUserMessage } from '../src/utils/errorHandler.js';
import { USER_ERROR_TITLES, buildUserErrorEmbed } from '../src/utils/embeds.js';
import { getAdminRequiredMessage } from '../src/utils/commandGate.js';
import { logger } from '../src/utils/logger.js';

const OTHERS = LANG_CODES.filter((c) => c !== 'en');
const ROOT = new URL('../src/content/bot/', import.meta.url);
const NAMESPACES = readdirSync(new URL('en/', ROOT)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const OTHER_GUILD = '300000000000000003';

// ── The catalog ────────────────────────────────────────────────────────────

const pluralBase = (key) => key.replace(/\.(zero|one|two|few|many|other)$/, '');
test('every bot key exists in English and all 7 languages, with the same placeholders and every plural form', () => {
    const en = BOT_CATALOG.catalogKeys('en');
    assert.ok(en.length > 80, `English catalog: ${en.length} keys`);
    const singles = en.filter((k) => !/\.(zero|one|two|few|many|other)$/.test(k) || !BOT_CATALOG.catalogText('en', `${pluralBase(k)}.other`));
    for (const lang of OTHERS) {
        const keys = new Set(BOT_CATALOG.catalogKeys(lang));
        for (const key of singles) {
            assert.ok(keys.has(key), `${lang}: missing ${key}`);
            assert.deepEqual(placeholdersOf(BOT_CATALOG.catalogText(lang, key)), placeholdersOf(BOT_CATALOG.catalogText('en', key)), `${lang}: placeholders of ${key}`);
        }
        const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
        for (const base of new Set(en.filter((k) => k !== pluralBase(k) && BOT_CATALOG.catalogText('en', `${pluralBase(k)}.other`)).map(pluralBase))) {
            const want = placeholdersOf(BOT_CATALOG.catalogText('en', `${base}.other`));
            for (const category of categories) {
                const text = BOT_CATALOG.catalogText(lang, `${base}.${category}`);
                assert.ok(text !== undefined, `${lang}: missing ${base}.${category}`);
                assert.deepEqual(placeholdersOf(text), want, `${lang}: placeholders of ${base}.${category}`);
            }
        }
        for (const key of keys) {
            const known = BOT_CATALOG.catalogText('en', key) !== undefined
                || (PLURAL_CATEGORIES.includes(key.split('.').pop()) && BOT_CATALOG.catalogText('en', `${pluralBase(key)}.other`) !== undefined);
            assert.ok(known, `${lang}: unknown key ${key}`);
        }
    }
});

test('the bot catalog files are the same namespaces in every language', () => {
    for (const lang of OTHERS) {
        const files = readdirSync(new URL(`${lang}/`, ROOT)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
        assert.deepEqual(files, NAMESPACES, lang);
    }
});

test('Discord markup in a translation is kept as typed: bold, line breaks, channel mentions', () => {
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        assert.match(tr.t('enforcement.dm.ban.title', { server: 'S' }), /^\*\*.+\*\*$/, `${lang} bold title`);
        assert.ok(tr.t('enforcement.dm.appealDenied', { invite: 'https://discord.gg/x' }).includes('\nhttps://discord.gg/x'), `${lang} line break + invite`);
        assert.ok(tr.t('errors.access.adminChannel', { channelId: '123' }).endsWith('<#123>'), `${lang} channel mention`);
        assert.ok(tr.t('enforcement.dm.privacy', { url: 'https://x/privacy' }).startsWith('-# '), `${lang} small text`);
    }
});

// ── Which language ─────────────────────────────────────────────────────────

test('Discord locales map onto the 8 languages; anything else is English', () => {
    const map = {
        'en-US': 'en', 'en-GB': 'en', de: 'de', ru: 'ru', fr: 'fr', it: 'it', pl: 'pl', 'es-ES': 'es', 'es-419': 'es', 'pt-BR': 'pt-BR',
    };
    for (const [locale, lang] of Object.entries(map)) assert.equal(languageFromLocale(locale), lang, locale);
    for (const unknown of ['ja', 'zh-CN', 'lt', 'uk', '', null, undefined, 42, '<x>']) assert.equal(languageFromLocale(unknown), 'en', String(unknown));
});

test('mixed rule: a reply follows the user\'s Discord language; a DM or public post the server\'s', () => {
    const interaction = { locale: 'de', guildId: OTHER_GUILD, user: { id: '1' } };
    const resolve = () => 'fr';
    assert.equal(resolveBotLanguage({ interaction, purpose: 'reply', resolve }), 'de');
    assert.equal(resolveBotLanguage({ interaction, purpose: 'dm', resolve }), 'fr', '/test previews use this: the member\'s language, not the invoker\'s');
    assert.equal(resolveBotLanguage({ interaction, purpose: 'public', resolve }), 'fr');
    assert.equal(resolveBotLanguage({ interaction: { locale: 'ja' }, purpose: 'reply' }), 'en');
    assert.equal(resolveBotLanguage({ guildId: null, purpose: 'dm' }), 'en', 'no server → English');
    assert.equal(textForInteraction({ locale: 'pl' }).lang, 'pl');
});

test('server language: the stored setting; English when nothing is stored or the value is unknown', () => {
    resetSettingsCacheForTests();
    try {
        setSettingsCacheForTests(OTHER_GUILD, { botLanguage: 'pl' });
        assert.equal(serverLanguage(OTHER_GUILD), 'pl');
        assert.equal(textForGuild(OTHER_GUILD).lang, 'pl');
        setSettingsCacheForTests(OTHER_GUILD, {});
        assert.equal(serverLanguage(OTHER_GUILD), 'en', 'nothing stored');
        assert.equal(serverLanguage(OTHER_GUILD, { resolve: () => 'xx' }), 'en', 'a value that is not one of the 8');
    } finally {
        resetSettingsCacheForTests();
    }
});

test('server language: a database error never breaks a DM or a reply: English, logged once', () => {
    resetSettingsCacheForTests();
    resetBotLanguageLogForTests();
    const warnings = [];
    const realWarn = logger.warn;
    logger.warn = (message) => { warnings.push(String(message)); };
    try {
        // Real path: a non-home server whose settings were never read (database down at boot) throws
        // SettingsUnavailableError in resolveSetting; the language falls back to English.
        assert.equal(serverLanguage(OTHER_GUILD), 'en');
        assert.equal(serverLanguage(OTHER_GUILD, { resolve: () => { throw new Error('database not responding'); } }), 'en');
        assert.equal(resolveBotLanguage({ guildId: OTHER_GUILD, purpose: 'dm' }), 'en');
        assert.ok(banDm(record(), { lang: resolveBotLanguage({ guildId: OTHER_GUILD, purpose: 'dm' }) }).includes('**Banned from'), 'the DM still renders');
        assert.equal(warnings.filter((w) => w.includes('Bot language')).length, 1, 'logged once, not per message');
    } finally {
        logger.warn = realWarn;
        resetBotLanguageLogForTests();
        resetSettingsCacheForTests();
    }
});

test('the botLanguage setting accepts exactly the 8 languages, default English', () => {
    assert.deepEqual([...BOT_LANGUAGE_CODES], [...LANG_CODES]);
    const entry = getSettingEntry('botLanguage');
    assert.equal(entry.fallback, 'en');
    for (const code of LANG_CODES) assert.equal(validateSetting('botLanguage', code).ok, true, code);
    for (const bad of ['xx', 'EN', 'pt', '', null]) assert.equal(validateSetting('botLanguage', bad).ok, false, String(bad));
});

// ── DMs ────────────────────────────────────────────────────────────────────

function record(over = {}) {
    return {
        moderator_username: 'Mod<One>', reason: 'Spam {not a param}', created_at: new Date(Date.UTC(2026, 10, 1)), case_code: 'abc23k',
        expires_at: new Date(Date.UTC(2026, 10, 8)), duration_ms: 7 * 24 * 3600 * 1000, type: 'ban', ...over,
    };
}

test('a ban DM in German: translated lines, placeholders filled, case code and <t:…> stamps untouched', () => {
    const dm = banDm(record(), { lang: 'de' });
    assert.ok(dm.includes('**Von '), dm);
    assert.ok(dm.includes('gebannt**'));
    assert.ok(dm.includes('Von: Mod<One>'), 'moderator name as given');
    assert.ok(dm.includes('Grund: Spam {not a param}'), 'a {…} in user text is not treated as a placeholder');
    assert.ok(dm.includes('Fallcode: abc23k'));
    assert.match(dm, /Dauer: 7 Tage, endet <t:\d+:F> \(<t:\d+:R>\)/);
    assert.match(dm, /Datum: <t:\d+:F>/);
    assert.ok(!/\{[a-zA-Z]+\}/.test(dm.replace('{not a param}', '')), 'no placeholder left');
    assert.ok(!dm.includes('Banned') && !dm.includes('Case code'), 'no English line left');
});

test('every translated DM renders in every language without a missing key or placeholder', () => {
    for (const lang of LANG_CODES) {
        const dms = [
            banDm(record(), { lang }), banDm(record({ expires_at: null, unappealable: true, is_auto: true }), { lang }),
            banDm(record({ is_auto: true, ladder_level_after: 3, appeal_deadline: new Date() }), { lang }),
            kickDm(record(), 'https://discord.gg/one', { lang }), kickDm(record(), null, { lang }), muteDm(record({ duration_ms: 90 * 60000 }), { lang }),
            warnDm(record(), 2, { lang }), appealAcceptedDm('Admin', null, { lang }), appealDeniedDm({ lang }),
            banEndedDm(record(), null, { lang }), banEndedDm(record(), 'https://discord.gg/b', { early: true, lang }),
            muteEndedDm(record(), { lang }), muteEndedDm(null, { early: true, lang }),
            caseVoidedDm(record({ type: 'warn' }), 'mistake', null, { lang }), caseVoidedDm(record({ type: 'note' }), 'x', 'https://discord.gg/c', { lang }),
        ];
        for (const dm of dms) {
            assert.ok(dm.length > 10 && dm.length <= 2000, `${lang}: ${dm.slice(0, 40)}`);
            assert.ok(!/\{[a-zA-Z]+\}/.test(dm.replace(/\{not a param\}/g, '')), `${lang}: placeholder left in ${dm}`);
            assert.ok(!dm.includes('undefined'), `${lang}: ${dm}`);
        }
    }
});

test('English DMs are byte-for-byte the old layout (explicit en and no language are the same)', () => {
    const r = record({ reason: 'Spam' });
    const ban = [
        '**Appeal here:** https://discord.gg/7Ckv9Bt577',
        '**Banned from Mewvo**',
        'By: Mod<One>',
        'Reason: Spam',
        `Date: <t:${Date.UTC(2026, 10, 1) / 1000}:F>`,
        `Duration: 7 days, ends <t:${Date.UTC(2026, 10, 8) / 1000}:F> (<t:${Date.UTC(2026, 10, 8) / 1000}:R>)`,
        'Case code: abc23k',
    ].join('\n');
    const env = { ...process.env };
    delete process.env.PUBLIC_URL;
    delete process.env.MEMBER_PORTAL_ENABLED;
    try {
        assert.equal(banDm(r), ban);
        assert.equal(banDm(r, { lang: 'en' }), ban);
        assert.equal(appealDeniedDm(), '**Appeal denied.** If you think this is a mistake, appeal again here:\nhttps://discord.gg/7Ckv9Bt577');
        assert.equal(warnDm(r, 1).split('\n')[1], '**Warning 1 of 3 in Mewvo**');
        assert.equal(caseVoidedDm(r, 'oops').split('\n')[0], '**A ban on your record in Mewvo was removed**');
        assert.equal(caseVoidedDm({ ...r, type: 'note' }, 'oops').split('\n')[0], '**A note on your record in Mewvo was removed**');
        assert.equal(kickDm(r, null).split('\n').at(-1), 'Rejoin: ask a staff member for an invite');
    } finally {
        Object.assign(process.env, env);
    }
});

test('durations: English is exactly formatDuration; other languages use their plural forms', () => {
    const M = 60000;
    for (const ms of [null, 0, 30000, M, 2 * M, 61 * M, 3600000, 90 * M, 24 * 3600000, 36 * 3600000, 7 * 86400000, 30 * 86400000, 45 * 86400000, 400 * 86400000 + 5 * M]) {
        assert.equal(durationIn(ms, 'en'), formatDuration(ms), String(ms));
    }
    assert.equal(durationIn(2 * 86400000, 'ru'), '2 дня');
    assert.equal(durationIn(5 * 86400000, 'ru'), '5 дней');
    assert.equal(durationIn(21 * 86400000, 'ru'), '21 день');
    assert.equal(durationIn(22 * 3600000, 'pl'), '22 godziny');
    assert.equal(durationIn(25 * 60000, 'pl'), '25 minut');
    assert.equal(durationIn(86400000 + 3600000, 'de'), '1 Tag 1 Stunde');
    assert.equal(durationIn(null, 'fr'), 'Définitif');
});

// ── Error replies ──────────────────────────────────────────────────────────

test('error texts: English catalog = the code\'s English (so English stays identical); other languages translate', () => {
    const SUBTYPES = {
        validation: ['missing_required', 'invalid_format'], permission: ['user_permission', 'bot_permission'],
        configuration: ['missing_config', 'invalid_config'], database: ['connection_failed', 'timeout'], network: ['timeout', 'unreachable'],
        discord_api: ['rate_limit', 'forbidden'], user_input: ['invalid_user', 'invalid_channel'], rate_limit: ['command_cooldown', 'global_rate_limit'],
        unknown: ['unexpected', 'warn_failed', 'kick_failed', 'ban_failed', 'unban_failed', 'timeout_failed', 'untimeout_failed'],
    };
    const en = botText('en');
    for (const type of Object.values(ErrorTypes)) {
        const error = createError('x', type);
        assert.equal(getUserMessage(error), en.t(`errors.message.${type}.default`), `${type} default`);
        assert.equal(getUserMessage(error, { lang: 'en' }), getUserMessage(error), `${type} en`);
        assert.equal(USER_ERROR_TITLES[type], en.t(`errors.title.${type}`), `${type} title`);
        assert.equal(buildUserErrorEmbed(type, 'x', { lang: 'en' }).data.title, buildUserErrorEmbed(type, 'x').data.title);
        for (const subtype of SUBTYPES[type]) assert.equal(getUserMessage(error, { subtype }), en.t(`errors.message.${type}.${subtype}`), `${type}.${subtype}`);
        for (const lang of OTHERS) {
            assert.notEqual(getUserMessage(error, { lang }), getUserMessage(error), `${lang} ${type} translated`);
            assert.notEqual(buildUserErrorEmbed(type, 'x', { lang }).data.title, USER_ERROR_TITLES[type], `${lang} ${type} title translated`);
        }
    }
    assert.equal(getUserMessage(createError('x', 'unknown'), { subtype: 'ban_failed', lang: 'de' }), botText('de').t('errors.message.unknown.ban_failed'));
    // A custom message is shown as written.
    assert.equal(getUserMessage(createError('x', 'validation', 'Pick a channel.'), { lang: 'ru' }), 'Pick a channel.');
    // A title override wins in any language.
    assert.equal(buildUserErrorEmbed('database', 'x', { lang: 'de', titleOverride: 'Own' }).data.title, 'Own');
});

test('the Administrator refusal: English unchanged, other languages keep the channel mention', () => {
    const stored = () => '400000000000000004';
    assert.equal(getAdminRequiredMessage(OTHER_GUILD, { stored }), 'You need the Administrator role to use this command. Request a mod/admin role here: <#400000000000000004>');
    assert.equal(getAdminRequiredMessage(OTHER_GUILD, { stored: () => null }), 'You need the Administrator role to use this command. Ask an admin of this server if you need access.');
    const ru = getAdminRequiredMessage(OTHER_GUILD, { stored, lang: 'ru' });
    assert.ok(ru.startsWith('Для этой команды нужна роль администратора.'), ru);
    assert.ok(ru.endsWith('<#400000000000000004>'));
});

// ── The dashboard page's text ──────────────────────────────────────────────

test('Bot language page: every catalog key it names exists in all 8 languages, and its sidebar label too', () => {
    const code = readFileSync(new URL('../src/services/dashboard/modules/botLanguage.js', import.meta.url), 'utf8');
    const keys = [...code.matchAll(/['`](botLanguage\.[A-Za-z0-9_.-]+)['`]/g)].map((m) => m[1]);
    assert.ok(keys.length >= 8, `${keys.length} keys`);
    for (const lang of LANG_CODES) {
        for (const key of [...keys, 'frame.nav.items.bot-language', 'botLanguage.page.help']) {
            assert.ok(DASHBOARD_CATALOG.catalogText(lang, key) !== undefined, `${lang}: ${key}`);
        }
    }
});
