// Case tags and staff notes (services/enforcement/caseNotesService.js) and the tag search filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaseNoteError, normalizeTags, tagsText } from '../src/services/enforcement/caseNotesService.js';
import { buildSearchWhere, decodeSearchFilters, encodeSearchFilters, normalizeSearchFilters } from '../src/services/enforcement/caseSearchService.js';
import { EXPORT_SECTIONS } from '../src/services/privacy/dataExport.js';
import { pgConfig } from '../src/config/database/postgres.js';

test('tags: lowercase, unique, sorted, letters/numbers/dashes, at most 10; "none" clears', () => {
    assert.deepEqual(normalizeTags('Scam, alt ,#raid alt'), ['alt', 'raid', 'scam']);
    assert.deepEqual(normalizeTags('none'), []);
    assert.deepEqual(normalizeTags(''), []);
    assert.throws(() => normalizeTags('ok, not ok!'), CaseNoteError);
    assert.throws(() => normalizeTags('x'.repeat(21)), /up to 20/);
    assert.throws(() => normalizeTags('a b c d e f g h i j k'), /at most 10/);
    assert.equal(tagsText(['alt', 'scam']), '#alt #scam');
    assert.equal(tagsText([]), 'none');
});

test('search: a tag filter becomes "= ANY(tags)" and survives the result-page token', () => {
    const filters = normalizeSearchFilters({ tag: '#Scam' });
    assert.deepEqual(filters, { tag: 'scam' });
    const { where, params } = buildSearchWhere('100000000000000001', filters);
    assert.match(where, /\$2 = ANY\(tags\)/);
    assert.equal(params[1], 'scam');
    assert.deepEqual(decodeSearchFilters(encodeSearchFilters(filters)), filters);
    assert.throws(() => normalizeSearchFilters({ tag: 'drop table' }));
});

test('tags stay staff-only; notes are exported only in caseNotes, without the author', () => {
    for (const [name, sql] of EXPORT_SECTIONS) {
        const text = sql(pgConfig.tables);
        const selected = text.slice(0, text.indexOf(' FROM '));
        assert.ok(!/\btags\b/.test(selected), `${name} selects tags`);
        if (name === 'caseNotes') {
            assert.ok(text.includes('mod_case_notes'));
            assert.ok(!selected.includes('author_id') && !selected.includes('author_username'), 'note author left out');
        } else {
            assert.ok(!text.includes('mod_case_notes'), `${name} reads notes`);
        }
    }
});
