// Multi-server B4b: the gaps left in other servers. /staff restore for a server's own
// Administrators, "Report message" into that server's review channel, /test previews as that
// server would send them (nothing executed), the weekly staff report per server (and staff
// messages counted in every server), and the nuke diff of the server the nuke happened in.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000777';
const OTHER_2 = '100000000000000778';
const OWNER_ID = '199999999999999991'; // in OWNER_IDS
const SERVER_OWNER = '199999999999999992';
const ADMIN = '500000000000000001';
const TARGET = '500000000000000002';
const REVIEW = '400000000000000001';
const ALERTS = '400000000000000002';

Object.assign(process.env, { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT });

const { pgDb } = await import('../src/utils/postgresDatabase.js');
const { db: kv } = await import('../src/utils/database/wrapper.js');
const { botConfig } = await import('../src/config/bot.js');
const { resetSettingsCacheForTests, setSettingsCacheForTests, SettingsUnavailableError } = await import('../src/services/settings/guildSettings.js');
const staffCommand = (await import('../src/commands/Enforcement/staff.js')).default;
const { canRestore, restoreRefusal } = await import('../src/commands/Enforcement/staff.js');
const reportCommand = (await import('../src/commands/Enforcement/reportmessage.js')).default;
const { resetReportCooldowns } = await import('../src/commands/Enforcement/reportmessage.js');
const testCommand = (await import('../src/commands/Owner/test.js')).default;
const { buildPreview } = await import('../src/commands/Owner/test.js');
const activity = await import('../src/services/staffActivityService.js');
const { showDiffRow } = await import('../src/services/automod/alertPost.js');
const { handleNukeDiff, nukeDiffGuildId } = await import('../src/handlers/backupRevert.js');

const savedOwners = botConfig.commands.owners;
botConfig.commands.owners = [OWNER_ID];
process.on('exit', () => { botConfig.commands.owners = savedOwners; });

afterEach(() => {
    resetSettingsCacheForTests();
    resetReportCooldowns();
    activity.resetStaffActivityState();
    delete kv.get;
    delete kv.set;
    delete kv.delete;
});

/** A fake pg pool; `answer(sql, params)` returns rows, every query is recorded. */
async function withPool(answer, fn) {
    const queries = [];
    const saved = { pool: pgDb.pool, isConnected: pgDb.isConnected, isAvailable: pgDb.isAvailable };
    const run = async (sql, params = []) => {
        queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return { rows: (await answer(String(sql), params)) || [], rowCount: 1 };
    };
    pgDb.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    pgDb.isConnected = true;
    pgDb.isAvailable = () => true;
    try {
        return await fn(queries);
    } finally {
        Object.assign(pgDb, saved);
    }
}

const perms = (admin) => ({ has: (flag) => admin && (flag === PermissionFlagsBits.Administrator || Array.isArray(flag)) });

function textChannel(id, sent) {
    return { id, isTextBased: () => true, send: async (payload) => { sent.push({ channelId: id, payload }); return { id: `m${sent.length}`, url: 'https://discord.com/x' }; } };
}

/** A fake guild; `channels` are text channels; no member-changing API except roles.add on fetched members. */
function fakeGuild(id, { name = `Server ${id}`, ownerId = SERVER_OWNER, channels = [], roles = [], members = new Map(), sent = [] } = {}) {
    const guild = {
        id, name, ownerId,
        channels: { cache: new Map(channels.map((cid) => [cid, textChannel(cid, sent)])), fetch: async () => null },
        roles: { cache: new Map(roles.map((role) => [role.id, role])), everyone: { permissions: { bitfield: 0n } } },
        members: {
            cache: members,
            fetch: async (userId) => (userId ? members.get(userId) || null : members),
            ban: async () => { throw new Error('nothing may be executed'); },
            kick: async () => { throw new Error('nothing may be executed'); },
        },
        bans: { create: async () => { throw new Error('nothing may be executed'); } },
        fetchOwner: async () => null,
        sent,
    };
    return guild;
}

function fakeClient(guilds) {
    const client = { user: { id: '900000000000000001', username: 'Mewvo' }, guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } };
    for (const g of guilds) g.client = client;
    return client;
}

