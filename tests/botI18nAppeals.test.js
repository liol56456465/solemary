// Bot i18n, part "appeals": /appeals, /staff, /setappeal, /modmail, the appeal dossier, the appeal
// panels, the mass-action guard and the modmail staff notices (namespace staff → appeals, staff,
// setappeal, modmail, dossier). Keys used exist, every language has them with the same
// placeholders and plural forms, the English output is unchanged, and the dossier fits Discord's
// embed limits in every language with the longest possible answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANG_CODES, PLURAL_CATEGORIES, placeholdersOf } from '../src/services/site/i18n.js';
import { BOT_CATALOG, botText } from '../src/utils/botText.js';
import { DISCORD_LOCALES_BY_LANG } from '../src/utils/commandLocalizations.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { buildCaseDossier, caseTypeIn, ladderStageShortIn, liftNoteText } from '../src/services/enforcement/appealService.js';
import { mainAppealPanel, serverAppealPanel, supportAppealPanel } from '../src/services/enforcement/appealPanelService.js';
import { ladderStageShort } from '../src/services/enforcement/format.js';
import { decisionResultEmbed } from '../src/handlers/appealsHandler.js';
import { pendingAppealsEmbed } from '../src/commands/Enforcement/appeals.js';
import { restoreRefusal } from '../src/commands/Enforcement/staff.js';
import appealsCommand from '../src/commands/Enforcement/appeals.js';
import staffCommand from '../src/commands/Enforcement/staff.js';
import setappealCommand from '../src/commands/Enforcement/setappeal.js';
import modmailCommand from '../src/commands/Ticket/modmail.js';

