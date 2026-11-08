// Bot i18n, Moderation / Logging / Owner (namespaces moderation, logging, owner): English output
// unchanged, every dynamic key present, the /logging panel told apart by title in any language,
// and the /logging dashboard and /database pages inside Discord's limits in the longest language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES, botText } from '../src/utils/botText.js';
import { getGuildConfigKey } from '../src/utils/database/keys.js';
import {
    DASHBOARD_CATEGORIES, categoryLabel, createLoggingCategoryViewComponents, createLoggingDashboardComponents, createLoggingFilterComponents,
} from '../src/utils/logging/loggingUi.js';
import {
    buildLoggingCategoriesView, buildLoggingDashboardView, buildLoggingFilterView, isCategoriesView, isFilterView,
} from '../src/commands/Logging/modules/logging_dashboard.js';
import {
    LookupInputError, NOTE_KEYS, PAGE_TEXT_MAX, SECTION_KEYS, USER_SECTIONS, paginate, resultLines, resultTitle,
} from '../src/services/owner/databaseLookup.js';
import { LOOKUP_DB_ERROR, LOOKUP_EXPIRED, lookupDbError, lookupExpired, lookupMessage } from '../src/handlers/databaseLookupView.js';

const GUILD = '400000000000000004';
const OWNER = '200000000000000001';
const LOCALE = { en: 'en-US', ru: 'ru', de: 'de', fr: 'fr', it: 'it', pl: 'pl', es: 'es-ES', 'pt-BR': 'pt-BR' };

// ── Moderation ─────────────────────────────────────────────────────────────

test('moderation: English texts as the commands had them (purge now says "1 message")', () => {
    const en = botText('en');
    assert.equal(en.t('moderation.lock.done', { channel: '<#1>' }), "<#1> is locked. Members can't send messages here until it's unlocked.");
    assert.equal(en.t('moderation.unlock.notLocked', { channel: '<#1>' }), '<#1> is not explicitly locked (everyone can already send messages).');
    assert.equal(en.tp('moderation.purge.done', 5, { channel: '<#1>' }), 'Deleted 5 messages in <#1>.');
    assert.equal(en.tp('moderation.purge.done', 1, { channel: '<#1>' }), 'Deleted 1 message in <#1>.');
    assert.equal(en.t('moderation.rules.posted', { channelId: '9', messages: en.tp('moderation.rules.messages', 2) }), 'The rules were posted in <#9> (2 messages).');
    assert.equal(en.t('moderation.rules.previewHead', { messages: en.tp('moderation.rules.messages', 1), where: en.t('moderation.rules.noChannelSaved') }),
        'Preview of the rules post (1 message, saved channel: no channel saved yet). Only you can see this. Nothing was posted.');
});

test('moderation: plurals in every language keep the count and the channel', () => {
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const n of [0, 1, 2, 5, 21, 100]) {
            const text = tr.tp('moderation.purge.done', n, { channel: '<#77>' });
            assert.ok(text.includes('<#77>') && text.includes(String(n)), `${lang} ${n}: ${text}`);
        }
    }
});

// ── Logging ────────────────────────────────────────────────────────────────