/** A slash interaction in `guild` by `userId`. */
function slash(guild, userId, { admin = false, topRole = 10, sub = null, options = {} } = {}) {
    const replies = [];
    const interaction = {
        id: `i${Math.random()}`, guildId: guild.id, guild, client: guild.client,
        user: { id: userId, username: `u${userId.slice(-3)}`, client: guild.client },
        member: { id: userId, guild, permissions: perms(admin), roles: { highest: { position: topRole } } },
        deferred: false, replied: false,
        options: {
            getSubcommand: () => sub,
            getUser: (name) => options[name] ?? null,
            getString: (name) => options[name] ?? null,
            getBoolean: (name) => options[name] ?? null,
        },
        deferReply: async () => { interaction.deferred = true; },
        reply: async (p) => { replies.push(p); interaction.replied = true; },
        editReply: async (p) => { replies.push(p); },
        followUp: async (p) => { replies.push(p); },
    };
    return { interaction, replies };
}

const text = (replies) => JSON.stringify(replies);
/** assert.rejects matcher on the text the user sees. */
const says = (re) => (error) => re.test(error.userMessage ?? error.message);

// ── 1. /staff restore ─────────────────────────────────────────────────────

test('/staff restore: Administrators of another server may; Mewvo\'s servers stay owner-only', () => {
    const other = fakeGuild(OTHER);
    const main = fakeGuild(MAIN);
    fakeClient([other, main]);
    assert.equal(canRestore(slash(other, ADMIN, { admin: true }).interaction), true, 'admin elsewhere');
    assert.equal(canRestore(slash(other, ADMIN).interaction), false, 'non-admin elsewhere');
    assert.equal(canRestore(slash(other, SERVER_OWNER).interaction), true, 'that server\'s owner');
    assert.equal(canRestore(slash(other, OWNER_ID).interaction), false, 'OWNER_IDS have no power in other servers');
    assert.equal(canRestore(slash(main, ADMIN, { admin: true }).interaction), false, 'main server admin: owner-only as before');
    assert.equal(canRestore(slash(main, OWNER_ID).interaction), true, 'OWNER_IDS at home');
});

test('/staff restore: an Administrator cannot restore themselves or roles at/above their own top role', () => {
    const other = fakeGuild(OTHER);
    fakeClient([other]);
    const admin = slash(other, ADMIN, { admin: true, topRole: 10 }).interaction;
    assert.match(restoreRefusal({ interaction: admin, targetId: ADMIN, roles: [] }), /cannot restore yourself/);
    assert.match(restoreRefusal({ interaction: admin, targetId: TARGET, roles: [{ name: 'Head', position: 10 }] }), /Head/);
    assert.equal(restoreRefusal({ interaction: admin, targetId: TARGET, roles: [{ name: 'Mod', position: 9 }] }), null);
    const owner = slash(other, SERVER_OWNER).interaction;
    assert.equal(restoreRefusal({ interaction: owner, targetId: SERVER_OWNER, roles: [{ name: 'Head', position: 99 }] }), null, 'server owner: no limit');
});

test('/staff restore in another server: lifts that server\'s block and gives back that server\'s saved roles', async () => {
    const role = { id: '600000000000000001', name: 'Mod', position: 5, editable: true };
    const added = [];
    const member = { id: TARGET, user: { id: TARGET, username: 'target' }, roles: { add: async (roles) => { added.push(...roles.map((r) => r.id)); } } };
    const other = fakeGuild(OTHER, { roles: [role], members: new Map([[TARGET, member]]) });
    fakeClient([other]);
    setSettingsCacheForTests(OTHER, {});
    const store = new Map([
        [`staffguard:removed:${OTHER}:${TARGET}`, { roleIds: [role.id], reason: 'x', at: 'now' }],
        [`enforcement:massguard:${OTHER}:${TARGET}`, { until: new Date(Date.now() + 3600000).toISOString(), count: 6 }],
        [`staffguard:removed:${MAIN}:${TARGET}`, { roleIds: ['600000000000000099'] }],
    ]);
    const reads = [];
    kv.get = async (key, fallback = null) => { reads.push(key); return store.has(key) ? store.get(key) : fallback; };
    kv.delete = async (key) => { store.delete(key); return true; };
    const { interaction, replies } = slash(other, ADMIN, { admin: true, sub: 'restore', options: { user: { id: TARGET, username: 'target' } } });
    await staffCommand.execute(interaction);
    assert.deepEqual(added, [role.id]);
    assert.ok(!store.has(`enforcement:massguard:${OTHER}:${TARGET}`), 'block lifted');
    assert.ok(!store.has(`staffguard:removed:${OTHER}:${TARGET}`), 'saved roles used up');
    assert.ok(store.has(`staffguard:removed:${MAIN}:${TARGET}`), 'another server\'s saved roles untouched');
    assert.ok(reads.every((key) => key.includes(OTHER)), 'only this server\'s keys read');
    assert.match(text(replies), /Staff access restored/);
});

