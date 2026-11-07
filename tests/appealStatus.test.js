// Appeal status updates (services/enforcement/appealStatusService.js): "I'm looking at it" is
// taken once and DMs the member without a staff name; a 2-day-old appeal gets one staff
// reminder and one DM; the dossier has the third button; the cron never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimAppeal, claimedDm, remindStaleAppeals, staleAfter, stillOpenDm } from '../src/services/enforcement/appealStatusService.js';
import { appealDecisionRow } from '../src/services/enforcement/appealService.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';

const HOME = '100000000000000001';
const OTHER = '100000000000000009';
const UNKNOWN = '100000000000000010';

/** A query stand-in: the guild list first, then one UPDATE per guild (records [guildId, cutoff ms]). */
const fakeQuery = (guildIds, rowsByGuild, cutoffs) => async (text, params) => {
    if (text.trimStart().startsWith('SELECT DISTINCT')) return { rows: guildIds.map((guild_id) => ({ guild_id })) };
    cutoffs.push([params[1], params[0].getTime()]);
    return { rows: rowsByGuild[params[1]] || [] };
};

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
    const cutoffs = [];
    const now = 100 * 86400000;
    const saved = process.env.MAIN_GUILD_ID;
    process.env.MAIN_GUILD_ID = HOME;
    try {
        const n = await remindStaleAppeals(client(dms), { now, query: fakeQuery([HOME], { [HOME]: rows }, cutoffs) });
        assert.equal(n, 2);
        assert.deepEqual(cutoffs, [[HOME, now - (enforcementConfig.staleAppealReminderMs || 2 * 86400000)]], 'the configured quiet time before now');
    } finally {
        if (saved === undefined) delete process.env.MAIN_GUILD_ID; else process.env.MAIN_GUILD_ID = saved;
    }
    assert.deepEqual(dms, [['m1', stillOpenDm('aaaaa')]]);
    assert.equal(await remindStaleAppeals(client([]), { query: async () => { throw new Error('db down'); } }), 0);
});

test('stale appeals: each non-home server uses its own quiet time; one whose settings are unknown is skipped', async () => {
    const dms = [];
    const cutoffs = [];
    const now = 100 * 86400000;
    try {
        setSettingsCacheForTests(OTHER, { staleAppealReminderMs: 5 * 86400000 });
        // UNKNOWN: never read (database down at boot) → SettingsUnavailableError → skipped, no DM.
        const n = await remindStaleAppeals(client(dms), {
            now,
            query: fakeQuery([UNKNOWN, OTHER], { [OTHER]: [{ case_code: 'ccccc', user_id: 'm3' }], [UNKNOWN]: [{ case_code: 'ddddd', user_id: 'm4' }] }, cutoffs),
        });
        assert.equal(n, 1);
        assert.deepEqual(cutoffs, [[OTHER, now - 5 * 86400000]], 'only the readable server, with its own 5 days');
        assert.deepEqual(dms, [['m3', stillOpenDm('ccccc')]]);
        assert.equal(staleAfter(OTHER), 5 * 86400000);
        setSettingsCacheForTests(OTHER, {});
        assert.equal(staleAfter(OTHER), 3 * 86400000, 'nothing stored: the generic default (not env, not the main server)');
    } finally {
        setSettingsCacheForTests(OTHER, null);
    }
});
