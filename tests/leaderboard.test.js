import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankLevelRows } from '../src/services/leveling/leveling.js';

const row = (userId, level, totalXp, xp = 0) => ({ userId, level, totalXp, xp });

test('leaderboard orders by level, then total XP, and drops empty rows', () => {
    const rows = [row('a', 2, 300), row('b', 5, 900), row('c', 2, 450), row('d', 0, 0), row('e', 0, 40)];
    const ranked = rankLevelRows(rows, 10, 0);
    assert.deepEqual(ranked.map(r => r.userId), ['b', 'c', 'a', 'e']);
    assert.deepEqual(ranked.map(r => r.rank), [1, 2, 3, 4]);
});

test('leaderboard pages keep absolute ranks', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`u${String(i).padStart(2, '0')}`, 25 - i, 1000 - i));
    const page2 = rankLevelRows(rows, 10, 10);
    assert.equal(page2.length, 10);
    assert.equal(page2[0].userId, 'u10');
    assert.equal(page2[0].rank, 11);
    assert.equal(rankLevelRows(rows, 10, 20).length, 5);
    assert.equal(rankLevelRows(rows, 10, 30).length, 0);
});
