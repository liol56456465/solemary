// Bot i18n, part "case": /case, /background and /case search in 8 languages (namespace staff:
// case, background, caseSearch, caseStatus). English output unchanged, every service error code has
// a text, and the record / list / search embeds stay inside Discord's limits in the longest language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import { db as keyValueDb } from '../src/utils/database/wrapper.js';
import { caseStatusLabel } from '../src/services/enforcement/caseService.js';
import { tagsText } from '../src/services/enforcement/caseNotesService.js';
import { describeDuration, parseEditDuration } from '../src/services/enforcement/caseEditService.js';
import { evidenceLines } from '../src/services/enforcement/evidenceService.js';
import { setWatchlistCacheForTests, resetWatchlistCacheForTests, watchListDescription, watchlistLine } from '../src/services/enforcement/watchlistService.js';
import { normalizeSearchFilters } from '../src/services/enforcement/caseSearchService.js';
import { formatDuration, ladderStageShort } from '../src/services/enforcement/format.js';
import {
    buildRecordEmbed, buildRecordList, caseTypeText, durationText, ladderStageText,
} from '../src/handlers/backgroundView.js';
import { buildSearchView, describeSearchFilters, filtersFromMessage, searchResultLine } from '../src/handlers/caseSearchView.js';
import { CASE_SERVICE_ERROR_CODES, localizeServiceError } from '../src/commands/Enforcement/case.js';

const GUILD = '400000000000000004';
const USER = '400000000000000005';
const day = 24 * 3600 * 1000;

function row(over = {}) {
    return {
        id: 1, guild_id: GUILD, case_code: 'abc23k', name: 'Spam in general', type: 'ban', target_user_id: USER,
        target_username: 'member', moderator_id: '400000000000000006', moderator_username: 'mod', reason: 'Spam',
        prebuilt_or_custom: 'prebuilt', created_at: new Date('2026-11-01T00:00:00Z'), expires_at: new Date(Date.now() + 7 * day),
        duration_ms: String(7 * day), status: 'active', is_auto: false, is_imported: false, is_test: false, unappealable: false,
        appeal_deadline: null, ladder_level_after: 1, dm_delivered: true, end_dm_delivered: null, voided_at: null, tags: [],
        ...over,
    };
}

// ── English unchanged ──────────────────────────────────────────────────────

