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

// --- I31: /case edit | void | history ----------------------------------------------

test('case edit: reason and duration change with history; ladder bans and closed cases are refused', { skip }, async () => {
    const { editCase, getCaseEdits } = await import('../../src/services/enforcement/caseEditService.js');
    const editor = { id: user(91), username: 'editor' };
    const created = new Date(Date.now() - 2 * 3600 * 1000);
    const ban = await insertCase({ type: 'ban', target_user_id: user(10), duration_ms: 3600 * 1000, created_at: created, expires_at: new Date(created.getTime() + 3600 * 1000 * 5) });

    const { after, changes } = await editCase(null, { guildId, caseCode: ban.case_code, editor, reason: 'better reason', durationMs: 24 * 3600 * 1000 });
    assert.equal(after.reason, 'better reason');
    assert.equal(Number(after.duration_ms), 24 * 3600 * 1000);
    assert.equal(new Date(after.expires_at).getTime(), created.getTime() + 24 * 3600 * 1000, 'end = created_at + duration');
    assert.deepEqual(changes.map((c) => c.field), ['reason', 'duration']);

    await editCase(null, { guildId, caseCode: ban.case_code, editor, durationMs: null });
    const { rows: [perm] } = await pgDb.pool.query('SELECT expires_at, duration_ms FROM mod_cases WHERE id = $1', [ban.id]);
    assert.deepEqual({ ...perm }, { expires_at: null, duration_ms: null });

    const edits = await getCaseEdits(ban.case_code);
    assert.equal(edits.length, 3);
    assert.deepEqual(edits.map((e) => e.field).sort(), ['duration', 'duration', 'reason']);
    const reasonEdit = edits.find((e) => e.field === 'reason');
    assert.deepEqual([reasonEdit.old_value, reasonEdit.new_value, reasonEdit.edited_by], ['r', 'better reason', editor.id]);

    const auto = await insertCase({ type: 'ban', target_user_id: user(10), is_auto: true, duration_ms: 1000, expires_at: new Date(Date.now() + 60000) });
    await assert.rejects(editCase(null, { guildId, caseCode: auto.case_code, editor, durationMs: 60000 }), /ladder/);
    const imported = await insertCase({ type: 'mute', target_user_id: user(10), is_imported: true, duration_ms: 1000, expires_at: new Date(Date.now() + 60000) });
    await assert.rejects(editCase(null, { guildId, caseCode: imported.case_code, editor, durationMs: 60000 }), /Imported/);
    const expired = await insertCase({ type: 'mute', target_user_id: user(10), status: 'expired', duration_ms: 1000 });
    await assert.rejects(editCase(null, { guildId, caseCode: expired.case_code, editor, durationMs: 60000 }), /already ended/);
    const warn = await insertCase({ type: 'warn', target_user_id: user(10) });
    await assert.rejects(editCase(null, { guildId, caseCode: warn.case_code, editor, durationMs: 60000 }), /Only bans and mutes/);
    await assert.rejects(editCase(null, { guildId, caseCode: warn.case_code, editor, reason: 'r' }), /Nothing to change/);
    await assert.rejects(editCase(null, { guildId: `${guildId.slice(0, -1)}9`, caseCode: warn.case_code, editor, reason: 'x' }), /No case/);
    // The reason of an automatic ban can still be fixed.
    await editCase(null, { guildId, caseCode: auto.case_code, editor, reason: 'typo fixed' });
});

test('case void: an active warn is revoked, the ladder count drops, the user is DMed, the case shows voided', { skip }, async () => {
    const { voidCase, editCase } = await import('../../src/services/enforcement/caseEditService.js');
    const { caseStatusLabel } = await import('../../src/services/enforcement/caseService.js');
    const { client, dms } = fakeWorld();
    const target = user(20);
    await pgDb.pool.query('INSERT INTO mod_ladder (guild_id, user_id, level, warns_since_level) VALUES ($1, $2, 0, 2)', [guildId, target]);
    await insertCase({ type: 'warn', target_user_id: target, counts_toward_level: 0, ladder_level_after: 0 });
    const warn = await insertCase({ type: 'warn', target_user_id: target, counts_toward_level: 0, ladder_level_after: 0 });

    const admin = { id: user(92), username: 'admin' };
    const { record, dmDelivered } = await voidCase(client, { guildId, caseCode: warn.case_code, admin, reason: 'wrong person' });
    assert.equal(record.status, 'revoked');
    assert.ok(record.voided_at);
    assert.equal(record.voided_by, admin.id);
    assert.equal(record.void_reason, 'wrong person');
    assert.equal(caseStatusLabel(record), 'voided');
    assert.equal(dmDelivered, true);
    assert.match(dms.at(-1)[1], /was voided/);
    const { rows: [ladder] } = await pgDb.pool.query('SELECT warns_since_level FROM mod_ladder WHERE guild_id = $1 AND user_id = $2', [guildId, target]);
    assert.equal(ladder.warns_since_level, 1);
    await assert.rejects(voidCase(client, { guildId, caseCode: warn.case_code, admin, reason: 'again' }), /already voided/);
    await assert.rejects(editCase(null, { guildId, caseCode: warn.case_code, editor: admin, reason: 'x' }), /voided/);
});

