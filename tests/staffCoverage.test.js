import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    bucketByWeekdayHour, buildCoverageReport, renderGrid, safeTimeZone, shade, slotLabel, underCoveredSlots,
} = await import('../src/services/staffCoverageService.js');

// 2026-10-26 is a Monday.
const at = (iso, count = 1) => ({ hour: new Date(iso), count });

test('buckets by weekday and hour, in the given time zone', () => {
    const rows = [at('2026-10-26T03:00:00Z', 2), at('2026-11-01T23:00:00Z')];
    const utc = bucketByWeekdayHour(rows, 'UTC');
    assert.equal(utc[0][3], 2, 'Mon 03 UTC');
    assert.equal(utc[6][23], 1, 'Sun 23 UTC');

    const tokyo = bucketByWeekdayHour(rows, 'Asia/Tokyo'); // UTC+9
    assert.equal(tokyo[0][12], 2, 'Mon 12 in Tokyo');
    assert.equal(tokyo[0][8], 1, 'Sun 23 UTC is Mon 08 in Tokyo');

    assert.equal(safeTimeZone('Not/AZone'), 'UTC');
    assert.equal(safeTimeZone(null), 'UTC');
    assert.equal(safeTimeZone('Europe/Vilnius'), 'Europe/Vilnius');
});

test('shades: empty dot, then quarter steps to the max', () => {
    assert.equal(shade(0, 8), '·');
    assert.equal(shade(1, 8), '░');
    assert.equal(shade(4, 8), '▒');
    assert.equal(shade(6, 8), '▓');
    assert.equal(shade(8, 8), '█');
});

test('grid text: ruler plus 7 rows of 24 cells', () => {
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    grid[0][0] = 4;
    grid[2][12] = 1;
    const lines = renderGrid(grid).split('\n');
    assert.equal(lines.length, 8);
    assert.equal(lines[0], '    0     6     12    18');
    assert.equal(lines[1], `Mon █${'·'.repeat(23)}`);
    assert.equal(lines[3].slice(4 + 12, 4 + 13), '░');
    assert.ok(lines.slice(1).every((line) => [...line].length === 28));
});

test('under-covered: most incidents per staff action first', () => {
    const empty = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
    const incidents = empty();
    const staff = empty();
    incidents[5][3] = 6; // Sat 03, no staff
    incidents[1][20] = 10; staff[1][20] = 19; // busy but covered
    incidents[6][2] = 2; // Sun 02, no staff
    incidents[0][9] = 1; staff[0][9] = 0;
    const gaps = underCoveredSlots(incidents, staff);
    assert.deepEqual(gaps.map(slotLabel), ['Sat 03:00–04:00', 'Sun 02:00–03:00', 'Mon 09:00–10:00']);
    assert.equal(slotLabel({ day: 6, hour: 23 }), 'Sun 23:00–00:00');
});

test('report: totals, maxima, time zone fallback', () => {
    const report = buildCoverageReport({
        incidents: [at('2026-10-31T03:00:00Z', 3), at('2026-10-26T10:00:00Z')],
        staff: [at('2026-10-26T10:00:00Z')],
    }, 'Bad/Zone');
    assert.equal(report.timeZone, 'UTC');
    assert.equal(report.totalIncidents, 4);
    assert.equal(report.totalStaff, 1);
    assert.equal(report.maxIncidents, 3);
    assert.equal(slotLabel(report.gaps[0]), 'Sat 03:00–04:00');
});
