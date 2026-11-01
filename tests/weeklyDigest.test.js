// Weekly server digest (services/stats/weeklyDigest.js): real counts, busiest day, parts that
// fail say "unavailable" instead of 0, never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestData, digestFields } from '../src/services/stats/weeklyDigest.js';

const days = [
    { day: '2026-10-26', messages: 10, joins: 2, leaves: 0, cases: 0 },
    { day: '2026-10-27', messages: 50, joins: 1, leaves: 3, cases: 1 },
];

test('digest fields: members with the net change, messages with the busiest day, cases by type, appeals', () => {
    const fields = digestFields({
        days,
        cases: [{ type: 'ban', n: 1, auto: 0 }, { type: 'warn', n: 3, auto: 2 }],
        appeals: { filed: 2, accepted: 1, denied: 0, open: 1 },
    });
    const by = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    assert.equal(by.Members, '3 joined, 3 left (+0)');
    assert.equal(by.Messages, '60. Busiest day: Tuesday 27 Oct (50)');
    assert.equal(by.Cases, '4: 1 bans, 0 kicks, 0 mutes, 3 warns (2 automatic)');
    assert.equal(by.Appeals, '2 filed, 1 accepted, 0 denied. 1 still open.');
    const empty = Object.fromEntries(digestFields({ days: null, cases: null, appeals: null }).map((f) => [f.name, f.value]));
    assert.match(empty['Members and messages'], /unavailable/);
    assert.match(empty.Cases, /unavailable/);
    assert.match(empty.Appeals, /unavailable/);
});

test('digest data: one failing source is null, the others still come back', async () => {
    const query = async (text) => {
        if (text.includes('mod_cases')) throw new Error('db down');
        return { rows: [{ filed: 1, accepted: 0, denied: 0, open: 1 }] };
    };
    const data = await digestData('1', { query, series: async () => days });
    assert.equal(data.cases, null);
    assert.deepEqual(data.days, days);
    assert.equal(data.appeals.filed, 1);
});
