// /help lists (helpSelectMenus.js) stay within Discord's embed limits in all 8 languages, and the
// page buttons carry their page in the customId (help-page:<view>:<action>:<page>) instead of
// reading it from the (translated) label. Old-format buttons (help-page_next …) keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { LANG_CODES, botText } from '../src/utils/botText.js';
import {
    ALL_VIEW, EMBED_LIMITS, createAllCommandsMenu, createCategoryCommandsMenu, createHelpPage, fitsEmbedLimits,
    helpPageId, helpPaginationRow, paginateLines, parseHelpPageId, _resetCommandIdCache, _setEmbedTotalForTests,
} from '../src/handlers/help/helpSelectMenus.js';
import { helpPageButton, helpPaginationButton, legacyTargetPage } from '../src/handlers/help/helpButtons.js';
import helpButtons from '../src/interactions/buttons/help/help.js';

const MAIN_GUILD = '1527697154926182492';
const COMMANDS_DIR = new URL('../src/commands/', import.meta.url);
const CATEGORIES = readdirSync(COMMANDS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

// Every command "registered" with a 19-digit id, so every line is the longest form (</name sub:id>).
const names = [];
for (const category of CATEGORIES) {
    for (const file of readdirSync(new URL(`${category}/`, COMMANDS_DIR)).filter((f) => f.endsWith('.js'))) {
        const mod = await import(new URL(`${category}/${file}`, COMMANDS_DIR));
        const data = mod.default?.data;
        const name = data?.name ?? data?.toJSON?.().name;
        if (name) names.push(name);
    }
}
const client = {
    commands: new Map(),
    user: { username: 'Mewvo', displayAvatarURL: () => 'https://x/a.png' },
    application: { commands: { fetch: async () => new Map(names.map((name) => [name, { name, id: '1531096173786566697' }])) } },
};
_resetCommandIdCache();

const BUTTON_NAMES = new Set(helpButtons.map((button) => button.name).concat('help-back-to-main'));

function assertWithinLimits(menu, where) {
    assert.equal(menu.embeds.length, 1, where);
    const embed = menu.embeds[0].data;
    const fields = embed.fields || [];
    assert.ok((embed.title || '').length <= EMBED_LIMITS.title, `${where}: title`);
    assert.ok((embed.description || '').length <= EMBED_LIMITS.description, `${where}: description`);
    assert.ok(fields.length <= EMBED_LIMITS.fields, `${where}: ${fields.length} fields`);
    let total = (embed.title || '').length + (embed.description || '').length + (embed.footer?.text || '').length + (embed.author?.name || '').length;
    for (const field of fields) {
        assert.ok(field.name.length > 0 && field.name.length <= 256, `${where}: field name`);
        assert.ok(field.value.length > 0 && field.value.length <= EMBED_LIMITS.field, `${where}: field of ${field.value.length}`);
        total += field.name.length + field.value.length;
    }
    assert.ok(total <= EMBED_LIMITS.total, `${where}: ${total} characters`);

    const ids = menu.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
    assert.equal(new Set(ids).size, ids.length, `${where}: duplicate customIds ${ids}`);
    for (const id of ids) {
        assert.ok(id.length <= 100, `${where}: customId ${id}`);
        assert.ok(BUTTON_NAMES.has(id.split(':')[0]), `${where}: ${id} has no button handler`);
    }
    return total;
}

for (const lang of LANG_CODES) {
    test(`${lang}: every help category and every all-commands page fits Discord's embed limits`, async () => {
        const tr = botText(lang);
        for (const showAdmin of [true, false]) {
            for (const category of CATEGORIES) {
                const first = await createCategoryCommandsMenu(category, client, MAIN_GUILD, showAdmin, tr);
                for (let page = 1; page <= first.totalPages; page++) {
                    const menu = page === 1 ? first : await createCategoryCommandsMenu(category, client, MAIN_GUILD, showAdmin, tr, page);
                    assert.equal(menu.currentPage, page);
                    assertWithinLimits(menu, `${lang} ${category} page ${page} admin=${showAdmin}`);
                }
            }
            const all = await createAllCommandsMenu(1, client, MAIN_GUILD, showAdmin, tr);
            assert.ok(all.totalPages >= 1);
            for (let page = 1; page <= all.totalPages; page++) {
                assertWithinLimits(await createAllCommandsMenu(page, client, MAIN_GUILD, showAdmin, tr), `${lang} all page ${page} admin=${showAdmin}`);
            }
        }
    });
}

test('a category too long for one embed is paged: every command once, page buttons, within the limit', async () => {
    // Enforcement is ~5300-5800 characters today; a 2500 cap stands in for a longer language.
    _setEmbedTotalForTests(2500);
    try {
        for (const lang of LANG_CODES) {
            const tr = botText(lang);
            const single = (_setEmbedTotalForTests(), await createCategoryCommandsMenu('Enforcement', client, MAIN_GUILD, true, tr));
            const want = single.embeds[0].data.fields.flatMap((field) => field.value.split('\n'));
            _setEmbedTotalForTests(2500);
            const first = await createCategoryCommandsMenu('Enforcement', client, MAIN_GUILD, true, tr);
            assert.ok(first.totalPages >= 3, `${lang}: ${first.totalPages} pages`);
            const lines = [];
            for (let page = 1; page <= first.totalPages; page++) {
                const menu = await createCategoryCommandsMenu('Enforcement', client, MAIN_GUILD, true, tr, page);
                assert.ok(assertWithinLimits(menu, `${lang} page ${page}`) <= 2500, `${lang} page ${page}`);
                const ids = menu.components[0].components.map((c) => c.data.custom_id);
                assert.equal(ids[2], `help-page:Enforcement:page:${page}`);
                assert.equal(menu.embeds[0].data.fields[0].name, tr.t('core.help.list.commandsPage', { page }));
                assert.equal(menu.embeds[0].data.description, `${tr.t('core.help.list.click')}\n${tr.t('core.help.list.changePage')}`);
                for (const field of menu.embeds[0].data.fields) lines.push(...field.value.split('\n'));
            }
            assert.deepEqual(lines, want, `${lang}: the pages together list every command once, in order`);
        }
    } finally {
        _setEmbedTotalForTests();
    }
});

test('a category that fits on one page keeps its old look (no page buttons, "Commands" field)', async () => {
    const menu = await createCategoryCommandsMenu('Birthday', client, MAIN_GUILD, true, botText('en'));
    assert.equal(menu.totalPages, 1);
    assert.equal(menu.embeds[0].data.description, 'Click a command to use it.');
    assert.equal(menu.embeds[0].data.fields[0].name, 'Commands');
    assert.deepEqual(menu.components.map((row) => row.components.map((c) => c.data.custom_id)), [['help-back-to-main']]);
});

test('an out-of-range page is clamped to the last page', async () => {
    const tr = botText('en');
    const all = await createAllCommandsMenu(9999, client, MAIN_GUILD, true, tr);
    assert.equal(all.currentPage, all.totalPages);
    const cat = await createCategoryCommandsMenu('Enforcement', client, MAIN_GUILD, true, tr, 9999);
    assert.equal(cat.currentPage, cat.totalPages);
});

test('paginateLines: long lines are split into pages that all fit, in order, nothing lost', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `${String(i).padStart(3, '0')} ${'x'.repeat(180)}`);
    const layout = (pageLines) => {
        const fields = [];
        let current = '';
        for (const line of pageLines) {
            if (current && `${current}\n${line}`.length > 1000) { fields.push({ name: 'Commands', value: current }); current = line; }
            else current = current ? `${current}\n${line}` : line;
        }
        if (current) fields.push({ name: 'Commands', value: current });
        return fields;
    };
    const pages = paginateLines(lines, { layout, title: 'T', description: 'D' });
    assert.ok(pages.length > 1);
    assert.deepEqual(pages.flat(), lines);
    for (const page of pages) assert.ok(fitsEmbedLimits(layout(page), { title: 'T', description: 'D' }));
    assert.equal(paginateLines(lines.slice(0, 50), { layout, title: 'T', description: 'D', maxLines: 20 }).length, 3);
});