test('/staff restore: a non-admin in another server is refused before any lookup', async () => {
    const other = fakeGuild(OTHER);
    fakeClient([other]);
    kv.get = async () => { throw new Error('must not read'); };
    const { interaction } = slash(other, ADMIN, { sub: 'restore', options: { user: { id: TARGET, username: 'target' } } });
    await assert.rejects(staffCommand.execute(interaction), says(/Administrator permission/));
    assert.equal(interaction.deferred, false);
});

// ── 2. Report message ─────────────────────────────────────────────────────

function reportClick(guild, reporterId = ADMIN) {
    const message = {
        id: '700000000000000001', guildId: guild.id, guild, channelId: '800000000000000001', url: 'https://discord.com/m',
        content: 'bad words', author: { id: TARGET, username: 'target', bot: false },
    };
    const click = slash(guild, reporterId);
    click.interaction.targetMessage = message;
    return click;
}

test('Report message works in another server and posts to that server\'s review channel', async () => {
    const sent = [];
    const other = fakeGuild(OTHER, { channels: [REVIEW], sent });
    const main = fakeGuild(MAIN, { channels: [REVIEW], sent: [] });
    fakeClient([other, main]);
    setSettingsCacheForTests(OTHER, { reviewChannelId: REVIEW });
    const { interaction, replies } = reportClick(other);
    await reportCommand.execute(interaction);
    assert.equal(sent.length, 1, 'card posted in the other server');
    assert.deepEqual(sent[0].payload.allowedMentions, { parse: [] });
    assert.equal(main.sent.length, 0, 'never in the main server');
    assert.match(text(replies), /Report sent/);
});

test('Report message: a server without a staff channel tells the reporter it was not delivered', async () => {
    const other = fakeGuild(OTHER_2, { channels: [] });
    const main = fakeGuild(MAIN, { channels: [REVIEW] });
    fakeClient([other, main]);
    setSettingsCacheForTests(OTHER_2, {});
    const { interaction } = reportClick(other);
    await assert.rejects(reportCommand.execute(interaction), says(/could not be delivered/));
    assert.equal(main.sent.length, 0);
});

test('Report message: the cooldown is per server and member', async () => {
    const sentA = [];
    const a = fakeGuild(OTHER, { channels: [REVIEW], sent: sentA });
    const b = fakeGuild(OTHER_2, { channels: [REVIEW], sent: sentA });
    fakeClient([a, b]);
    setSettingsCacheForTests(OTHER, { reviewChannelId: REVIEW });
    setSettingsCacheForTests(OTHER_2, { reviewChannelId: REVIEW });
    await reportCommand.execute(reportClick(a).interaction);
    await assert.rejects(reportCommand.execute(reportClick(a).interaction), says(/wait a little/));
    await reportCommand.execute(reportClick(b).interaction);
});

// ── 3. /test ──────────────────────────────────────────────────────────────

function caseRow(params) {
    return {
        id: 1, guild_id: params[0], case_code: params[1], target_user_id: params[2], target_username: params[3],
        moderator_id: params[4], moderator_username: params[5], type: params[6], name: params[7], reason: params[8],
        prebuilt_or_custom: params[9], reason_key: params[10], duration_ms: params[11], created_at: new Date(),
        expires_at: params[13], unappealable: params[14], appeal_deadline: params[15], ladder_level_after: params[16],
        is_auto: params[18], is_test: params[23],
    };
}