test('English output of the shared helpers is unchanged', () => {
    const en = botText('en');
    for (let level = 0; level <= 3; level += 1) assert.equal(ladderStageText(level, en), ladderStageShort(level));
    for (const ms of [60_000, 7 * day, 30 * day + 3_600_000]) assert.equal(durationText(ms, en), formatDuration(ms));
    assert.equal(describeDuration(null), 'Permanent');
    assert.equal(describeDuration(String(7 * day)), formatDuration(7 * day));
    assert.equal(tagsText([]), 'none');
    assert.equal(tagsText(['alt']), '#alt');
    assert.equal(caseStatusLabel(row({ voided_at: new Date() })), 'removed (a mistake)');
    assert.equal(caseStatusLabel(row({ voided_at: new Date() }), null, { lang: 'en' }), 'removed (a mistake)');
    assert.equal(describeSearchFilters({}), 'none (all cases)');
    assert.equal(describeSearchFilters({ type: 'ban', tag: 'alt', from: '2026-01-01' }), 'type **ban** · date **2026-01-01 → …** (UTC) · tag **#alt**');
    const dayStamp = `<t:${Math.floor(Date.UTC(2026, 10, 1) / 1000)}:d>`;
    assert.equal(searchResultLine(row({ is_test: true })), `\`abc23k\` **Spam in general** · ban (test) · member · by mod · ${dayStamp} · active`);
    assert.equal(watchListDescription([]), 'Nobody. Add someone with `/case watch add`.');
    const watch = { id: 5, reason: 'alt', createdAt: Date.now() - 3_600_000, until: null };
    assert.match(watchlistLine(watch), /^On watchlist since <t:\d+:R> — alt \(entry #5\)$/);
    const image = { id: 2, kind: 'image', added_by_username: 'mod', added_at: new Date(), store_channel_id: null };
    assert.match(evidenceLines([image])[0], /^\*\*#2\*\* Image: image \(stored message missing\) · mod, /);
});

test('the English catalog holds the code\'s English words', () => {
    const en = botText('en');
    for (const type of ['ban', 'kick', 'mute', 'warn']) assert.equal(caseTypeText(type, en), type);
    assert.equal(caseTypeText('nocontact', en), 'nocontact', 'unknown types are shown as stored');
    assert.equal(en.tp('staff.caseSearch.title', 1), 'Case search: 1 result');
    assert.equal(en.tp('staff.caseSearch.title', 3), 'Case search: 3 results');
    assert.equal(en.tp('staff.background.list.count', 2), '2 record(s), newest first. Use `name:` to open one in full.');
});

test('translated: German status, type, stage and duration words', () => {
    const de = botText('de');
    assert.equal(caseStatusLabel(row({ voided_at: new Date() }), null, { lang: 'de' }), 'entfernt (ein Fehler)');
    assert.equal(caseTypeText('ban', de), 'Bann');
    assert.equal(ladderStageText(3, de), '3 von 3 (dauerhafter Bann)');
    assert.equal(ladderStageText(1, de), '1 von 3 (7-Tage-Bann)');
    assert.equal(describeDuration(null, { lang: 'de' }), 'Dauerhaft');
    assert.equal(tagsText([], { lang: 'ru' }), 'нет');
});

// ── Service errors ─────────────────────────────────────────────────────────

test('every i18n code thrown by the case services has a text in /case', () => {
    const files = ['caseEditService', 'caseNotesService', 'caseSearchService', 'watchlistService', 'evidenceService'];
    const thrown = new Set();
    for (const file of files) {
        const text = readFileSync(new URL(`../src/services/enforcement/${file}.js`, import.meta.url), 'utf8');
        for (const m of text.matchAll(/\{ code: '([A-Za-z]+)'/g)) thrown.add(m[1]);
        for (const m of text.matchAll(/code: which === 'from' \? '(\w+)' : which === 'to' \? '(\w+)' : '(\w+)'/g)) [m[1], m[2], m[3]].forEach((c) => thrown.add(c));
    }
    assert.ok(thrown.size >= 30, `found ${thrown.size} codes`);
    for (const code of thrown) assert.ok(CASE_SERVICE_ERROR_CODES.includes(code), `no text for ${code}`);
});

test('a service error is shown in the reader\'s language; English stays as the service wrote it', () => {
    let error;
    try { parseEditDuration('soon'); } catch (e) { error = e; }
    assert.equal(error.i18n.code, 'badDuration');
    assert.equal(localizeServiceError(error, botText('en')).userMessage, error.userMessage);
    assert.match(localizeServiceError(error, botText('de')).userMessage, /^Die Dauer muss/);
    try { normalizeSearchFilters({ from: '2026-13-40' }); } catch (e) { error = e; }
    assert.equal(localizeServiceError(error, botText('en')).userMessage, error.userMessage);
    assert.match(localizeServiceError(error, botText('ru')).userMessage, /^`2026-13-40`/);
    const plain = new Error('x');
    assert.equal(localizeServiceError(plain, botText('de')), plain, 'unknown errors pass through');
    for (const lang of LANG_CODES) {
        for (const code of CASE_SERVICE_ERROR_CODES) {
            const fake = Object.assign(new Error('x'), { i18n: { code, params: { code: 'abc23k', type: 'warn', status: 'expired', tag: 't', max: 10, value: 'v', list: 'a, b', id: 3 } } });
            assert.ok(localizeServiceError(fake, botText(lang)).userMessage.length > 5, `${lang} ${code}`);
        }
    }
});

// ── Embed limits in the longest language ───────────────────────────────────

function installPool(cases, total) {
    const saved = { pool: pgDb.pool, connected: pgDb.isConnected };
    const answer = (text) => {
        const sql = String(text).replace(/\s+/g, ' ');
        if (/COUNT\(\*\) OVER\(\)/.test(sql)) return { rows: cases.map((c) => ({ ...c, total_count: String(total) })) };
        if (/COUNT\(\*\)::int AS count/.test(sql)) return { rows: [{ count: 4 }] };
        if (/kind = 'appeal' ORDER BY created_at DESC LIMIT 10/.test(sql)) {
            return { rows: Array.from({ length: 10 }, (_, i) => ({ status: 'denied', created_at: new Date(), decided_by_username: 'x'.repeat(32), note: `${'Note '.repeat(60)}${i}` })) };
        }
        return { rows: [], rowCount: 0 };
    };
    pgDb.pool = { query: async (t) => answer(t), connect: async () => ({ query: async (t) => answer(t), release() {} }) };
    pgDb.isConnected = true;
    return () => { pgDb.pool = saved.pool; pgDb.isConnected = saved.connected; };
}

const embedTotal = (e) => (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0)
    + (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);

function assertLimits(embed, where) {
    assert.ok((embed.title?.length || 0) <= 256, `${where}: title ${embed.title?.length}`);
    assert.ok((embed.description?.length || 0) <= 4096, `${where}: description ${embed.description?.length}`);
    assert.ok((embed.footer?.text?.length || 0) <= 2048, `${where}: footer`);
    for (const f of embed.fields || []) {
        assert.ok(f.name.length <= 256, `${where}: field name ${f.name.length}`);
        assert.ok(f.value.length <= 1024, `${where}: field ${f.name} ${f.value.length}`);
    }
    assert.ok(embedTotal(embed) <= 6000, `${where}: total ${embedTotal(embed)}`);
}

const LONG = row({
    name: 'N'.repeat(100), reason: 'R'.repeat(500), target_username: 'u'.repeat(32), moderator_username: 'm'.repeat(32),
    voided_at: new Date(), voided_by: '400000000000000007', void_reason: 'V'.repeat(500), end_dm_delivered: false,
    appeal_deadline: new Date(), is_auto: true, is_imported: true,
});

test('/background record view: within the embed limits in every language with long texts', async () => {
    const restore = installPool([], 0);
    try {
        let longest = 0;
        for (const lang of LANG_CODES) {
            const embed = (await buildRecordEmbed(LONG, { lang })).toJSON();
            assertLimits(embed, `record ${lang}`);
            longest = Math.max(longest, embed.description.length);
        }
        const en = (await buildRecordEmbed(row(), { lang: 'en' })).toJSON();
        assert.ok(en.description.startsWith('**Case code:** `abc23k`\n**Type:** ban\n**User:** member (`400000000000000005`)'), en.description);
        assert.ok(en.description.includes('**Warning stage after:** 1 of 3 (7-day ban)'));
        assert.ok(longest > 1000, 'the long case really is long');
    } finally {
        restore();
    }
});

test('/background list and /case search: within the embed limits in every language', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...LONG, id: i + 1, case_code: `abc2${i}k` }));
    const restore = installPool(many, 40);
    const savedKv = keyValueDb.db;
    const notes = Array.from({ length: 8 }, (_, i) => ({ id: i, content: 'C'.repeat(1000), type: 'warning', author: 'a'.repeat(32), timestamp: new Date().toISOString() }));
    keyValueDb.db = { get: async () => notes };
    setWatchlistCacheForTests([{ id: 9, guild_id: GUILD, user_id: USER, reason: 'W'.repeat(500), created_at: new Date(), until: new Date(Date.now() + day) }]);
    try {
        for (const lang of LANG_CODES) {
            const list = await buildRecordList(GUILD, '1', { id: USER, username: 'u'.repeat(32) }, 0, { lang });
            assertLimits(list.embeds[0].toJSON(), `list ${lang}`);
            for (const r of list.components) for (const c of r.toJSON().components) assert.ok(c.label.length <= 80, `${lang} button`);
            const filters = { memberId: USER, type: 'ban', text: 'x'.repeat(100), tag: 'alt', from: '2026-01-01', to: '2026-12-31' };
            const search = await buildSearchView(GUILD, '1', filters, 0, { lang });
            const embed = search.embeds[0].toJSON();
            assertLimits(embed, `search ${lang}`);
            assert.deepEqual(filtersFromMessage({ embeds: [embed] }), filters, `${lang}: the buttons still read the filters back`);
        }
    } finally {
        keyValueDb.db = savedKv;
        resetWatchlistCacheForTests();
        restore();
    }
});
