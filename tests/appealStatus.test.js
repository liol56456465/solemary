// Appeal status updates (services/enforcement/appealStatusService.js): "I'm looking at it" is
// taken once and DMs the member without a staff name; a 2-day-old appeal gets one staff
// reminder and one DM; the dossier has the third button; the cron never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimAppeal, claimedDm, remindStaleAppeals, stillOpenDm } from '../src/services/enforcement/appealStatusService.js';
import { appealDecisionRow } from '../src/services/enforcement/appealService.js';
import { enforcementConfig } from '../src/config/enforcement.js';

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

test('stale appeals: one "still open" DM per appeal (staff get their own reminder elsewhere); errors never throw', async () => {
    const dms = [];
    const rows = [{ case_code: 'aaaaa', user_id: 'm1' }, { case_code: 'bbbbb', user_id: 'closed' }];
    let cutoff = null;
    const now = 100 * 86400000;
    const n = await remindStaleAppeals(client(dms), { now, query: async (text, params) => { cutoff = params[0]; return { rows }; } });
    assert.equal(n, 2);
    assert.equal(cutoff.getTime(), now - (enforcementConfig.staleAppealReminderMs || 2 * 86400000), 'the configured quiet time before now');
    assert.deepEqual(dms, [['m1', stillOpenDm('aaaaa')]]);
    assert.equal(await remindStaleAppeals(client([]), { query: async () => { throw new Error('db down'); } }), 0);
});
