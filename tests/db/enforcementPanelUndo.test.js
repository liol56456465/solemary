// The panel's undo of a mistaken ladder ban against the local test database (npm run test:db),
// beginner audit 2026-11-09 item 1.2: three real warns through executeAction trigger the automatic
// ladder ban; then
//   - "Mistake? Remove the warn" (voidCase on the 3rd warn) lifts the ban and steps the ladder back,
//   - "Remove the warn (stage goes back)" (voidCase on the ladder ban) does the same,
//   - "Unban only (stage stays)" (the plain unban) lifts the ban and keeps the stage.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isLocalDatabaseUrl } from '../helpers/localDb.js';

const url = process.env.POSTGRES_URL || '';
const isLocal = isLocalDatabaseUrl(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, enforcement, caseEdit;
const runId = String(Date.now()).slice(-9);
// Not a home server of the bot config, so mod-log posts and role syncs are no-ops.
const guildId = `8${runId}00000011`;
const user = (n) => `6${runId}${String(n).padStart(8, '0')}`;
const BOT_ID = `5${runId}00000011`;
// One moderator per scenario: three ladder bans by one moderator would near the mass-action limit.
const ADMINS = [user(1), user(2), user(3)];

function fakeWorld() {
    const dms = [];
    const banned = new Set();
    const unbans = [];
    const guild = { id: guildId, ownerId: user(99), name: 'Undo test guild' };
    const role = (name, position) => ({ id: `7${runId}${String(position).padStart(8, '0')}`, name, position });
    const member = (id, position, admin = false) => ({
        id, guild, nickname: null, joinedAt: new Date(),
        user: { id, username: `user${id.slice(-3)}`, tag: `user${id.slice(-3)}` },
        permissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator },
        roles: { highest: role(admin ? 'Admin' : 'Member', position), cache: new Map() },
    });
    const members = new Map();
    const channel = { id: '1', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) };
    guild.members = {
        me: { id: BOT_ID, guild, permissions: { has: () => true }, roles: { highest: role('Bot', 100) } },
        cache: members,
        fetch: async (arg) => members.get(typeof arg === 'string' ? arg : arg?.user) || null,
        ban: async (id) => { banned.add(id); members.delete(id); },
        unban: async (id) => { unbans.push(id); banned.delete(id); },
    };
    guild.bans = { fetch: async ({ user: id }) => (banned.has(id) ? { user: { id } } : null) };
    guild.roles = { cache: new Map(), fetch: async () => null };
    guild.channels = { cache: new Map(), fetch: async () => null };
    guild.rulesChannel = channel;
    guild.systemChannel = null;
    guild.invites = { create: async () => ({ url: 'https://discord.gg/back' }) };
    const client = {
        db,
        user: { id: BOT_ID, username: 'bot' },
        isReady: () => true,
        guilds: { cache: new Map([[guildId, guild]]), fetch: async () => null },
        users: {
            cache: new Map(),
            fetch: async (id) => ({
                id, username: `user${id.slice(-3)}`, createdAt: new Date('2020-01-01'), bot: false,
                displayAvatarURL: () => null,
                send: async ({ content }) => { dms.push([id, content]); },
            }),
        },
    };
    guild.client = client;
    for (const id of ADMINS) members.set(id, member(id, 50, true));
    return { guild, client, dms, banned, unbans, addMember: (id) => members.set(id, member(id, 1)) };
}

const ladderOf = async (target) => {
    const { rows: [row] } = await pgDb.pool.query('SELECT level, warns_since_level FROM mod_ladder WHERE guild_id = $1 AND user_id = $2', [guildId, target]);
    return { ...row };
};
const caseRow = async (code) => (await pgDb.pool.query('SELECT status, voided_at FROM mod_cases WHERE case_code = $1', [code])).rows[0];

