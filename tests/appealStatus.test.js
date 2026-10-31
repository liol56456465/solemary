// Appeal status updates (services/enforcement/appealStatusService.js): "I'm looking at it" is
// taken once and DMs the member without a staff name; a 2-day-old appeal gets one staff
// reminder and one DM; the dossier has the third button; the cron never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimAppeal, claimedDm, remindStaleAppeals, staleStaffLine, stillOpenDm } from '../src/services/enforcement/appealStatusService.js';
import { appealDecisionRow } from '../src/services/enforcement/appealService.js';

const client = (dms, channels = new Map()) => ({
    users: { fetch: async (id) => ({ send: async (p) => { if (id === 'closed') throw new Error('closed'); dms.push([id, p.content]); } }) },
    channels: { fetch: async (id) => channels.get(id) || null },
});

test('dossier buttons: Accept, Deny and "I\'m looking at it"', () => {
    const ids = appealDecisionRow('k7xq2').components.map((b) => b.data.custom_id);
    assert.deepEqual(ids, ['appealdecide:accept:k7xq2', 'appealdecide:deny:k7xq2', 'appealdecide:claim:k7xq2']);
});

test('claim: first click takes it and DMs the member (no staff name); later clicks say who has it', async () => {
    const dms = [];
    let claimed = null;
    const query = async (text, params) => {
        if (text.startsWith('UPDATE')) {
            if (claimed) return { rows: [] };
            claimed = params[2];
            return { rows: [{ user_id: 'member1', case_code: params[0] }] };
        }
        return { rows: [{ claimed_by_username: claimed }] };
    };
    const first = await claimAppeal({ client: client(dms), admin: { id: 'a1', username: 'Ann' }, caseCode: 'k7xq2', query });
    assert.deepEqual(first, { status: 'claimed', dmDelivered: true });
    assert.deepEqual(dms, [['member1', claimedDm('k7xq2')]]);
    assert.ok(!dms[0][1].includes('Ann'), 'the member is not told who');
    const second = await claimAppeal({ client: client(dms), admin: { id: 'a2', username: 'Bob' }, caseCode: 'k7xq2', query });
    assert.deepEqual(second, { status: 'already', by: 'Ann' });
    const none = await claimAppeal({ client: client(dms), admin: { id: 'a2', username: 'Bob' }, caseCode: 'zzzzz', query: async () => ({ rows: [] }) });
    assert.deepEqual(none, { status: 'none' });
});

test('stale appeals: one line in the staff channel and one DM each; errors never throw', async () => {
    const posted = [];
    const channels = new Map([['staff1', { send: async (p) => posted.push(p) }]]);
    const dms = [];
    const rows = [
        { case_code: 'aaaaa', user_id: 'm1', staff_channel_id: 'staff1', created_at: new Date(0), claimed_by_username: null },
        { case_code: 'bbbbb', user_id: 'closed', staff_channel_id: 'gone', created_at: new Date(0), claimed_by_username: 'Ann' },
    ];
    let cutoff = null;
    const n = await remindStaleAppeals(client(dms, channels), { now: 3 * 86400000, query: async (text, params) => { cutoff = params[0]; return { rows }; } });
    assert.equal(n, 2);
    assert.equal(cutoff.getTime(), 86400000, '2 days before now');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].content, staleStaffLine(rows[0]));
    assert.match(posted[0].content, /Nobody has taken it yet/);
    assert.match(staleStaffLine(rows[1]), /Ann said they're looking at it/);
    assert.deepEqual(posted[0].allowedMentions, { parse: [] });
    assert.deepEqual(dms, [['m1', stillOpenDm('aaaaa')]]);
    assert.equal(await remindStaleAppeals(client([]), { query: async () => { throw new Error('db down'); } }), 0);
});