function loggingClient({ manyIds = false } = {}) {
    const ids = (n) => Array.from({ length: n }, (_, i) => String(100000000000000000n + BigInt(i)));
    const config = {
        logging: {
            enabled: true,
            channels: { audit: '500000000000000001', applications: null, reports: '500000000000000003' },
            enabledEvents: {},
            ignore: { users: manyIds ? ids(200) : ['1'], channels: manyIds ? ids(200) : [], roles: manyIds ? ids(200) : [] },
        },
    };
    const data = new Map([[getGuildConfigKey(GUILD), config]]);
    return { db: { async get(key, fallback = null) { return data.has(key) ? structuredClone(data.get(key)) : fallback; } } };
}
function loggingInteraction(lang, name = 'Server') {
    const channels = { cache: new Map([['500000000000000001', { toString: () => '<#500000000000000001>' }]]), fetch: async () => null };
    return { guildId: GUILD, locale: LOCALE[lang], guild: { id: GUILD, name, channels } };
}
function embedSize(json) {
    return (json.title?.length || 0) + (json.description?.length || 0) + (json.footer?.text?.length || 0)
        + (json.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}
function assertEmbedLimits(json, where) {
    assert.ok((json.title?.length || 0) <= 256, `${where}: title`);
    assert.ok((json.description?.length || 0) <= 4096, `${where}: description ${json.description?.length}`);
    for (const f of json.fields || []) {
        assert.ok(f.name.length <= 256 && f.value.length >= 1 && f.value.length <= 1024, `${where}: field ${f.name} ${f.value.length}`);
    }
    assert.ok((json.footer?.text?.length || 0) <= 2048, `${where}: footer`);
    assert.ok(embedSize(json) <= 6000, `${where}: total ${embedSize(json)}`);
}
function assertComponentLimits(rows, where) {
    for (const row of rows.map((r) => r.toJSON())) {
        for (const c of row.components) {
            if (c.label) assert.ok(c.label.length <= 80, `${where}: button ${c.label}`);
            if (c.placeholder) assert.ok(c.placeholder.length <= 150, `${where}: placeholder`);
            for (const o of c.options || []) {
                assert.ok(o.label.length <= 100 && (o.description?.length || 0) <= 100, `${where}: option ${o.label}`);
            }
        }
    }
}

test('logging dashboard: English embed as before', async () => {
    const { embed, components } = await buildLoggingDashboardView(loggingInteraction('en'), loggingClient());
    const json = embed.toJSON();
    assert.equal(json.title, 'Logging');
    assert.equal(json.description, 'Logging for **Server**. Use the menu below to set channels, categories and filters.');
    assert.deepEqual(json.fields.map((f) => f.name), ['Logging', 'Event categories', 'Ignore filters', 'Log channels', 'Ticket channels (read-only)']);
    assert.equal(json.fields[0].value, 'On');
    assert.equal(json.fields[2].value, '1 users · 0 channels · 0 roles');
    assert.equal(json.fields[3].value, '**Audit:** <#500000000000000001>\n**Applications:** Not set\n**Reports:** Missing (500000000000000003)');
    assert.equal(json.footer.text, 'Ticket channels are set in /ticket dashboard');
    const menu = components[0].toJSON().components[0];
    assert.equal(menu.placeholder, 'Pick a setting to change');
    assert.deepEqual(menu.options.map((o) => o.label), ['Set audit log channel', 'Set applications channel', 'Set reports channel', 'Clear audit channel',
        'Clear applications channel', 'Clear reports channel', 'Event categories', 'Ignore filters']);
    assert.deepEqual(components[1].toJSON().components.map((b) => b.label), ['Audit logging', 'Refresh']);
});

test('logging: category labels in English unchanged, every category has a label in every language', () => {
    assert.equal(categoryLabel('server'), 'Emoji, events, webhooks, invites, AutoMod');
    assert.equal(categoryLabel('reactionrole'), 'Reaction roles');
    for (const lang of LANG_CODES) {
        for (const category of DASHBOARD_CATEGORIES) {
            const label = categoryLabel(category, { lang });
            assert.ok(label && label !== category && label.length <= 80, `${lang} ${category}`);
        }
    }
});

test('logging: the sub-views are recognised by their title in every language (a panel opened in one language, clicked in another)', async () => {
    for (const lang of LANG_CODES) {
        const categories = (await buildLoggingCategoriesView(loggingInteraction(lang), loggingClient())).embed.toJSON();
        const filters = (await buildLoggingFilterView(loggingInteraction(lang), loggingClient())).embed.toJSON();
        const main = (await buildLoggingDashboardView(loggingInteraction(lang), loggingClient())).embed.toJSON();
        const clicked = (title) => ({ message: { embeds: [{ title }] } });
        assert.ok(isCategoriesView(clicked(categories.title)) && !isFilterView(clicked(categories.title)), `${lang} categories`);
        assert.ok(isFilterView(clicked(filters.title)) && !isCategoriesView(clicked(filters.title)), `${lang} filters`);
        assert.ok(!isCategoriesView(clicked(main.title)) && !isFilterView(clicked(main.title)), `${lang} main`);
    }
    assert.ok(isCategoriesView({ message: { embeds: [{ title: '📋 Event Categories' }] } }), 'old title still accepted');
});

test('logging: dashboard, categories and filters inside the embed limits in every language (long server name, 200 ignored ids each)', async () => {
    const longest = { lang: null, size: 0 };
    for (const lang of LANG_CODES) {
        const interaction = loggingInteraction(lang, 'N'.repeat(100));
        for (const build of [buildLoggingDashboardView, buildLoggingCategoriesView, buildLoggingFilterView]) {
            const { embed, components } = await build(interaction, loggingClient({ manyIds: true }));
            const json = embed.toJSON();
            assertEmbedLimits(json, `${lang} ${build.name}`);
            assertComponentLimits(components, `${lang} ${build.name}`);
            if (build === buildLoggingDashboardView && embedSize(json) > longest.size) Object.assign(longest, { lang, size: embedSize(json) });
        }
        assertComponentLimits(createLoggingDashboardComponents({}, true, { lang }), `${lang} main components`);
        assertComponentLimits(createLoggingCategoryViewComponents({}, true, { lang }), `${lang} category components`);
        assertComponentLimits(createLoggingFilterComponents({ lang }), `${lang} filter components`);
    }
    assert.notEqual(longest.lang, 'en', `the longest dashboard is a translation (${longest.lang})`);
});

// ── Owner: /database ───────────────────────────────────────────────────────

function bigResult() {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, reason: 'x'.repeat(150), created_at: new Date(Date.UTC(2026, 0, 1 + i)) }));
    const names = [...USER_SECTIONS.map(([name]) => name), ...Object.keys(SECTION_KEYS)];
    return {
        kind: 'user', title: `User ${OWNER}`, subject: OWNER,
        sections: [...names, ...names, ...names, ...names].map((name, i) => ({ name, count: 40 + i, rows, note: i % 7 === 0 ? 'empty = never set (the default applies)' : null })),
    };
}