test('fitsEmbedLimits: total, field and field-count limits', () => {
    assert.equal(fitsEmbedLimits([{ name: 'a', value: 'x'.repeat(1024) }]), true);
    assert.equal(fitsEmbedLimits([{ name: 'a', value: 'x'.repeat(1025) }]), false);
    assert.equal(fitsEmbedLimits(Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' }))), false);
    assert.equal(fitsEmbedLimits(Array.from({ length: 6 }, () => ({ name: 'a', value: 'x'.repeat(1000) }))), false);
    assert.equal(fitsEmbedLimits([{ name: 'a', value: 'x'.repeat(1000) }], { description: 'd'.repeat(5000) }), false);
});

test('page customIds: round trip, routed by the prefix, under 100 characters, malformed ids rejected', () => {
    const id = helpPageId('Reaction_roles', 'next', 3);
    assert.equal(id, 'help-page:Reaction_roles:next:3');
    assert.equal(id.split(':')[0], 'help-page');
    assert.deepEqual(parseHelpPageId(id), { view: 'Reaction_roles', page: 3 });
    assert.deepEqual(parseHelpPageId('help-page:all:first:1'), { view: ALL_VIEW, page: 1 });
    assert.deepEqual(parseHelpPageId('help-page:all:prev:0'), { view: ALL_VIEW, page: 1 });
    for (const bad of ['help-page_next', 'help-page', 'help-page:all', 'help-page:all:jump:2', 'help-page:all:next:x',
        'help-page:all:next:-1', 'help-page:all:next:99999', 'help-page::next:2', 'help-page:all:next:2:extra', 'other:all:next:2', null]) {
        assert.equal(parseHelpPageId(bad), null, String(bad));
    }
    for (const category of CATEGORIES) assert.ok(helpPageId(category, 'last', 9999).length <= 100, category);
});

test('page row: page numbers in the ids, translated labels, unique ids on every page', () => {
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const page of [1, 2, 4, 5]) {
            const row = helpPaginationRow(ALL_VIEW, page, 5, tr).toJSON();
            const ids = row.components.map((c) => c.custom_id);
            assert.equal(new Set(ids).size, 5, `${lang} page ${page}`);
            const targets = ids.map((id) => parseHelpPageId(id).page);
            assert.deepEqual(targets, [1, Math.max(1, page - 1), page, Math.min(5, page + 1), 5]);
            assert.equal(row.components[2].label, tr.t('core.help.list.pageOf', { page, total: 5 }));
            assert.equal(row.components[0].disabled, page === 1);
            assert.equal(row.components[4].disabled, page === 5);
            assert.equal(row.components[2].disabled, true);
        }
    }
    const ru = helpPaginationRow(ALL_VIEW, 2, 5, botText('ru')).toJSON();
    assert.ok(!ru.components.some((c) => /Page|Next|Previous/.test(c.label)), 'Russian labels are translated');
});

