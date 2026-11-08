// Bot i18n for Ticket, Welcome, Reaction roles, Join to Create and Verification
// (src/content/bot/<lang>/{ticket,welcome,reactionroles,jointocreate,verification}.json).
// Per namespace: every key the code names exists in all 8 languages (plural keys: every form),
// every slash-command description localization fits Discord's 100 characters, and the English
// output is the text the code had before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { BOT_CATALOG, botText } from '../src/utils/botText.js';
import { DISCORD_LOCALES_BY_LANG as DISCORD_LOCALES, descriptionLocalizations as localizations } from '../src/utils/commandLocalizations.js';

const NAMESPACES = ['ticket', 'welcome', 'reactionroles', 'jointocreate', 'verification'];
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function jsFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...jsFiles(path));
        else if (name.endsWith('.js')) out.push(path);
    }
    return out;
}

const SOURCES = jsFiles(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter(({ path, text }) => !path.endsWith('commandLocalizations.js') && /botText\.js|commandLocalizations\.js/.test(text));

/** Keys of one namespace named in code: t('ns.a.b'), tp('ns.a', n), localizations('ns.a'), or a 'ns.a.b' literal. */
function keysUsed(ns) {
    const used = new Map(); // key → { plural, files }
    const add = (key, plural, path) => {
        const entry = used.get(key) || { plural: false, description: false, files: new Set() };
        entry.plural ||= plural;
        entry.files.add(path.slice(SRC.length));
        used.set(key, entry);
    };
    const call = new RegExp(`\\b(t|tp|has|localizations|descriptionLocalizations|describe)\\(\\s*(['"\`])(${ns}\\.[A-Za-z0-9_.]+)\\2`, 'g');
    const literal = new RegExp(`(['"\`])(${ns}\\.[A-Za-z0-9_]+\\.[A-Za-z0-9_.]+)\\1`, 'g');
    for (const { path, text } of SOURCES) {
        for (const m of text.matchAll(call)) add(m[3], m[1] === 'tp', path);
        for (const m of text.matchAll(literal)) {
            if (/\.(js|json|png|jpg)$/.test(m[2])) continue;
            add(m[2], false, path);
        }
    }
    return used;
}

const has = (lang, key) => BOT_CATALOG.catalogText(lang, key) !== undefined;

for (const ns of NAMESPACES) {
    test(`${ns}: every catalog key the code names exists in all 8 languages`, () => {
        const used = keysUsed(ns);
        assert.ok(used.size > 0, `${ns}: no keys found in code`);
        for (const [key, { plural, files }] of used) {
            for (const lang of LANG_CODES) {
                // A key named as a plain literal may be a plural base (passed on to tp later).
                const ok = plural ? has(lang, `${key}.other`) : (has(lang, key) || has(lang, `${key}.other`));
                assert.ok(ok, `${lang}: ${key} (used in ${[...files].join(', ')}) is missing`);
            }
        }
    });

    test(`${ns}: every catalog key is used by the code (no dead keys)`, () => {
        const used = keysUsed(ns);
        const plurals = /\.(zero|one|two|few|many|other)$/;
        for (const key of BOT_CATALOG.catalogKeys('en').filter((k) => k.startsWith(`${ns}.`))) {
            const base = key.replace(plurals, '');
            assert.ok(used.has(key) || used.has(base), `${key} is in the catalog but not named in code`);
        }
    });

    test(`${ns}: description localizations fit Discord's 100 characters and cover every Discord locale`, () => {
        for (const [key] of [...keysUsed(ns)].filter(([k]) => k.startsWith(`${ns}.cmd.`))) {
            for (const lang of LANG_CODES) {
                const text = botText(lang).t(key);
                assert.ok(text.length >= 1 && text.length <= 100, `${lang}: ${key} is ${text.length} characters`);
            }
            const loc = localizations(key);
            assert.deepEqual(Object.keys(loc).sort(), Object.values(DISCORD_LOCALES).flat().sort(), key);
        }
    });
}

// Every command and option in the five areas carries Discord localizations for all 7 other languages.
const COMMAND_DIRS = ['Ticket', 'Welcome', 'Reaction_roles', 'JoinToCreate', 'Verification'];
const LOCALES = Object.values(DISCORD_LOCALES).flat().sort();
function walk(node, where, out) {
    if (node.description !== undefined) out.push({ where, node });
    for (const option of node.options || []) walk(option, `${where} ${option.name}`, out);
    return out;
}
test('slash commands: every description (command, subcommand, option) is localized, within 100 characters', async () => {
    for (const dir of COMMAND_DIRS) {
        for (const name of readdirSync(join(SRC, 'commands', dir)).filter((f) => f.endsWith('.js'))) {
            const mod = (await import(new URL(`../src/commands/${dir}/${name}`, import.meta.url))).default;
            if (!mod?.data?.toJSON) continue;
            const json = mod.data.toJSON();
            for (const { where, node } of walk(json, `/${json.name}`, [])) {
                if (json.type && json.type !== 1) continue; // context menus have no description
                assert.ok(node.description_localizations, `${where}: no description localizations`);
                assert.deepEqual(Object.keys(node.description_localizations).sort(), LOCALES, where);
                for (const [locale, text] of Object.entries(node.description_localizations)) {
                    assert.ok(text.length >= 1 && text.length <= 100, `${where} ${locale}: ${text.length} characters`);
                }
                assert.ok(node.description.length <= 100, `${where}: English ${node.description.length} characters`);
            }
        }
    }
});