test('/test in another server: the DM names that server, the case and ladder are that server\'s, nothing executed', async () => {
    const other = fakeGuild(OTHER, { name: 'Pancake Place' });
    fakeClient([other]);
    setSettingsCacheForTests(OTHER, { appealsHome: 'own', appealsInvite: 'https://discord.gg/pancake1' });
    const invoker = { id: ADMIN, username: 'admin', client: other.client };
    const target = { id: TARGET, username: 'target' };
    await withPool((sql, params) => (/INSERT INTO mod_cases/i.test(sql) ? [caseRow(params)] : []), async (queries) => {
        for (const action of ['ban', 'mute', 'warn']) {
            const preview = await buildPreview({ action, guild: other, invoker, target, reason: 'Spam', durationMs: 3600000, unappealable: false });
            assert.match(preview.content, /Pancake Place/, action);
            assert.match(preview.content, /discord\.gg\/pancake1/, `${action}: that server's appeal invite`);
            assert.equal(preview.record.guild_id, OTHER, action);
            assert.equal(preview.record.is_test, true, action);
        }
        const denied = await buildPreview({ action: 'appeal-denied', guild: other, invoker, target, reason: 'x' });
        assert.match(denied.content, /pancake1/);
        const ladder = queries.filter((q) => /mod_ladder/i.test(q.sql));
        assert.ok(ladder.length && ladder.every((q) => q.params[0] === OTHER), 'that server\'s ladder');
        assert.ok(queries.every((q) => /^(SELECT|INSERT INTO mod_cases)/i.test(q.sql)), 'only reads and the test case insert');
    });
});

test('/test in another server: non-admins are refused; admins pass the server check', async () => {
    const other = fakeGuild(OTHER);
    fakeClient([other]);
    const refused = slash(other, ADMIN, { options: { action: 'ban', user: { id: TARGET, username: 't' } } });
    await assert.rejects(testCommand.execute(refused.interaction), says(/Administrator permission/));
    const admin = slash(other, ADMIN, { admin: true, options: { action: 'ban', user: { id: TARGET, username: 't' }, duration: 'nonsense' } });
    await assert.rejects(testCommand.execute(admin.interaction), says(/duration is not valid/), 'got past the server check');
});

// ── 4. Weekly staff report per server ─────────────────────────────────────

test('weekly staff report: one per server with a staff channel; home servers are one staff', () => {
    const client = fakeClient([fakeGuild(MAIN), fakeGuild(SUPPORT), fakeGuild(OTHER), fakeGuild(OTHER_2)]);
    const channels = { [MAIN]: ALERTS, [OTHER]: ALERTS };
    const channelFor = (id) => channels[id] || null;
    assert.deepEqual(activity.weeklyReportGuilds(client, [SUPPORT, OTHER, OTHER_2, '100000000000009999', OTHER], { channelFor }), [MAIN, OTHER],
        'support maps to main, OTHER_2 has no channel, unknown servers skipped, no duplicates');
    const unreadable = (id) => { if (id === OTHER) throw new SettingsUnavailableError(id); return ALERTS; };
    assert.deepEqual(activity.weeklyReportGuilds(client, [OTHER], { channelFor: unreadable }), [MAIN], 'unreadable settings: skipped this run');
    assert.deepEqual(activity.weeklyReportGuilds(client, [], { channelFor: () => null }), [], 'nowhere to post: nothing');
});

