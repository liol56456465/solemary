// Automod batch F against the local test database (npm run test:db): settings
// writes, native AutoMod policies, probation lookups, per-rule undo stats.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db;
const runId = String(Date.now()).slice(-9);
// Not the main guild, so alerts and role syncs are no-ops.
const guildId = `8${runId}00000001`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
let codeSeq = 0;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const code = () => {
    let n = Number(runId) * 100 + 50 + (codeSeq += 1);
    let out = '';
    for (let i = 0; i < 7; i += 1) { out += ALPHA[n % ALPHA.length]; n = Math.floor(n / ALPHA.length); }
    return out;
};
const codes = [];

async function insertCase(fields) {
    const row = {
        guild_id: guildId, case_code: code(), target_user_id: user(1), target_username: 'target',
        moderator_id: user(90), moderator_username: 'mod', type: 'warn', name: null, reason: 'r',
        prebuilt_or_custom: 'prebuilt', ...fields,
    };
    row.name ??= `${row.case_code}-name`;
    codes.push(row.case_code);
    const keys = Object.keys(row);
    const { rows } = await pgDb.pool.query(
        `INSERT INTO mod_cases (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        keys.map((k) => row[k])
    );
    return rows[0];
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
});

after(async () => {
    if (skip) return;
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM automod_native_rules WHERE guild_id = $1', [guildId]);
    await db.delete(`automod:settings:${guildId}`).catch(() => {});
    await db.delete(`automod:probation:${guildId}:${user(5)}`).catch(() => {});
    await pgDb.disconnect();
});

test('settings: nested updates are row-locked and merged', { skip }, async () => {
    const { getAutomodSettings, updateAutomodSettings } = await import('../../src/services/automod/automodSettings.js');
    await Promise.all([
        updateAutomodSettings(guildId, (s) => ({ ...s, ruleModes: { ...s.ruleModes, caps: 'monitor' } })),
        updateAutomodSettings(guildId, (s) => ({ ...s, ruleModes: { ...s.ruleModes, english: 'off' } })),
    ]);
    const stored = await db.get(`automod:settings:${guildId}`);
    assert.deepEqual(stored.ruleModes, { caps: 'monitor', english: 'off' });
    const saved = await updateAutomodSettings(guildId, { secondChance: false });
    assert.equal(saved.secondChance, false);
    assert.deepEqual(saved.ruleModes, { caps: 'monitor', english: 'off' });
    assert.equal((await getAutomodSettings(guildId)).secondChance, false);
});

test('native policies: insert, update keeps dedupe unless given, cached load', { skip }, async () => {
    const { loadNativePolicies, setNativePolicy, resetNativeBridge } = await import('../../src/services/automod/nativeBridge.js');
    resetNativeBridge();
    assert.equal((await loadNativePolicies(guildId)).size, 0);
    assert.equal(await setNativePolicy(guildId, '111111111111111111', 'warn', null, user(90)), true);
    let rules = await loadNativePolicies(guildId);
    assert.deepEqual(rules.get('111111111111111111'), { policy: 'warn', dedupeMinutes: 10 });
    await setNativePolicy(guildId, '111111111111111111', 'log', 3, user(90));
    await setNativePolicy(guildId, '111111111111111111', 'ignore', null, user(90));
    rules = await loadNativePolicies(guildId);
    assert.deepEqual(rules.get('111111111111111111'), { policy: 'ignore', dedupeMinutes: 3 });
    await assert.rejects(setNativePolicy(guildId, '1', 'ban', null, user(90)));
});

test('probation lookup: recently ended ban, ignoring old ones; active ban reported', { skip }, async () => {
    const { findRecentBanEnd } = await import('../../src/services/automod/probationService.js');
    const DAY = 24 * 60 * 60 * 1000;
    assert.deepEqual(await findRecentBanEnd(guildId, user(5)), { endedBan: null, hasActiveBan: false });

    await insertCase({ type: 'ban', target_user_id: user(5), status: 'expired', expires_at: new Date(Date.now() - 40 * DAY), duration_ms: DAY });
    assert.equal((await findRecentBanEnd(guildId, user(5))).endedBan, null);

    const expired = await insertCase({ type: 'ban', target_user_id: user(5), status: 'expired', expires_at: new Date(Date.now() - 3 * DAY), duration_ms: DAY });
    let found = await findRecentBanEnd(guildId, user(5));
    assert.equal(found.endedBan.caseCode, expired.case_code);
    assert.equal(found.endedBan.how, 'expired');
    assert.equal(found.hasActiveBan, false);

    const appealed = await insertCase({
        type: 'ban', target_user_id: user(5), status: 'revoked', revoked_at: new Date(Date.now() - DAY),
        revoke_reason: 'Appeal accepted by x',
    });
    found = await findRecentBanEnd(guildId, user(5));
    assert.equal(found.endedBan.caseCode, appealed.case_code);
    assert.equal(found.endedBan.how, 'appeal accepted');

    await insertCase({ type: 'ban', target_user_id: user(5), status: 'active' });
    assert.equal((await findRecentBanEnd(guildId, user(5))).hasActiveBan, true);
});

test('probation record: start, read, end', { skip }, async () => {
    const { endProbation, getProbation, resetProbationCache, startProbation } = await import('../../src/services/automod/probationService.js');
    resetProbationCache();
    assert.equal(await getProbation(guildId, user(5)), null);
    const record = await startProbation(guildId, user(5), { caseCode: 'abc', how: 'expired' });
    resetProbationCache();
    const read = await getProbation(guildId, user(5));
    assert.equal(read.caseCode, 'abc');
    assert.equal(read.until, record.until);
    const ended = await endProbation(guildId, user(5));
    assert.equal(ended.caseCode, 'abc');
    resetProbationCache();
    assert.equal(await getProbation(guildId, user(5)), null);
});

test('dashboard lists: running probations (soonest end first) and saved removed staff roles', { skip }, async () => {
    const { endProbation, listProbations, resetProbationCache, startProbation } = await import('../../src/services/automod/probationService.js');
    const { listRemovedStaffRoles } = await import('../../src/services/automod/staffGuardService.js');
    resetProbationCache();
    assert.deepEqual(await listProbations(guildId), []);
    const later = await startProbation(guildId, user(6), { caseCode: 'late', how: 'expired' }, Date.now() + 5000);
    await startProbation(guildId, user(7), { caseCode: 'soon', how: 'lifted' });
    resetProbationCache();
    const listed = await listProbations(guildId);
    assert.deepEqual(listed.map((p) => p.userId), [user(7), user(6)]);
    assert.equal(listed[1].until, later.until);
    assert.equal(listed[0].caseCode, 'soon');
    await endProbation(guildId, user(7));
    assert.deepEqual((await listProbations(guildId)).map((p) => p.userId), [user(6)]);
    await endProbation(guildId, user(6));

    const key = (n) => `staffguard:removed:${guildId}:${user(n)}`;
    assert.deepEqual(await listRemovedStaffRoles(guildId), []);
    await db.set(key(8), { roleIds: ['1', '2'], reason: 'older', at: '2026-10-01T00:00:00.000Z' });
    await db.set(key(9), { roleIds: ['3'], reason: 'newer', at: '2026-10-02T00:00:00.000Z' });
    try {
        const removed = await listRemovedStaffRoles(guildId);
        assert.deepEqual(removed.map((r) => [r.userId, r.reason]), [[user(9), 'newer'], [user(8), 'older']]);
        assert.deepEqual(removed[1].roleIds, ['1', '2']);
    } finally {
        await db.delete(key(8));
        await db.delete(key(9));
    }
});

test('per-rule stats: caps and spam split within the spam group, undos counted', { skip }, async () => {
    const { automodRuleStats } = await import('../../src/services/automod/automodTuning.js');
    for (let i = 0; i < 4; i += 1) {
        await insertCase({ target_user_id: user(10 + i), reason: 'Automod: Excessive caps', reason_key: 'automod:spam',
            ...(i < 2 ? { status: 'revoked', revoke_reason: 'Automod decision reversed by a' } : {}) });
    }
    await insertCase({ target_user_id: user(20), reason: 'Automod: Excessive caps (changed by a)', reason_key: 'automod:spam',
        prebuilt_or_custom: 'custom', status: 'revoked', revoke_reason: 'Automod decision changed by b' });
    await insertCase({ target_user_id: user(21), reason: 'Automod: Spam', reason_key: 'automod:spam' });
    await insertCase({ target_user_id: user(22), reason: 'Automod: English only', reason_key: 'automod:english', is_test: true });
    const stats = await automodRuleStats(guildId, 14);
    assert.deepEqual(stats.caps, { actions: 5, undone: 2, changed: 1 });
    assert.deepEqual(stats.spam, { actions: 1, undone: 0, changed: 0 });
    assert.equal(stats.english, undefined);
});