const SRC = new URL('../src/', import.meta.url);
const MY_FILES = [
    'commands/Enforcement/appeals.js', 'commands/Enforcement/staff.js', 'commands/Enforcement/setappeal.js',
    'commands/Ticket/modmail.js', 'handlers/modmailButtons.js', 'handlers/appealsHandler.js', 'services/modmailService.js',
    'services/enforcement/appealService.js', 'services/enforcement/appealPanelService.js',
    'services/enforcement/massActionGuard.js', 'services/enforcement/staleAppealService.js',
];
const MY_PREFIX = /^staff\.(appeals|staff|setappeal|modmail|dossier)\./;
const KEY_USE = /\b(t|tp|descriptionLocalizations)\(\s*'(staff\.(?:appeals|staff|setappeal|modmail|dossier)\.[\w.]+)'/g;
const OTHERS = LANG_CODES.filter((c) => c !== 'en');
const isPluralLeaf = (key) => PLURAL_CATEGORIES.includes(key.split('.').pop());
const pluralBase = (key) => key.split('.').slice(0, -1).join('.');

test('every staff.(appeals|staff|setappeal|modmail|dossier) key my files use exists in English (plurals with .other)', () => {
    let count = 0;
    for (const file of MY_FILES) {
        const text = readFileSync(new URL(file, SRC), 'utf8');
        for (const [, fn, key] of text.matchAll(KEY_USE)) {
            count += 1;
            if (fn === 'tp') assert.ok(BOT_CATALOG.catalogText('en', `${key}.other`) !== undefined, `${file}: plural ${key}.other`);
            else assert.ok(BOT_CATALOG.catalogText('en', key) !== undefined, `${file}: ${key}`);
        }
    }
    assert.ok(count > 250, `keys used: ${count}`);
});

test('my keys: every language has them, same placeholders, every plural form, nothing extra', () => {
    const en = BOT_CATALOG.catalogKeys('en').filter((k) => MY_PREFIX.test(k));
    const singles = en.filter((k) => !(isPluralLeaf(k) && BOT_CATALOG.catalogText('en', `${pluralBase(k)}.other`) !== undefined));
    const plurals = [...new Set(en.filter((k) => isPluralLeaf(k)).map(pluralBase))].filter((b) => BOT_CATALOG.catalogText('en', `${b}.other`) !== undefined);
    for (const lang of OTHERS) {
        for (const key of singles) {
            const text = BOT_CATALOG.catalogText(lang, key);
            assert.ok(typeof text === 'string' && text.length > 0, `${lang}: missing ${key}`);
            assert.deepEqual(placeholdersOf(text), placeholdersOf(BOT_CATALOG.catalogText('en', key)), `${lang}: placeholders of ${key}`);
        }
        for (const base of plurals) {
            for (const category of new Intl.PluralRules(lang).resolvedOptions().pluralCategories) {
                const text = BOT_CATALOG.catalogText(lang, `${base}.${category}`);
                assert.ok(text !== undefined, `${lang}: missing ${base}.${category}`);
                assert.deepEqual(placeholdersOf(text), placeholdersOf(BOT_CATALOG.catalogText('en', `${base}.other`)), `${lang}: ${base}.${category}`);
            }
        }
        for (const key of BOT_CATALOG.catalogKeys(lang).filter((k) => MY_PREFIX.test(k))) {
            const known = BOT_CATALOG.catalogText('en', key) !== undefined || (isPluralLeaf(key) && BOT_CATALOG.catalogText('en', `${pluralBase(key)}.other`) !== undefined);
            assert.ok(known, `${lang}: extra key ${key}`);
        }
    }
});

test('/appeals, /staff, /setappeal, /modmail: descriptions, options and choices localized (≤100) and English = catalog', () => {
    const locales = Object.values(DISCORD_LOCALES_BY_LANG).flat();
    const problems = [];
    const check = (where, english, map) => {
        for (const locale of locales) {
            const text = map?.[locale];
            if (!text) problems.push(`${where}: no ${locale}`);
            else if (text.length > 100) problems.push(`${where}: ${locale} ${text.length}`);
        }
        if (!english) problems.push(`${where}: no English`);
    };
    const walk = (where, options = []) => {
        for (const option of options) {
            check(`${where} ${option.name}`, option.description, option.description_localizations);
            for (const choice of option.choices || []) check(`${where} ${option.name}=${choice.value}`, choice.name, choice.name_localizations);
            walk(`${where} ${option.name}`, option.options);
        }
    };
    for (const command of [appealsCommand, staffCommand, setappealCommand, modmailCommand]) {
        const json = command.data.toJSON();
        check(`/${json.name}`, json.description, json.description_localizations);
        walk(`/${json.name}`, json.options);
    }
    assert.deepEqual(problems, []);
    // The catalog English is the builder's English.
    const en = botText('en');
    assert.equal(appealsCommand.data.toJSON().description, en.t('staff.appeals.cmd.description'));
    assert.equal(staffCommand.data.toJSON().description, en.t('staff.staff.cmd.description'));
    assert.equal(setappealCommand.data.toJSON().description, en.t('staff.setappeal.cmd.description'));
    assert.equal(modmailCommand.data.toJSON().description, en.t('staff.modmail.cmd.description'));
    for (const option of staffCommand.data.toJSON().options) {
        const key = { warn: 'warn', warnings: 'warnings', activity: 'activity', stats: 'stats', coverage: 'coverage', restore: 'restore' }[option.name];
        assert.equal(option.description, en.t(`staff.staff.cmd.${key}`), option.name);
    }
});

// ── English unchanged ─────────────────────────────────────────────────────

const OLD_MAIN_PANEL = [
    '**Muted or warned?** Press **Appeal** and fill in:',
    '1. Why it should be lifted',
    '2. Your case code, from the DM you got',
    '3. More info, if you want to add anything',
    '',
    'The administrators review your appeal and you get the decision by DM. Press **My appeals** any time to check where yours stand, or **My record** to see your warnings and what a next warning would do.',
    '',
    '-# Banned? Appeal in the Mewvo Support server instead. The link is in your ban DM.',
].join('\n');

test('English unchanged: appeal panels, buttons, titles', () => {
    const main = mainAppealPanel();
    assert.equal(main.embeds[0].data.description, OLD_MAIN_PANEL);
    assert.equal(main.embeds[0].data.title, `${enforcementConfig.serverName} appeals`);
    assert.deepEqual(main.components[0].components.map((b) => b.data.label), ['Appeal', 'My appeals', 'My record']);
    const support = supportAppealPanel().embeds[0].data.description;
    assert.ok(support.startsWith('**Appeal**: banned, kicked, muted or warned in Mewvo? Press **Appeal** and fill in:\n1. Why it should be lifted'));
    assert.ok(support.endsWith('\n\n-# Bans and mutes can be appealed while active; warnings and kicks within 30 days.'));
    const server = serverAppealPanel('Cats');
    assert.equal(server.embeds[0].data.title, 'Cats appeals');
    assert.equal(server.components[0].components[3].data.label, 'Report staff');
    assert.equal(serverAppealPanel('').embeds[0].data.title, 'Server appeals');
    // Translated: the same structure, other words.
    const de = mainAppealPanel({ lang: 'de' });
    assert.notEqual(de.embeds[0].data.description, OLD_MAIN_PANEL);
    assert.equal(de.components[0].components[0].data.custom_id, 'appeal:open');
});

test('English unchanged: /appeals pending list and decision result; ladder stage and case types', () => {
    const tr = botText('en');
    const pending = pendingAppealsEmbed([
        { case_code: 'abc2345', type: 'ban', is_test: true, username: 'cat', user_id: '1', created_at: new Date(Date.UTC(2026, 9, 1)), channel_id: '22' },
    ], tr);
    assert.equal(pending.data.title, 'Pending appeals (1)');
    assert.equal(pending.data.description, '`abc2345` **ban** (test) cat (`1`), filed <t:1790812800:F> in <#22>\n\nSee a case with `/appeals code:<code>`, decide with `decision:accept|deny`.');
    assert.equal(pendingAppealsEmbed([], tr).data.description, 'There are no pending appeals.');
    const result = decisionResultEmbed({ caseCode: 'abc2345', decision: 'accept', result: { record: { name: 'n' }, dmDelivered: false, notes: [liftNoteText({ key: 'unbanned' })], ownerOverride: true } }, tr);
    assert.ok(String(result.data.title).includes('Appeal accepted'), result.data.title);
    assert.equal(result.data.description, '`abc2345` · n\nDM to the user: **not delivered**.\nThe user was unbanned.\nYou issued this punishment: decided as a bot owner, logged as an owner override.');
    for (const level of [0, 1, 2, 3]) assert.equal(ladderStageShortIn(level), ladderStageShort(level));
    assert.equal(ladderStageShortIn(1, { lang: 'de' }), '1 von 3 (7-Tage-Bann)');
    assert.equal(caseTypeIn('mute'), 'mute');
    assert.equal(caseTypeIn('mute', { lang: 'ru' }), 'мут');
    assert.equal(caseTypeIn('other', { lang: 'ru' }), 'other');
    assert.equal(liftNoteText({ key: 'triggerRemoved', params: { code: 'k7m2qx' } }), 'The warning that triggered this automatic ban (`k7m2qx`) was removed too.');
});

test('English unchanged: /staff restore refusals', () => {
    const interaction = { guild: { ownerId: '9' }, guildId: '5', user: { id: '1' }, member: { roles: { highest: { position: 3 } } } };
    assert.equal(restoreRefusal({ interaction, targetId: '1', roles: [] }), 'You cannot restore yourself. Ask the server owner or another administrator.');
    assert.equal(restoreRefusal({ interaction, targetId: '2', roles: [{ name: 'Mod', position: 5 }] }), 'Some saved roles are at or above your highest role (Mod). Ask the server owner to restore them.');
    assert.equal(restoreRefusal({ interaction, targetId: '2', roles: [{ name: 'Mod', position: 1 }] }), null);
    assert.match(restoreRefusal({ interaction, targetId: '1', roles: [], lang: 'de' }), /^Du kannst dich nicht selbst/);
});

// ── The dossier: embed limits in every language, longest answers ─────────

const GUILD = '1700000000000000001';
process.env.MAIN_GUILD_ID ??= GUILD;
const long = (n, c = 'x') => c.repeat(n);
const record = {
    id: 1, guild_id: GUILD, case_code: 'abc2345', type: 'ban', name: long(100, 'n'), status: 'appeal_pending',
    target_user_id: '1700000000000000500', target_username: long(32, 'u'), moderator_id: '1700000000000000200', moderator_username: long(32, 'm'),
    is_auto: true, is_test: true, reason: long(1000, 'r'), created_at: new Date('2026-10-01T00:00:00Z'), expires_at: new Date('2026-11-01T00:00:00Z'),
    duration_ms: 31 * 24 * 3600 * 1000 + 3600 * 1000, appeal_deadline: new Date('2027-04-01T00:00:00Z'), unappealable: true,
    revoked_at: new Date('2026-10-05T00:00:00Z'), revoke_reason: long(200, 'v'), dm_delivered: false, ladder_level_after: 2,
};
const appealRow = (i, status = 'denied') => ({
    id: i, case_code: 'abc2345', kind: 'appeal', status, username: long(32, 'a'), created_at: new Date('2026-10-02T00:00:00Z'),
    decided_at: status === 'pending' ? null : new Date('2026-10-03T00:00:00Z'), decided_by_username: long(32, 'd'), note: long(500, 'o'), channel_id: '1700000000000000900',
    // The appeal form's longest answers (1000 each) plus the old form's two.
    body: { punished: long(1000, 'p'), reason: long(1000, 'w'), didIt: 'partly', moreInfo: long(1000, 'i') },
});

function installDossierPool() {
    const answer = (text) => {
        if (/SELECT \* FROM \S*mod_appeals\S* WHERE case_code = \$1 AND kind = 'appeal' ORDER BY/.test(text)) {
            return { rows: [appealRow(1, 'pending'), ...Array.from({ length: 9 }, (_, i) => appealRow(i + 2))] };
        }
        if (/DISTINCT ON \(case_code\)/.test(text)) return { rows: Array.from({ length: 16 }, (_, i) => ({ case_code: `c${i}x234`, status: 'denied' })) };
        if (/COUNT\(\*\)::int AS count FROM \S*mod_appeals/.test(text)) return { rows: [{ count: 12345 }] };
        if (/COUNT\(\*\) OVER\(\) AS total_count/.test(text)) {
            return { rows: Array.from({ length: 16 }, (_, i) => ({ ...record, case_code: `c${i}x234`, type: i % 2 ? 'mute' : 'warn', status: 'revoked', reason: long(300, 'q'), total_count: 999 })) };
        }
        if (/FROM \S*mod_ladder/.test(text)) return { rows: [{ level: 3, warns_since_level: 2 }] };
        return { rows: [], rowCount: 0 };
    };
    const saved = { pool: pgDb.pool, connected: pgDb.isConnected };
    pgDb.pool = { query: async (text) => answer(String(text)), connect: async () => ({ query: async (text) => answer(String(text)), release() {} }) };
    pgDb.isConnected = true;
    return () => { pgDb.pool = saved.pool; pgDb.isConnected = saved.connected; };
}

const client = { user: { id: '1700000000000000100' }, guilds: { cache: new Map() }, channels: { cache: new Map() } };

test('the appeal dossier fits Discord limits in every language with the longest answers (title 256, description 4096, field 1024)', async () => {
    const restore = installDossierPool();
    try {
        const totals = {};
        for (const lang of LANG_CODES) {
            const embeds = (await buildCaseDossier(record, { client, lang })).map((e) => e.data || e);
            assert.equal(embeds.length, 3, lang);
            let total = 0;
            for (const embed of embeds) {
                assert.ok((embed.title || '').length <= 256, `${lang} title ${embed.title?.length}`);
                assert.ok((embed.description || '').length <= 4096, `${lang} description ${embed.description?.length}`);
                assert.ok((embed.fields || []).length <= 25, `${lang} fields`);
                for (const field of embed.fields || []) {
                    assert.ok(field.name.length <= 256 && field.name.length > 0, `${lang} field name ${field.name}`);
                    assert.ok(field.value.length <= 1024 && field.value.length > 0, `${lang} field ${field.name}: ${field.value.length}`);
                }
                total += (embed.title || '').length + (embed.description || '').length
                    + (embed.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0) + (embed.footer?.text || '').length;
            }
            totals[lang] = total;
        }
        // The message's three embeds together: English is the baseline; a translation adds at most
        // a few hundred characters of labels (the user text is the same and truncated the same way).
        for (const lang of LANG_CODES) assert.ok(totals[lang] - totals.en < 600, `${lang}: ${totals[lang]} vs en ${totals.en}`);
        // Translated labels really are used.
        const de = (await buildCaseDossier(record, { client, lang: 'de' })).map((e) => e.data || e);
        assert.ok(de[0].description.includes('**Fallcode:** `abc2345`'));
        assert.equal(de[2].title, 'Verlauf');
        const en = (await buildCaseDossier(record, { client })).map((e) => e.data || e);
        assert.ok(en[0].description.includes('**Type:** ban (automatic, warn ladder)'));
        assert.ok(en[0].description.includes('**Warning stage after:** 2 of 3 (30-day ban)'));
        assert.equal(en[1].title, 'Appeal (pending)');
        assert.deepEqual(en[1].fields.map((f) => f.name), ['Why did you get punished?', 'Why should it be lifted?', 'Did you do it?', 'More info']);
        assert.equal(en[1].fields[2].value, 'Partly');
    } finally {
        restore();
    }
});