test('weekly staff report: posts in the other server\'s own channel with its own rows', async () => {
    const sent = [];
    const mainSent = [];
    const staff = { id: ADMIN, user: { id: ADMIN, username: 'mod', bot: false }, guild: { ownerId: SERVER_OWNER }, permissions: perms(true) };
    const other = fakeGuild(OTHER, { channels: [ALERTS], sent, members: new Map([[ADMIN, staff]]) });
    const main = fakeGuild(MAIN, { channels: [ALERTS], sent: mainSent });
    fakeClient([other, main]);
    setSettingsCacheForTests(OTHER, { alertsChannelId: ALERTS });
    await withPool((sql) => (/staff_activity/.test(sql) ? [{ user_id: ADMIN, messages: 40, reviews: 1, tickets: 0 }] : []), async (queries) => {
        await activity.postWeeklyStaffReportFor(other.client, other, '2026-11-02');
        assert.ok(queries.every((q) => q.params.includes(OTHER)), 'only this server\'s rows');
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channelId, ALERTS);
    assert.match(JSON.stringify(sent[0].payload.embeds), /mod.*40 msgs/);
    assert.equal(mainSent.length, 0, 'not in the main server');
});

test('weekly staff report: the candidate query finds servers with activity that week', async () => {
    await withPool(() => [{ guild_id: OTHER }, { guild_id: MAIN }], async (queries) => {
        assert.deepEqual(await activity.guildsWithStaffActivity('2026-11-02', '900000000000000001'), [OTHER, MAIN]);
        assert.match(queries[0].sql, /UNION/);
        assert.match(queries[0].sql, /LIMIT \d+/);
        assert.equal(queries[0].params[0], '2026-11-02');
    });
});

test('staff messages: counted in every server, buffered to one upsert per member per minute', async () => {
    const msg = (guildId) => ({ guildId, author: { id: ADMIN }, member: { id: ADMIN, guild: { ownerId: SERVER_OWNER }, permissions: perms(true) } });
    for (let i = 0; i < 5; i += 1) activity.noteStaffMessage(msg(OTHER));
    activity.noteStaffMessage(msg(MAIN));
    activity.noteStaffMessage({ guildId: OTHER, author: { id: TARGET }, member: { id: TARGET, guild: { ownerId: SERVER_OWNER }, permissions: perms(false) } });
    assert.deepEqual([...activity.pendingStaffMessages()].sort(), [[`${MAIN}:${ADMIN}`, 1], [`${OTHER}:${ADMIN}`, 5]]);
    await withPool(() => [], async (queries) => {
        await activity.flushStaffMessages();
        const upserts = queries.filter((q) => /staff_activity/.test(q.sql));
        assert.equal(upserts.length, 2, 'one upsert per server and member');
        assert.deepEqual(upserts.map((q) => [q.params[0], q.params[3]]).sort(), [[MAIN, 1], [OTHER, 5]]);
    });
    assert.ok(activity.PENDING_MESSAGES_MAX > 0);
});

// ── 5. Nuke diff ──────────────────────────────────────────────────────────

test('nuke diff button: carries the server the nuke happened in; old buttons mean the main server', () => {
    const id = showDiffRow(1700000000000, SUPPORT).components[0].data.custom_id;
    assert.equal(id, `nukediff:1700000000:${SUPPORT}`);
    assert.ok(id.length <= 100);
    assert.equal(nukeDiffGuildId(['1700000000', SUPPORT]), SUPPORT);
    assert.equal(nukeDiffGuildId(['1700000000']), MAIN);
    assert.equal(nukeDiffGuildId(['1700000000', 'junk']), MAIN);
});

function diffClick(guild, userId) {
    const replies = [];
    const click = {
        id: 'd1', guildId: guild.id, guild, user: { id: userId }, member: { id: userId, guild, permissions: perms(false) },
        deferred: false, replied: false,
        reply: async (p) => { replies.push(p); click.replied = true; },
        deferReply: async () => { click.deferred = true; },
        editReply: async (p) => { replies.push(p); },
        followUp: async (p) => { replies.push(p); },
    };
    return { click, replies };
}

test('nuke diff: a support-server nuke compares the support server\'s snapshot, without revert buttons', async () => {
    const main = fakeGuild(MAIN);
    const support = fakeGuild(SUPPORT, { name: 'Support' });
    const client = fakeClient([main, support]);
    const snapshot = { id: 7, guild_id: SUPPORT, created_at: new Date(), summary: '0 roles', data: { roles: [], channels: [], everyonePermissions: '0' } };
    await withPool((sql, params) => (params[0] === SUPPORT ? [snapshot] : []), async (queries) => {
        const { click, replies } = diffClick(main, OWNER_ID);
        await handleNukeDiff(click, client, ['1700000000', SUPPORT]);
        assert.equal(queries[0].params[0], SUPPORT, 'support snapshot read');
        assert.match(text(replies), /Snapshot #7/);
        assert.doesNotMatch(text(replies), /backuprevert|nukerevert/, 'nothing changed: no revert buttons');
    });
    await withPool(() => [], async (queries) => {
        const { click } = diffClick(main, OWNER_ID);
        await handleNukeDiff(click, client, ['1700000000']);
        assert.equal(queries[0].params[0], MAIN, 'an old button: the main server, as before');
    });
});

test('nuke diff: a button naming another server than the one it is clicked in is refused before any lookup', async () => {
    const main = fakeGuild(MAIN);
    const client = fakeClient([main, fakeGuild(OTHER)]);
    await withPool(() => [], async (queries) => {
        const { click, replies } = diffClick(main, OWNER_ID);
        await handleNukeDiff(click, client, ['1700000000', OTHER]);
        assert.equal(queries.length, 0);
        assert.equal(click.deferred, false);
        assert.match(text(replies), /belongs to another server/);
    });
});
