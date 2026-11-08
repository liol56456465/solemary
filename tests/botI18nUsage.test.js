// Bot i18n sweep (Enforcement, automod, Moderation, Logging, Owner): every catalog key the code uses
// exists, and every slash command in those areas carries description localizations for all 7 other
// languages (Discord limit 100 characters), with the catalog's English equal to the builder's English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_CATALOG } from '../src/utils/botText.js';
import { DISCORD_LOCALES_BY_LANG } from '../src/utils/commandLocalizations.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const NAMESPACES = ['staff', 'automod', 'moderation', 'logging', 'owner'];
const KEY_USE = new RegExp(String.raw`\b(?:t|tp|has|descriptionLocalizations|englishDescription|describe)\(\s*['"]((?:${NAMESPACES.join('|')})\.[\w.]+)['"]`, 'g');

function jsFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...jsFiles(path));
        else if (name.endsWith('.js')) out.push(path);
    }
    return out;
}

const uses = [];
// The web dashboard and website have their own catalogs (some namespaces share names, e.g. "logging").
const OTHER_CATALOGS = /^services\/(dashboard|site|setup)\//; // setup: its own t() prefixes "setup.item."
for (const file of jsFiles(SRC).filter((f) => !OTHER_CATALOGS.test(f.slice(SRC.length)))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(KEY_USE)) uses.push({ file: file.slice(SRC.length), key: m[1], plural: m[0].startsWith('tp(') });
}

for (const ns of NAMESPACES) {
    test(`every ${ns}.* key used in the code exists in the English catalog`, () => {
        const mine = uses.filter((u) => u.key.startsWith(`${ns}.`));
        assert.ok(mine.length > 0, `no ${ns}.* keys used anywhere`);
        const problems = [];
        for (const { file, key, plural } of mine) {
            const found = BOT_CATALOG.catalogText('en', key) !== undefined || BOT_CATALOG.catalogText('en', `${key}.other`) !== undefined;
            if (!found) problems.push(`${file}: ${key} is not in en/${ns}.json`);
            else if (plural && BOT_CATALOG.catalogText('en', `${key}.other`) === undefined) problems.push(`${file}: ${key} is used as a plural but has no .other`);
        }
        assert.deepEqual(problems, []);
    });
}

// ── Slash command localizations ────────────────────────────────────────────

const COMMAND_DIRS = ['commands/Enforcement', 'commands/Moderation', 'commands/Logging', 'commands/Owner'];
const COMMAND_FILES = [
    ...COMMAND_DIRS.flatMap((d) => readdirSync(join(SRC, d)).filter((f) => f.endsWith('.js')).map((f) => join(d, f))),
    'commands/Ticket/modmail.js',
];
const LOCALES = Object.values(DISCORD_LOCALES_BY_LANG).flat();

function checkLocalized(where, english, localizations, problems) {
    if (!localizations || typeof localizations !== 'object') { problems.push(`${where}: no localizations for "${english}"`); return; }
    for (const locale of LOCALES) {
        const text = localizations[locale];
        if (!text) problems.push(`${where}: missing ${locale}`);
        else if (text.length > 100) problems.push(`${where}: ${locale} is ${text.length} characters`);
    }
}

function walkOptions(where, options = [], problems) {
    for (const option of options) {
        const here = `${where} ${option.name}`;
        checkLocalized(here, option.description, option.description_localizations, problems);
        for (const choice of option.choices || []) checkLocalized(`${here} choice ${choice.value}`, choice.name, choice.name_localizations, problems);
        walkOptions(here, option.options, problems);
    }
}

test('every slash command in Enforcement, Moderation, Logging, Owner and /modmail is localized in 8 languages', async () => {
    const problems = [];
    for (const file of COMMAND_FILES) {
        const mod = (await import(new URL(`../src/${file}`, import.meta.url))).default;
        const data = mod?.data;
        if (!data || typeof data.toJSON !== 'function') continue;
        const json = data.toJSON();
        if (json.type && json.type !== 1) {
            // Context menu commands have no description; their names stay as they are.
            continue;
        }
        checkLocalized(`/${json.name}`, json.description, json.description_localizations, problems);
        walkOptions(`/${json.name}`, json.options, problems);
    }
    assert.deepEqual(problems, []);
});