function fakeInteraction(customId, extra = {}) {
    const calls = [];
    return {
        calls,
        customId,
        guildId: MAIN_GUILD,
        locale: 'ru',
        user: { id: '111111111111111111' },
        guild: { ownerId: '111111111111111111' },
        memberPermissions: { has: () => true },
        deferred: false,
        replied: false,
        async deferUpdate() { calls.push(['deferUpdate']); this.deferred = true; },
        async editReply(payload) { calls.push(['editReply', payload]); },
        ...extra,
    };
}

test('help-page button: acks first, opens the page in the id, in the viewer\'s language, no pings', async () => {
    const all = await createAllCommandsMenu(1, client, MAIN_GUILD, true, botText('ru'));
    assert.ok(all.totalPages >= 2, 'the all-commands list has several pages');
    const interaction = fakeInteraction('help-page:all:next:2');
    await helpPageButton.execute(interaction, client);
    assert.deepEqual(interaction.calls[0], ['deferUpdate']);
    const [, payload] = interaction.calls[1];
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.embeds[0].data.title, botText('ru').t('core.help.list.allTitle'));
    const indicator = payload.components[0].components[2].data;
    assert.equal(indicator.custom_id, 'help-page:all:page:2');
    assert.equal(indicator.label, botText('ru').t('core.help.list.pageOf', { page: 2, total: all.totalPages }));
});

test('help-page button for a category page', async () => {
    const first = await createHelpPage('Enforcement', 1, client, MAIN_GUILD, true, botText('fr'));
    const interaction = fakeInteraction(`help-page:Enforcement:last:${first.totalPages}`, { locale: 'fr' });
    await helpPageButton.execute(interaction, client);
    const [, payload] = interaction.calls[1];
    assert.match(payload.embeds[0].data.title, /Sanctions/, 'the category name in French');
    if (first.totalPages > 1) assert.equal(payload.components[0].components[2].data.custom_id, `help-page:Enforcement:page:${first.totalPages}`);
});

test('help-page button with a malformed id or an unknown view answers with the help start page', async () => {
    for (const id of ['help-page:../../etc:next:2', 'help-page:NoSuchCategory:next:2', 'help-page:all:jump:2']) {
        const interaction = fakeInteraction(id, { locale: 'en-US' });
        await helpPageButton.execute(interaction, client);
        assert.deepEqual(interaction.calls[0], ['deferUpdate'], id);
        const [kind, payload] = interaction.calls[1];
        assert.equal(kind, 'editReply', id);
        assert.equal(payload.embeds[0].data.title, 'Mewvo help', id);
    }
    assert.equal(await createHelpPage('../Core', 1, client, MAIN_GUILD, true, botText('en')), null);
});

test('old-format buttons (help-page_next …) still work from the English "Page x of y" label', async () => {
    const old = [{ components: [{ customId: 'help-page_page', label: 'Page 2 of 4' }] }];
    assert.equal(legacyTargetPage('help-page_first', old), 1);
    assert.equal(legacyTargetPage('help-page_prev', old), 1);
    assert.equal(legacyTargetPage('help-page_next', old), 3);
    assert.equal(legacyTargetPage('help-page_last', old), 4);
    assert.equal(legacyTargetPage('help-page_next', []), 1);
    for (const name of ['help-page_first', 'help-page_prev', 'help-page_next', 'help-page_last']) assert.ok(BUTTON_NAMES.has(name), name);

    const interaction = fakeInteraction('help-page_next', { locale: 'de', message: { components: [{ components: [{ customId: 'help-page_page', label: 'Page 1 of 4' }] }] } });
    await helpPaginationButton.execute(interaction, client);
    assert.deepEqual(interaction.calls[0], ['deferUpdate']);
    const [, payload] = interaction.calls[1];
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    // The answer has new-format buttons, so the next click no longer depends on the label.
    assert.equal(payload.components[0].components[2].data.custom_id, 'help-page:all:page:2');
});