/** Three warns through executeAction (the panel's Confirm): the third triggers the 7-day ladder ban. */
async function threeWarns(world, target, adminId) {
    world.addMember(target);
    const moderator = await world.guild.members.fetch(adminId);
    const targetUser = await world.client.users.fetch(target);
    let last;
    for (let i = 1; i <= 3; i += 1) {
        last = await enforcement.executeAction({
            guild: world.guild, moderator, targetUser,
            flow: { type: 'warn', moderatorId: adminId, targetId: target, targetUsername: targetUser.username, reasonKey: 'spam', reasonSource: 'prebuilt', reason: 'Spam', nameIsDefault: true },
        });
    }
    assert.ok(last.banRecord, 'the third warn triggered the automatic ban');
    assert.ok(world.banned.has(target));
    assert.deepEqual(await ladderOf(target), { level: 1, warns_since_level: 0 });
    return { warn: last.record, ban: last.banRecord, moderator, targetUser };
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    const { refreshGuildSettings } = await import('../../src/services/settings/guildSettings.js');
    await refreshGuildSettings(guildId);
    enforcement = await import('../../src/services/enforcement/enforcementService.js');
    caseEdit = await import('../../src/services/enforcement/caseEditService.js');
});

after(async () => {
    if (skip) return;
    const { rows } = await pgDb.pool.query('SELECT case_code FROM mod_cases WHERE guild_id = $1', [guildId]);
    const codes = rows.map((r) => r.case_code);
    await pgDb.pool.query('DELETE FROM mod_case_evidence WHERE case_code = ANY($1)', [codes]).catch(() => {});
    await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]);
    await pgDb.pool.query('DELETE FROM mod_cases WHERE guild_id = $1', [guildId]);
    await pgDb.pool.query('DELETE FROM mod_ladder WHERE guild_id = $1', [guildId]);
    await pgDb.disconnect();
});

test('"Mistake? Remove the warn" on the result card: the warn is voided, the ladder ban lifted, the stage back to 0 with 2 warns, DM with an invite', { skip }, async () => {
    const world = fakeWorld();
    const target = user(11);
    const { warn, ban } = await threeWarns(world, target, ADMINS[0]);
    world.dms.length = 0;

    const result = await caseEdit.voidCase(world.client, { guildId, caseCode: warn.case_code, admin: { id: ADMINS[0], username: 'admin' }, reason: 'Mistake: undone from the /enforcements panel' });
    assert.ok(result.record.voided_at, 'the warn is removed (a mistake)');
    assert.equal(world.banned.has(target), false, 'unbanned');
    assert.deepEqual(await ladderOf(target), { level: 0, warns_since_level: 2 }, 'stage back, the other two warns still count');
    assert.equal((await caseRow(ban.case_code)).status, 'revoked', 'the automatic ban is lifted');
    assert.equal(result.dmDelivered, true);
    assert.equal(world.dms.length, 1);
    assert.match(world.dms[0][1], /discord\.gg\/back/, 'the DM carries an invite back');
    // Their next warn is warning 3 of 3 again (a 7-day ban), not the 30-day stage-2 ban.
    assert.equal(enforcement.previewWarn(await ladderOf(target)).nextLevel, 1);
});

test('"Remove the warn (stage goes back)" from Unban: voiding the ladder ban removes its trigger warn and steps the ladder back', { skip }, async () => {
    const world = fakeWorld();
    const target = user(12);
    const { warn, ban } = await threeWarns(world, target, ADMINS[1]);

    const result = await caseEdit.voidCase(world.client, { guildId, caseCode: ban.case_code, admin: { id: ADMINS[1], username: 'admin' }, reason: 'Mistake: undone from the /enforcements panel' });
    assert.ok(result.record.voided_at);
    assert.equal(world.banned.has(target), false);
    assert.deepEqual(await ladderOf(target), { level: 0, warns_since_level: 2 });
    assert.equal((await caseRow(warn.case_code)).status, 'revoked', 'the trigger warn no longer counts');
});

test('"Unban only (stage stays)": the plain unban lifts the ladder ban but keeps warning stage 1', { skip }, async () => {
    const world = fakeWorld();
    const target = user(13);
    const { warn, ban, moderator, targetUser } = await threeWarns(world, target, ADMINS[2]);

    await enforcement.executeAction({
        guild: world.guild, moderator, targetUser,
        flow: { type: 'unban', moderatorId: ADMINS[2], targetId: target, targetUsername: targetUser.username, reason: 'Unban via /enforcements' },
    });
    assert.equal(world.banned.has(target), false);
    assert.deepEqual(await ladderOf(target), { level: 1, warns_since_level: 0 }, 'the stage stays');
    assert.equal((await caseRow(ban.case_code)).status, 'revoked');
    assert.equal((await caseRow(warn.case_code)).voided_at, null, 'the warn still stands');
    // So their next warn bans for 30 days: what the choice step warns about.
    assert.equal(enforcement.previewWarn(await ladderOf(target)).nextLevel, 2);
});
