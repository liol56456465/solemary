// Bot i18n for Leveling, Community, Giveaway, Birthday and ServerStats: every catalog key the code
// uses exists (one test per namespace), every slash-command description is localized in all 7 other
// languages within Discord's 100-character limit, and the English descriptions are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOT_CATALOG } from '../src/utils/botText.js';
import { DESCRIPTION_LIMIT, DISCORD_LOCALES_BY_LANG } from '../src/utils/commandLocalizations.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const NAMESPACES = ['leveling', 'community', 'giveaway', 'birthday', 'serverstats'];
const LOCALES = Object.values(DISCORD_LOCALES_BY_LANG).flat();

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (statSync(path).isDirectory()) walk(path, out);
        else if (name.endsWith('.js')) out.push(path);
    }
    return out;
}

// Files that use the bot catalog: they import botText.js or commandLocalizations.js.
const CATALOG_FILES = walk(SRC.replace(/\/$/, '')).filter((file) => /from ['"][./]*(?:utils\/)?(?:botText|commandLocalizations)\.js['"]/.test(readFileSync(file, 'utf8')));

const exists = (key) => BOT_CATALOG.catalogText('en', key) !== undefined || BOT_CATALOG.catalogText('en', `${key}.other`) !== undefined;

for (const ns of NAMESPACES) {
    test(`${ns}: every catalog key used in the code exists in English`, () => {
        const literal = new RegExp(`['"](${ns}\\.[A-Za-z][\\w]*(?:\\.[\\w]+)+)['"]`, 'g');
        const used = new Map();
        for (const file of CATALOG_FILES) {
            for (const [, key] of readFileSync(file, 'utf8').matchAll(literal)) {
                if (/\.(js|json)$/.test(key)) continue;
                used.set(key, file.slice(SRC.length));
            }
        }
        assert.ok(used.size > 0, `${ns}: no keys found in the code`);
        const missing = [...used].filter(([key]) => !exists(key)).map(([key, file]) => `${key} (${file})`);
        assert.deepEqual(missing, [], `${ns}: keys used in code but missing in en/${ns}.json`);
    });
}

const COMMAND_DIRS = ['commands/Leveling', 'commands/Community', 'commands/Giveaway', 'commands/Birthday', 'commands/ServerStats'];
const commandFiles = COMMAND_DIRS.flatMap((dir) => readdirSync(`${SRC}${dir}`).filter((f) => f.endsWith('.js')).map((f) => `${SRC}${dir}/${f}`));

function* describedNodes(node, path) {
    if (node.description !== undefined) yield [path, node];
    for (const option of node.options || []) yield* describedNodes(option, `${path} ${option.name}`);
}

test('every description of these slash commands is localized in all 7 languages, max 100 characters', async () => {
    let checked = 0;
    for (const file of commandFiles) {
        const command = (await import(file)).default;
        if (!command?.data?.toJSON) continue;
        const json = command.data.toJSON();
        for (const [path, node] of describedNodes(json, `/${json.name}`)) {
            assert.ok(node.description.length > 0 && node.description.length <= DESCRIPTION_LIMIT, `${path}: English description length`);
            const locs = node.description_localizations || {};
            for (const locale of LOCALES) {
                const text = locs[locale];
                assert.ok(typeof text === 'string' && text.length > 0, `${path}: no ${locale} description`);
                assert.ok(text.length <= DESCRIPTION_LIMIT, `${path} ${locale}: ${text.length} characters`);
                assert.ok(!text.endsWith('…') || node.description.endsWith('…'), `${path} ${locale}: cut at 100 characters`);
            }
            for (const choice of node.choices || []) {
                for (const [locale, text] of Object.entries(choice.name_localizations || {})) {
                    assert.ok(text.length > 0 && text.length <= DESCRIPTION_LIMIT, `${path} choice ${choice.name} ${locale}`);
                }
            }
            checked += 1;
        }
    }
    assert.ok(checked > 40, `checked ${checked} descriptions`);
});

test('every catalog text of these namespaces fits a Discord description where it is one (cmd.*)', () => {
    for (const lang of ['en', ...Object.keys(DISCORD_LOCALES_BY_LANG)]) {
        for (const key of BOT_CATALOG.catalogKeys(lang)) {
            if (!NAMESPACES.some((ns) => key.startsWith(`${ns}.cmd.`))) continue;
            const text = BOT_CATALOG.catalogText(lang, key);
            assert.ok(text.length <= DESCRIPTION_LIMIT, `${lang} ${key}: ${text.length} characters`);
        }
    }
});
