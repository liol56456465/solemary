import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildIncidentReport, formatReleaseResult, releaseRow, splitOffenders, summarizeCases,
} from '../../src/services/automod/raidIncidentService.js';

const cases = [
    { case_code: 'aaa1111', type: 'kick', target_user_id: 'u1', target_username: 'spam1' },
    { case_code: 'bbb2222', type: 'kick', target_user_id: 'u2', target_username: 'spam2' },
    { case_code: 'ccc3333', type: 'ban', target_user_id: 'u2', target_username: 'spam2' },
];

test('raid incident: offenders are joiners with a case', () => {
    const { offenders, clean } = splitOffenders(['u1', 'u2', 'u3', 'u4'], cases);
    assert.deepEqual([...offenders].sort(), ['u1', 'u2']);
    assert.deepEqual(clean, ['u3', 'u4']);
    assert.deepEqual(splitOffenders([], []).clean, []);
});

test('raid incident: cases are counted by type and listed', () => {
    assert.equal(summarizeCases([]), 'None');
    assert.equal(summarizeCases(cases), '2 kick, 1 ban: `aaa1111` kick spam1, `bbb2222` kick spam2, `ccc3333` ban spam2');
    const many = Array.from({ length: 20 }, (_, i) => ({ case_code: `c${i}`, type: 'kick', target_user_id: `u${i}`, target_username: `n${i}` }));
    assert.match(summarizeCases(many), /^20 kick: .* and 5 more$/);
});

test('raid incident: the report lists joiners (max 25) and what the bot did', () => {
    const joiners = Array.from({ length: 30 }, (_, i) => String(1000 + i));
    const report = buildIncidentReport({
        started_at: '2026-10-27T10:00:00Z',
        ended_at: '2026-10-27T12:30:00Z',
        joiner_ids: joiners,
        actions: {
            raisedVerification: true,
            incidentActions: { applied: true, until: '2026-10-27T12:00:00Z' },
            resumed: true,
            gateKicks: ['1001', '1002'],
        },
    }, cases, { endedByLabel: 'Bob' });
    assert.match(report.title, /incident report/);
    assert.match(report.description, /\*\*Triggered:\*\* <t:\d+:f> · \*\*ended:\*\* <t:\d+:f> by Bob \(\d/);
    assert.match(report.description, /\*\*Raid joiners:\*\* 30/);
    assert.equal((report.description.match(/<@\d+>/g) || []).length, 25);
    assert.match(report.description, /and 5 more/);
    const did = report.fields[0].value;
    assert.match(did, /raised to High → restored/);
    assert.match(did, /paused until <t:\d+:t> → resumed/);
    assert.match(did, /Join gate kicks:\*\* 2/);
    assert.match(did, /2 kick, 1 ban/);
});

test('raid incident: report without panic mode or cases', () => {
    const report = buildIncidentReport({ started_at: new Date(), ended_at: new Date(), joiner_ids: [], actions: {} }, []);
    assert.match(report.fields[0].value, /not changed/);
    assert.match(report.fields[0].value, /panic mode is off/);
    assert.match(report.fields[0].value, /raid joiners:\*\* None/);
});

test('raid incident: release result and button', () => {
    assert.equal(
        formatReleaseResult({ clean: 8, offenders: 2, probationEnded: 1, flagsCleared: 3, notInServer: 1 }),
        '**8** raid joiner(s) broke no rule; **2** with a case stay as they are.\nProbation ended: 1 · join-gate flags closed: 3 · no longer in the server: 1',
    );
    assert.match(formatReleaseResult({ clean: 3, offenders: 0, probationEnded: 0, flagsCleared: 0, notInServer: 0 }), /Nothing else was held/);
    const row = releaseRow(42, true).toJSON();
    assert.equal(row.components[0].custom_id, 'raidrelease:42');
    assert.equal(row.components[0].disabled, true);
});