test('case void: an active ban is unbanned with an invite and its end DM recorded', { skip }, async () => {
    const { voidCase } = await import('../../src/services/enforcement/caseEditService.js');
    const world = fakeWorld();
    const target = user(21);
    const banned = new Set([target]);
    world.guild.bans.fetch = async ({ user: id }) => (banned.has(id) ? { user: { id } } : null);
    world.guild.members.unban = async (id) => { banned.delete(id); world.unbans.push(id); };
    const ban = await insertCase({ type: 'ban', target_user_id: target, duration_ms: 3600000, expires_at: new Date(Date.now() + 3600000) });

    const { notes } = await voidCase(world.client, { guildId, caseCode: ban.case_code, admin: { id: user(92), username: 'admin' }, reason: 'mistake' });
    assert.deepEqual(world.unbans, [target]);
    assert.ok(notes.some((n) => /unbanned/.test(n)));
    assert.match(world.dms.at(-1)[1], /Rejoin: https:\/\/discord\.gg\/inv/);
    assert.equal((await endDm(ban.id)).end_dm_delivered, true);
});

test('case void: an expired case is only marked, nothing is lifted', { skip }, async () => {
    const { voidCase } = await import('../../src/services/enforcement/caseEditService.js');
    const world = fakeWorld();
    const mute = await insertCase({ type: 'mute', target_user_id: user(22), status: 'expired', duration_ms: 1000 });
    const { record, notes } = await voidCase(world.client, { guildId, caseCode: mute.case_code, admin: { id: user(92), username: 'admin' }, reason: 'dup' });
    assert.ok(record.voided_at);
    assert.ok(notes.some((n) => /already ended/.test(n)));
    assert.equal(world.unbans.length, 0);
});

test('case autocomplete matches code, name and username in this guild only', { skip }, async () => {
    const { searchCases } = await import('../../src/services/enforcement/caseEditService.js');
    const row = await insertCase({ type: 'kick', target_user_id: user(23), target_username: `zz${runId}` });
    assert.ok((await searchCases(guildId, row.case_code)).some((r) => r.case_code === row.case_code));
    assert.ok((await searchCases(guildId, `zz${runId}`)).some((r) => r.case_code === row.case_code));
    assert.equal((await searchCases(`${guildId.slice(0, -1)}9`, row.case_code)).length, 0);
});

// --- I36: /staff stats -------------------------------------------------------------

test('staff stats: actions by type per moderator, voided apart, appeals on their cases, bot and test cases left out', { skip }, async () => {
    const { staffModerationStats } = await import('../../src/services/staffActivityService.js');
    const modA = user(80);
    const modB = user(81);
    const t = user(30);
    const by = (id, name) => ({ moderator_id: id, moderator_username: name, target_user_id: t });
    await insertCase({ type: 'ban', ...by(modA, 'aaa') });
    const appealed = await insertCase({ type: 'warn', ...by(modA, 'aaa') });
    const denied = await insertCase({ type: 'warn', ...by(modA, 'aaa') });
    await insertCase({ type: 'mute', ...by(modA, 'aaa'), status: 'revoked', voided_at: new Date() });
    await insertCase({ type: 'kick', ...by(modA, 'aaa'), is_test: true });
    await insertCase({ type: 'kick', ...by(modA, 'aaa'), created_at: new Date(Date.now() - 40 * 86400000) });
    await insertCase({ type: 'ban', ...by(BOT_ID, 'bot') });
    await insertCase({ type: 'kick', ...by(modB, 'bbb') });
    await pgDb.pool.query(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, status, decided_at) VALUES
        ('appeal', $1, $3, 't', $4, 'accepted', NOW()), ('appeal', $2, $3, 't', $4, 'denied', NOW())`,
    [appealed.case_code, denied.case_code, t, guildId]);

    // Earlier tests in this guild used other moderators; look at these two only.
    const all30 = await staffModerationStats(guildId, BOT_ID, { period: '30d' });
    assert.ok(!all30.some((r) => r.moderatorId === BOT_ID), 'the bot is left out');
    const rows = all30.filter((r) => r.moderatorId === modA || r.moderatorId === modB);
    assert.deepEqual(rows.map((r) => r.moderatorId), [modA, modB], 'sorted by actions');
    const a = rows[0];
    assert.deepEqual(a.actions, { ban: 1, kick: 0, mute: 0, warn: 2 });
    assert.equal(a.total, 3);
    assert.equal(a.voided, 1);
    assert.equal(a.appealsAccepted, 1);
    assert.equal(a.appealsDenied, 1);

    const all = await staffModerationStats(guildId, BOT_ID, { period: 'all', moderatorId: modA });
    assert.equal(all.length, 1);
    assert.equal(all[0].actions.kick, 1, 'the 40-day-old kick counts for all time');
});

test('staff activity: voided cases are not counted as actions', { skip }, async () => {
    const { staffActivityForWeek, weekStart } = await import('../../src/services/staffActivityService.js');
    const mod = user(82);
    await insertCase({ type: 'warn', moderator_id: mod, moderator_username: 'ccc' });
    await insertCase({ type: 'warn', moderator_id: mod, moderator_username: 'ccc', status: 'revoked', voided_at: new Date() });
    const guild = { id: guildId, ownerId: mod, client: { user: { id: BOT_ID } }, members: { cache: new Map() } };
    guild.members.cache.set(mod, { id: mod, guild, user: { bot: false, username: 'ccc' }, permissions: { has: () => true } });
    const rows = await staffActivityForWeek(guild, weekStart());
    assert.equal(rows.find((r) => r.userId === mod).actions, 1);
});
