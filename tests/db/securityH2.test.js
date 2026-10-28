// Batch H2 (security) against the local test database (npm run test:db): raid
// incidents (store, cases of raid joiners, release once), snapshot lookup before a
// time, join-gate flags and panic settings in the key-value store.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db;
const runId = String(Date.now()).slice(-9);
// Not the main guild, so alerts are no-ops.
const guildId = `7${runId}00000002`;
const user = (n) => `5${runId}${String(n).padStart(8, '0')}`;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
let codeSeq = 0;
const code = () => {
    let n = Number(runId) * 100 + 70 + (codeSeq += 1);
    let out = '';
    for (let i = 0; i < 7; i += 1) { out += ALPHA[n % ALPHA.length]; n = Math.floor(n / ALPHA.length); }
    return out;
};
const codes = [];

async function insertCase(fields) {
    const row = {
        guild_id: guildId, case_code: code(), target_user_id: user(1), target_username: 'target',
        moderator_id: user(90), moderator_username: 'mod', type: 'kick', name: null, reason: 'r',
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
    await pgDb.pool.query('DELETE FROM automod_raid_incidents WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM server_snapshots WHERE guild_id = $1', [guildId]);
    await db.delete(`automod:settings:${guildId}`).catch(() => {});
    await db.delete(`automod:joingate:flag:${guildId}:${user(3)}`).catch(() => {});
    await db.delete(`guild:${guildId}:config`).catch(() => {});
    await pgDb.disconnect();
});

test('raid incidents: stored, cases of raid joiners found, released only once', { skip }, async () => {
    const svc = await import('../../src/services/automod/raidIncidentService.js');
    const startedAt = new Date(Date.now() - 60 * 60 * 1000);
    const joiners = [user(1), user(2), user(3)];

    await insertCase({ target_user_id: user(1), created_at: new Date(Date.now() - 2 * 60 * 60 * 1000) }); // before the raid
    const during = await insertCase({ target_user_id: user(2), type: 'kick' });
    await insertCase({ target_user_id: user(3), type: 'warn', voided_at: new Date() }); // voided: not an offence
    await insertCase({ target_user_id: user(4), type: 'ban' }); // not a raid joiner

    const incident = await svc.createIncident({
        guildId, startedAt, endedBy: user(90), joinerIds: joiners,
        actions: { raisedVerification: true, incidentActions: { applied: true, until: new Date().toISOString() }, gateKicks: [user(9)] },
    });
    assert.ok(incident.id);
    assert.deepEqual(incident.joiner_ids, joiners);
    assert.equal(incident.actions.raisedVerification, true);
    assert.equal(incident.released_at, null);

    const cases = await svc.casesAgainst(guildId, joiners, startedAt);
    assert.deepEqual(cases.map((c) => c.case_code), [during.case_code]);
    const { clean } = svc.splitOffenders(joiners, cases);
    assert.deepEqual(clean, [user(1), user(3)]);
    assert.deepEqual(await svc.casesAgainst(guildId, [], startedAt), []);

    const [first, second] = await Promise.all([svc.claimRelease(incident.id, user(91)), svc.claimRelease(incident.id, user(92))]);
    assert.equal([first, second].filter(Boolean).length, 1, 'exactly one admin wins the release');
    assert.equal(await svc.saveReleaseResult(incident.id, { clean: 2 }), true);
    const stored = await svc.getIncident(incident.id);
    assert.ok(stored.released_at);
    assert.deepEqual(stored.release_result, { clean: 2 });
    assert.equal(await svc.getIncident('999999999999'), null);
});

test('snapshots: the newest one before a time', { skip }, async () => {
    const { getSnapshotBefore } = await import('../../src/services/structureBackupService.js');
    const insert = (createdAt, summary) => pgDb.pool.query(
        `INSERT INTO server_snapshots (guild_id, created_at, summary, data) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`,
        [guildId, createdAt, summary]
    );
    const now = Date.now();
    await insert(new Date(now - 3 * 86400000), 'old');
    await insert(new Date(now - 86400000), 'yesterday');
    await insert(new Date(now - 1000), 'after the nuke');
    const before = await getSnapshotBefore(guildId, new Date(now - 60 * 1000));
    assert.equal(before.summary, 'yesterday');
    assert.equal(await getSnapshotBefore(guildId, new Date(now - 10 * 86400000)), null);
});

test('automod settings: panic and join gate saved under the row lock', { skip }, async () => {
    const { updateAutomodSettings, getAutomodSettings } = await import('../../src/services/automod/automodSettings.js');
    const { normalizeJoinGate } = await import('../../src/services/automod/joinGate.js');
    await Promise.all([
        updateAutomodSettings(guildId, (c) => ({ ...c, panic: { enabled: false, hours: 5 } })),
        updateAutomodSettings(guildId, (c) => ({ ...c, joinGate: { ...normalizeJoinGate(c.joinGate), avatar: 'kick' } })),
        updateAutomodSettings(guildId, (c) => ({ ...c, joinGate: { ...normalizeJoinGate(c.joinGate), age: 'flag', ageDays: 3 } })),
    ]);
    const stored = await db.get(`automod:settings:${guildId}`);
    assert.deepEqual(stored.panic, { enabled: false, hours: 5 });
    assert.equal(stored.joinGate.avatar, 'kick');
    assert.equal(stored.joinGate.age, 'flag');
    assert.equal(stored.joinGate.ageDays, 3);
    assert.ok(await getAutomodSettings(guildId));
});

test('logging ignore lists: concurrent toggles of channels and roles are all kept', { skip }, async () => {
    const { updateIgnoreList, getIgnoreList } = await import('../../src/services/loggingService.js');
    const { getGuildConfig } = await import('../../src/services/config/guildConfig.js');
    const client = { db };
    const results = [{}, {}, {}];
    const oks = await Promise.all([
        updateIgnoreList(client, guildId, { action: 'toggle', type: 'channel', id: '111' }, results[0]),
        updateIgnoreList(client, guildId, { action: 'toggle', type: 'role', id: '222' }, results[1]),
        updateIgnoreList(client, guildId, { action: 'add', type: 'role', id: '333' }, results[2]),
    ]);
    assert.deepEqual(oks, [true, true, true]);
    assert.equal(results[0].added, true);
    let ignore = getIgnoreList(await getGuildConfig(client, guildId));
    assert.deepEqual(ignore.channels, ['111']);
    assert.deepEqual([...ignore.roles].sort(), ['222', '333']);

    const again = {};
    await updateIgnoreList(client, guildId, { action: 'toggle', type: 'role', id: '222' }, again);
    assert.equal(again.added, false);
    ignore = getIgnoreList(await getGuildConfig(client, guildId));
    assert.deepEqual(ignore.roles, ['333']);
    assert.equal(await updateIgnoreList(client, guildId, { action: 'add', type: 'bogus', id: '1' }), false);
});

test('join gate flags: stored with a TTL and cleared', { skip }, async () => {
    const { getGateFlag, clearGateFlag } = await import('../../src/services/automod/joinGate.js');
    const { setInDb } = await import('../../src/utils/database.js');
    await setInDb(`automod:joingate:flag:${guildId}:${user(3)}`, { channelId: '1', messageId: '2', hits: [{ check: 'avatar', reason: 'no profile picture' }] }, 3600);
    assert.equal((await getGateFlag(guildId, user(3))).hits[0].check, 'avatar');
    await clearGateFlag(guildId, user(3));
    assert.equal(await getGateFlag(guildId, user(3)), null);
});