test('/database: English pages, title, footer and refusals as before', () => {
    const result = { kind: 'case', title: 'Case abc23', subject: 'abc23', sections: [{ name: 'Edits', count: 3, rows: [{ field: 'reason' }], note: 'not recorded (no migrations table)' }] };
    assert.deepEqual(resultLines(result), ['**Edits**: 3 (showing 1) _not recorded (no migrations table)_', '• field: reason']);
    assert.equal(paginate(result).title, 'Case abc23');
    assert.deepEqual(paginate({ ...result, notFound: true }).pages, ['Nothing found.']);
    const message = lookupMessage({ title: 't', pages: ['a', 'b'] }, 0, { ownerId: OWNER, nonce: 'abcdef123456' });
    assert.equal(message.embeds[0].toJSON().footer.text, 'Page 1 of 2 · read-only · secrets are hidden');
    assert.deepEqual(message.components[0].toJSON().components.map((b) => b.label), ['Previous', 'Next']);
    assert.equal(lookupExpired(), LOOKUP_EXPIRED);
    assert.equal(lookupDbError(), LOOKUP_DB_ERROR);
    assert.equal(new LookupInputError('That is not a server ID.', 'owner.database.input.notServer').textIn('en'), 'That is not a server ID.');
    assert.equal(new LookupInputError('Search for 2 to 100 characters.', 'owner.database.input.searchLength', { min: 2, max: 100 }).textIn('de'), 'Suche nach 2 bis 100 Zeichen.');
    assert.equal(new LookupInputError('plain').textIn('de'), 'plain', 'no key: the message as written');
});

test('/database: every section name and note has a translation; table names stay as they are', () => {
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const id of Object.values(SECTION_KEYS)) assert.ok(tr.has(`owner.database.section.${id}`), `${lang} section ${id}`);
        for (const id of Object.values(NOTE_KEYS)) assert.ok(tr.has(`owner.database.note.${id}`), `${lang} note ${id}`);
        for (const kind of ['user', 'server', 'case', 'stats', 'search']) {
            const title = resultTitle({ kind, title: 'x', subject: 'abc23' }, { lang });
            assert.ok(title && title.length <= 200, `${lang} ${kind}`);
        }
    }
    for (const [name] of USER_SECTIONS) assert.ok(SECTION_KEYS[name], `USER_SECTIONS "${name}" has a key`);
    const german = resultLines({ kind: 'stats', sections: [{ name: 'Rows per table', count: 1, rows: [{ table: 'mod_cases', rows: 3 }], note: null }] }, { lang: 'de' });
    assert.deepEqual(german, ['**Zeilen pro Tabelle**: 1', '• table: mod\\_cases · rows: 3']);
});

test('/database: every page inside the embed limits in every language (25 pages, long rows)', () => {
    for (const lang of LANG_CODES) {
        const { title, pages } = paginate(bigResult(), { lang });
        assert.ok(pages.length > 1, `${lang}: several pages`);
        for (const [index, page] of pages.entries()) {
            assert.ok(page.length <= PAGE_TEXT_MAX + 80, `${lang} page ${index}: ${page.length}`);
            const json = lookupMessage({ title, pages }, index, { ownerId: OWNER, nonce: 'abcdef123456', lang }).embeds[0].toJSON();
            assertEmbedLimits(json, `${lang} /database page ${index}`);
        }
    }
});

// ── Owner: /backup, /test ──────────────────────────────────────────────────

test('/backup and /test: English replies as before; long server names still fit', () => {
    const en = botText('en');
    assert.equal(en.t('owner.backup.rebuildFinished', { server: 'S', roles: 3, channels: 4, failed: 0, serverId: '9' }),
        '**Rebuild of S finished:** 3 roles and 4 channels created, 0 failed. Next: `/backup restore server_id:9` to bring the members.');
    assert.equal(en.t('owner.test.exact', { action: 'ban', name: 'bob' }) + ` ${en.t('owner.test.note', { note: en.t('owner.test.noteWarn', { number: 1, threshold: 3 }) })}`,
        'The exact **ban** DM bob would get. Note: warn 1 of 3.');
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const status = [tr.t('owner.backup.statusStored', { stored: 99999 }), tr.t('owner.backup.statusInMain', { inGuild: 99999 }),
            tr.t('owner.backup.statusRunning', { done: 99999, total: 99999, guildId: GUILD }), '', tr.t('owner.backup.statusHelp')].join('\n');
        assert.ok(status.length <= 4096, `${lang} /backup status`);
        assert.ok(tr.t('owner.backup.rebuildStopped', { server: 'N'.repeat(100), error: 'e'.repeat(1900) }).slice(0, 2000).length <= 2000);
    }
});
