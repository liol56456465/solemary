// Paid perks that follow the server owner's plan: case export (CSV) and staff/automod analytics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { casesCsv, csvCell, exportCases, exportWindowDays } from '../src/services/enforcement/caseExport.js';
import { analyticsSection } from '../src/services/dashboard/activityPage.js';
import { staffAnalytics } from '../src/services/stats/activityService.js';

test('case export: Free none, Normal 90 days, Pro/Max everything; CSV is quoted and formula-safe', async () => {
    assert.equal(exportWindowDays('free'), null);
    assert.equal(exportWindowDays('normal'), 90);
    assert.equal(exportWindowDays('pro'), Infinity);
    assert.equal(exportWindowDays('max'), Infinity);
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('-1'), '"\'-1"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(['alt', 'scam']), '"alt scam"');
    const csv = casesCsv([{ case_code: 'aaaaa', created_at: new Date(0), type: 'warn', target_user_id: '1', target_username: 'a,b', moderator_username: '@mod', is_auto: false, reason: 'Spam "x"', tags: [] }]);
    assert.match(csv, /^case_code,created_at,type,/);
    assert.match(csv, /"a,b"/);
    assert.match(csv, /"'@mod"/);
    assert.match(csv, /"Spam ""x"""/);
    const now = Date.parse('2026-10-31T00:00:00Z');
    let since = null;
    const query = async (text, params) => { since = params[1]; assert.ok(text.includes('is_test IS NOT TRUE')); return { rows: [] }; };
    assert.equal(await exportCases('1', 'free', { query, now }), null);
    await exportCases('1', 'normal', { query, now });
    assert.equal(since.toISOString(), '2026-08-02T00:00:00.000Z');
    await exportCases('1', 'max', { query, now });
    assert.equal(since.getTime(), 0);
});

test('analytics: locked below Pro, error note, tables with rule names and undone share', async () => {
    assert.match(String(analyticsSection({ locked: true })), /come with Mewvo Pro and Max/);
    assert.match(String(analyticsSection({ analytics: null })), /could not be loaded/);
    const page = String(analyticsSection({ analytics: {
        moderators: [{ name: 'Ann<b>', total: 4, ban: 1, kick: 0, mute: 1, warn: 2, voided: 1 }],
        rules: [{ key: 'automod:caps', total: 10, undone: 4 }],
    } }));
    assert.ok(page.includes('Ann&lt;b&gt;'));
    assert.match(page, /Excessive caps<\/td><td>10<\/td><td>4<\/td><td>40%/);
    const texts = [];
    const res = await staffAnalytics('1', { query: async (text) => { texts.push(text); return { rows: [] }; } });
    assert.deepEqual(res, { moderators: [], rules: [] });
    assert.ok(texts.every((t) => t.includes('is_test IS NOT TRUE')));
});
