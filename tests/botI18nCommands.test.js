// Translated commands of Core, Utility, Tools, Search and Fun (catalog namespaces core, utility,
// tools, search, fun): every catalog key the code names exists, and every slash command carries
// description localizations for the 8 languages (Discord locales), within Discord's 100-character
// limit, with the English one equal to the default description. Names are never localized.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { BOT_CATALOG, LANG_CODES } from '../src/utils/botText.js';
import { DISCORD_LOCALES, localized } from '../src/commands/Core/modules/commandText.js';

const SRC = new URL('../src/', import.meta.url);
const FOLDERS = { core: 'Core', utility: 'Utility', tools: 'Tools', search: 'Search', fun: 'Fun' };
// Handlers and interactions owned by these commands (outside src/commands).
const OWNED = {
    core: ['handlers/help/helpButtons.js', 'handlers/help/helpSelectMenus.js', 'interactions/buttons/help/help.js', 'interactions/selectMenus/help/helpCategory.js'],
    utility: ['handlers/todoButtons.js', 'handlers/wipedataButtons.js', 'interactions/buttons/todo/todoShared.js', 'interactions/modals/todo/todoShared.js',
        'interactions/buttons/wipedata/wipedata.js', 'interactions/buttons/cooldown/selfCooldown.js'],
    tools: ['handlers/countdownButtons.js', 'handlers/calculateModals.js', 'interactions/buttons/countdown/countdown.js', 'interactions/modals/calculate/calculate.js'],
    search: [],
    fun: [],
};

function jsFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = new URL(name, dir);
        if (statSync(path).isDirectory()) out.push(...jsFiles(new URL(`${name}/`, dir)));
        else if (name.endsWith('.js')) out.push(path);
    }
    return out;
}

const filesOf = (ns) => [...jsFiles(new URL(`commands/${FOLDERS[ns]}/`, SRC)), ...OWNED[ns].map((p) => new URL(p, SRC))];
const exists = (key) => BOT_CATALOG.catalogText('en', key) !== undefined || BOT_CATALOG.catalogText('en', `${key}.other`) !== undefined;

for (const ns of Object.keys(FOLDERS)) {
    test(`${ns}: every catalog key named in the code exists (English; parity covers the other 7)`, () => {
        const pattern = new RegExp(`['"\`](${ns}\\.[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+)['"\`]`, 'g');
        const used = new Set();
        for (const file of filesOf(ns)) {
            for (const match of readFileSync(file, 'utf8').matchAll(pattern)) used.add(match[1]);
        }
        assert.ok(used.size > 0, `${ns}: no keys found`);
        const missing = [...used].filter((key) => !exists(key));
        assert.deepEqual(missing, [], `${ns}: keys missing in src/content/bot/en/${ns}.json`);
    });
}

test('localized(): every Discord locale of the 8 languages, English twice', () => {
    const all = Object.values(DISCORD_LOCALES).flat();
    assert.deepEqual(Object.keys(DISCORD_LOCALES).sort(), [...LANG_CODES].sort());
    const out = localized('core.slash.ping.description');
    assert.deepEqual(Object.keys(out).sort(), all.sort());
    assert.equal(out['en-US'], out['en-GB']);
    assert.equal(out['es-ES'], out['es-419']);
});

function walk(node, path, visit) {
    visit(node, path);
    for (const option of node.options || []) walk(option, `${path} ${option.name}`, visit);
}

const WANT = Object.values(DISCORD_LOCALES).flat().sort();
for (const ns of Object.keys(FOLDERS)) {
    const dir = new URL(`commands/${FOLDERS[ns]}/`, SRC);
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
        test(`${FOLDERS[ns]}/${name}: description localizations in all 8 languages, at most 100 characters, names not localized`, async () => {
            const mod = await import(new URL(name, dir));
            const command = mod.default || mod;
            const json = command?.data?.toJSON?.();
            if (!json || (json.type && json.type !== 1)) return; // context menus have no description
            let checked = 0;
            walk(json, `/${json.name}`, (node, path) => {
                assert.equal(node.name_localizations ?? undefined, undefined, `${path}: name localized`);
                for (const choice of node.choices || []) assert.equal(choice.name_localizations ?? undefined, undefined, `${path}: choice name localized`);
                if (node.description === undefined) return;
                const loc = node.description_localizations;
                assert.ok(loc, `${path}: no description localizations`);
                assert.deepEqual(Object.keys(loc).sort(), WANT, `${path}: locales`);
                assert.equal(loc['en-US'], node.description, `${path}: English localization = default description`);
                for (const [locale, text] of Object.entries(loc)) {
                    assert.ok(text.length >= 1 && text.length <= 100, `${path} ${locale}: ${text.length} characters`);
                }
                checked += 1;
            });
            assert.ok(checked >= 1, `/${json.name}: nothing checked`);
        });
    }
}
