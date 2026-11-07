// memberTimeline.js: merges joins/leaves, cases (+ lifted/voided), appeals and verification,
// newest first, capped; no /test cases (the SQL filters them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberTimeline } from '../src/services/members/memberTimeline.js';

test('timeline: merged, newest first, capped', async () => {
    const seen = [];
    const query = async (text, params) => {
        seen.push(text);
        if (text.includes('member_events')) return { rows: [{ kind: 'join', created_at: '2026-10-01T00:00:00Z' }] };
        if (text.includes('mod_cases')) return { rows: [{ case_code: 'aaaaa', type: 'ban', reason: 'Raid', moderator_username: 'Ann', created_at: '2026-10-02T00:00:00Z', revoked_at: '2026-10-05T00:00:00Z', voided_at: null, is_auto: false }] };
        if (text.includes('mod_appeals')) return { rows: [{ case_code: 'aaaaa', kind: 'appeal', status: 'accepted', created_at: '2026-10-03T00:00:00Z', decided_at: '2026-10-04T00:00:00Z', decided_by_username: 'Bob' }] };
        return { rows: [{ action: 'verified', created_at: '2026-09-30T00:00:00Z' }] };
    };
    const list = await memberTimeline('1', '2', { query });
    assert.deepEqual(list.map((e) => e.text), ['ban lifted early', 'Appeal accepted by Bob', 'Appeal filed', 'ban by Ann: Raid', 'Joined the server', 'Verification: verified']);
    assert.ok(seen.some((t) => t.includes('is_test IS NOT TRUE')));
    assert.equal((await memberTimeline('1', '2', { query, limit: 2 })).length, 2);
});

test('timeline: staff reports only when includeReports (administrators); moderators never see them', async () => {
    const params = [];
    const query = async (text, p) => {
        if (text.includes('mod_appeals')) { params.push(p); return { rows: [{ case_code: null, kind: 'report', status: 'pending', created_at: '2026-10-03T00:00:00Z', decided_at: null }] }; }
        return { rows: [] };
    };
    const forModerator = await memberTimeline('1', '2', { query });
    assert.deepEqual(forModerator, [], 'filtered even if the database returned it');
    assert.equal(params[0][3], false);
    const forAdmin = await memberTimeline('1', '2', { query, includeReports: true });
    assert.deepEqual(forAdmin.map((e) => e.text), ['Staff report filed']);
    assert.equal(params[1][3], true);
});
