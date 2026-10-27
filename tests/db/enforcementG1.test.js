// Enforcement batch G1 against the local test database (npm run test:db):
// end-of-punishment DMs, /case edit|void|history, /staff stats.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db;
const runId = String(Date.now()).slice(-9);
// Not the main guild, so mod-log posts and role syncs are no-ops.
const guildId = `7${runId}00000001`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const BOT_ID = `5${runId}00000000`;
let codeSeq = 0;
// Case codes: 7 chars from the case-code alphabet, unique per run.
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const code = () => {
    let n = Number(runId) * 100 + (codeSeq += 1);
    let out = '';
    for (let i = 0; i < 7; i += 1) { out += ALPHA[n % ALPHA.length]; n = Math.floor(n / ALPHA.length); }
    return out;
};
const codes = [];

async function insertCase(fields) {
    const row = {
        guild_id: guildId, case_code: code(), target_user_id: user(1), target_username: 'target',
        moderator_id: user(90), moderator_username: 'mod', type: 'warn', name: null, reason: 'r',
        prebuilt_or_custom: 'custom', ...fields,
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

function fakeWorld({ dmFails = false } = {}) {
    const dms = [];
    const unbans = [];
    const invites = [];
    const channel = { id: '1', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) };
    const guild = {
        id: guildId,
        members: {
            me: { permissions: { has: () => true } },
            unban: async (id) => { unbans.push(id); },
            fetch: async () => null,
        },
        bans: { fetch: async () => null },
        rulesChannel: channel,
        systemChannel: null,
        channels: { cache: new Map() },
        invites: { create: async () => { invites.push(1); return { url: `https://discord.gg/inv${invites.length}` }; } },
        roles: { cache: new Map() },
    };
    const client = {
        db,
        user: { id: BOT_ID, username: 'bot' },
        isReady: () => true,
        guilds: { cache: new Map([[guildId, guild]]), fetch: async () => null },
        users: {
            fetch: async (id) => ({
                id,
                send: async ({ content }) => {
                    if (dmFails) throw new Error('Cannot send messages to this user');
                    dms.push([id, content]);
                },
            }),
        },
    };
    guild.client = client;
    return { guild, client, dms, unbans, invites };
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
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM mod_case_edits WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM mod_ladder WHERE guild_id = $1', [guildId]);
    await pgDb.disconnect();
});

const endDm = async (id) => (await pgDb.pool.query('SELECT status, end_dm_delivered FROM mod_cases WHERE id = $1', [id])).rows[0];

// --- I30: "your ban/mute has ended" DMs -------------------------------------------

test('expiry: an expired temp ban is lifted, DMed once with a one-time invite, and recorded', { skip }, async () => {
    const { liftExpired } = await import('../../src/services/enforcement/expiryService.js');
    const { guild, client, dms, unbans, invites } = fakeWorld();
    const ban = await insertCase({ type: 'ban', target_user_id: user(2), duration_ms: 60000, expires_at: new Date(Date.now() - 1000) });

    await liftExpired(client, guild, ban);
    assert.deepEqual(unbans, [user(2)]);
    assert.equal(dms.length, 1);
    assert.match(dms[0][1], /ban from .* has ended/);
    assert.match(dms[0][1], /discord\.gg\/inv1/);
    assert.equal(invites.length, 1);
    assert.deepEqual(await endDm(ban.id), { status: 'expired', end_dm_delivered: true });

    // A second run on the same (now closed) row must not DM again.
    await liftExpired(client, guild, ban);
    assert.equal(dms.length, 1);
});

test('expiry: an undeliverable mute-ended DM is recorded as not delivered, no retry', { skip }, async () => {
    const { liftExpired } = await import('../../src/services/enforcement/expiryService.js');
    const { guild, client } = fakeWorld({ dmFails: true });
    const mute = await insertCase({ type: 'mute', target_user_id: user(3), duration_ms: 60000, expires_at: new Date(Date.now() - 1000) });
    await liftExpired(client, guild, mute);
    assert.deepEqual(await endDm(mute.id), { status: 'expired', end_dm_delivered: false });
});

test('expiry: test cases are closed without any DM', { skip }, async () => {
    const { liftExpired } = await import('../../src/services/enforcement/expiryService.js');
    const { guild, client, dms, unbans } = fakeWorld();
    const ban = await insertCase({ type: 'ban', target_user_id: user(4), duration_ms: 60000, expires_at: new Date(Date.now() - 1000), is_test: true });
    await liftExpired(client, guild, ban);
    assert.equal(dms.length, 0);
    assert.equal(unbans.length, 0);
    assert.deepEqual(await endDm(ban.id), { status: 'expired', end_dm_delivered: null });
});

test('early lift: notifyPunishmentEnded marks every lifted case', { skip }, async () => {
    const { notifyPunishmentEnded } = await import('../../src/services/enforcement/enforcementService.js');
    const { guild, client, dms } = fakeWorld();
    const a = await insertCase({ type: 'ban', target_user_id: user(5), status: 'revoked' });
    const b = await insertCase({ type: 'ban', target_user_id: user(5), status: 'revoked' });
    assert.equal(await notifyPunishmentEnded(client, guild, { type: 'ban', userId: user(5), records: [a, b], early: true }), true);
    assert.match(dms[0][1], /lifted it early/);
    assert.equal((await endDm(a.id)).end_dm_delivered, true);
    assert.equal((await endDm(b.id)).end_dm_delivered, true);
});
