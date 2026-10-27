// Data-layer failure tests against the local test database (npm run test:db).
// Each test injects a database failure into a specific statement mid-operation
// and checks that the call throws and that nothing stored was overwritten.
// Skipped unless POSTGRES_URL points at localhost: never run against Neon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.POSTGRES_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)/.test(url);
const skip = isLocal ? false : 'needs POSTGRES_URL on localhost (npm run test:db)';

let pgDb, db, client, updateGuildConfig, getGuildConfig;
let setBirthday, getGuildBirthdays, registerTemporaryChannel, getJoinToCreateConfig;
let recordCorrectCount, updateCountingGameConfig, getCountingGameConfig;
let saveGiveaway, getGuildGiveaways;

const runId = String(Date.now()).slice(-9);
const guildA = `9${runId}00000001`;
const guildB = `9${runId}00000002`;
const user = (n) => `8${runId}${String(n).padStart(8, '0')}`;
const DATABASE = 'database';

// --- fault injection ----------------------------------------------------------
// Fails the next query whose SQL matches `pattern`, on the pool or on a client
// checked out for a transaction.
let fault = null;
function failNext(pattern, error = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }), { persistent = false } = {}) {
    fault = { pattern, error, persistent };
}
function maybeFail(text) {
    if (fault && fault.pattern.test(String(text))) {
        const { error } = fault;
        if (!fault.persistent) fault = null;
        throw error;
    }
}
function instrument(pool) {
    const query = pool.query.bind(pool);
    pool.query = async (text, params) => {
        maybeFail(text);
        return query(text, params);
    };
    const connect = pool.connect.bind(pool);
    // pool.query() itself calls connect(callback); only patch the promise form.
    pool.connect = async (...args) => {
        if (args.length > 0) return connect(...args);
        const c = await connect();
        if (!c.__instrumented) {
            const cq = c.query.bind(c);
            // Pooled clients keep this patch, and pool.query() calls them with a callback.
            c.query = (text, params, callback) => {
                if (typeof callback === 'function' || typeof params === 'function') return cq(text, params, callback);
                try {
                    maybeFail(text);
                } catch (error) {
                    return Promise.reject(error);
                }
                return cq(text, params);
            };
            c.__instrumented = true;
        }
        return c;
    };
}

before(async () => {
    if (skip) return;
    ({ pgDb } = await import('../../src/utils/postgresDatabase.js'));
    ({ db } = await import('../../src/utils/database/wrapper.js'));
    await db.initialize();
    assert.equal(db.getConnectionType(), 'postgresql');
    instrument(pgDb.pool);
    client = { db };
    ({ updateGuildConfig, getGuildConfig } = await import('../../src/services/config/guildConfig.js'));
    ({ setBirthday, getGuildBirthdays, registerTemporaryChannel, getJoinToCreateConfig } = await import('../../src/utils/database.js'));
    ({ recordCorrectCount, updateCountingGameConfig, getCountingGameConfig } = await import('../../src/services/countingGameService.js'));
    ({ saveGiveaway, getGuildGiveaways } = await import('../../src/utils/giveaways.js'));
});

after(async () => {
    if (skip) return;
    for (const guildId of [guildA, guildB]) {
        await pgDb.pool.query('DELETE FROM birthdays WHERE guild_id = $1', [guildId]).catch(() => {});
        await pgDb.pool.query('DELETE FROM giveaways WHERE guild_id = $1', [guildId]).catch(() => {});
        await pgDb.pool.query('DELETE FROM temp_data WHERE key LIKE $1', [`%${guildId}%`]).catch(() => {});
        await pgDb.pool.query('DELETE FROM guilds WHERE id = $1', [guildId]).catch(() => {});
    }
    await pgDb.disconnect();
});

// --- reads ------------------------------------------------------------------------

test('a failed read throws instead of returning defaults', { skip }, async () => {
    await updateGuildConfig(client, guildA, { prefix: '?' });
    failNext(/SELECT config FROM guilds/);
    await assert.rejects(getGuildConfig(client, guildA), (error) => error.type === DATABASE);
    // The lost connection is re-checked on the next query and the real value comes back.
    assert.equal((await getGuildConfig(client, guildA)).prefix, '?');
});

test('a failed write throws instead of returning false', { skip }, async () => {
    failNext(/INSERT INTO temp_data/);
    await assert.rejects(db.set(`guild:${guildA}:jointocreate`, { enabled: true }), (error) => error.type === DATABASE);
});

// --- config read-modify-write ---------------------------------------------------------

test('config update: failure while reading the locked row writes nothing', { skip }, async () => {
    await updateGuildConfig(client, guildA, { prefix: '!', birthdayChannelId: '123456789012345678' });
    failNext(/FOR UPDATE/);
    await assert.rejects(updateGuildConfig(client, guildA, { prefix: '$' }), (error) => error.type === DATABASE);
    const stored = await getGuildConfig(client, guildA);
    assert.equal(stored.prefix, '!');
    assert.equal(stored.birthdayChannelId, '123456789012345678', 'other settings must not be reset to defaults');
});

test('config update: failure on the write rolls back, the old config stays', { skip }, async () => {
    failNext(/^UPDATE guilds SET config/);
    await assert.rejects(updateGuildConfig(client, guildA, { prefix: '%' }), (error) => error.type === DATABASE);
    const stored = await getGuildConfig(client, guildA);
    assert.equal(stored.prefix, '!');
    assert.equal(stored.birthdayChannelId, '123456789012345678');
});

test('config update: concurrent updates of different settings all survive', { skip }, async () => {
    await Promise.all([
        updateGuildConfig(client, guildB, { prefix: '>' }),
        updateGuildConfig(client, guildB, { birthdayChannelId: '223456789012345678' }),
        updateGuildConfig(client, guildB, { ticketStaffRoleId: '323456789012345678' }),
    ]);
    const stored = await getGuildConfig(client, guildB);
    assert.equal(stored.prefix, '>');
    assert.equal(stored.birthdayChannelId, '223456789012345678');
    assert.equal(stored.ticketStaffRoleId, '323456789012345678');
});

test('atomic increment: 25 parallel increments give 25', { skip }, async () => {
    const key = `guild:${guildA}:tickets:counter`;
    await Promise.all(Array.from({ length: 25 }, () => db.update(key, (n) => (Number(n) || 0) + 1, 0)));
    assert.equal(await db.get(key), 25);
});

// --- collections ---------------------------------------------------------------------

test('birthdays: one member per row, concurrent sets all survive', { skip }, async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => setBirthday(client, guildA, user(i), 1 + (i % 12), 1 + i)));
    const birthdays = await getGuildBirthdays(client, guildA);
    assert.equal(Object.keys(birthdays).length, 10);
});

test('birthdays: a failed whole-collection write changes nothing', { skip }, async () => {
    const before = await getGuildBirthdays(client, guildA);
    // Second row insert of the import fails: the first upsert and the delete must roll back.
    let inserts = 0;
    failNext({ test: (sql) => /INSERT INTO birthdays/.test(sql) && ++inserts === 2 });
    await assert.rejects(db.set(`guild:${guildA}:birthdays`, { [user(0)]: { month: 12, day: 31 }, [user(99)]: { month: 2, day: 2 } }),
        (error) => error.type === DATABASE);
    assert.deepEqual(await getGuildBirthdays(client, guildA), before);
});

test('birthdays: a failed single set throws and leaves the others', { skip }, async () => {
    const before = await getGuildBirthdays(client, guildA);
    failNext(/INSERT INTO birthdays/);
    await assert.rejects(setBirthday(client, guildA, user(50), 5, 5), (error) => error.type === DATABASE);
    assert.deepEqual(await getGuildBirthdays(client, guildA), before);
});

test('giveaways: saving one never touches another', { skip }, async () => {
    const endsAt = new Date(Date.now() + 3600_000).toISOString();
    await saveGiveaway(client, guildA, { messageId: '700000000000000001', prize: 'A', endsAt, participants: ['1'] });
    await saveGiveaway(client, guildA, { messageId: '700000000000000002', prize: 'B', endsAt, participants: [] });
    failNext(/INSERT INTO giveaways/);
    await assert.rejects(saveGiveaway(client, guildA, { messageId: '700000000000000002', prize: 'B2', endsAt }), (error) => error.type === DATABASE);
    const giveaways = await getGuildGiveaways(client, guildA);
    assert.deepEqual(giveaways.map((g) => g.prize).sort(), ['A', 'B']);
    assert.deepEqual(giveaways.find((g) => g.prize === 'A').participants, ['1']);
});

test('join-to-create: concurrent temp channel registrations all survive', { skip }, async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => registerTemporaryChannel(client, guildB, `60000000000000000${i}`, user(i), '600000000000000999')));
    const config = await getJoinToCreateConfig(client, guildB);
    assert.equal(Object.keys(config.temporaryChannels).length, 8);
});

test('counting: two correct posts of the same number advance the count once', { skip }, async () => {
    await updateCountingGameConfig(client, guildB, (config) => ({ ...config, enabled: true, channelId: '1', nextNumber: 5 }));
    await Promise.all([recordCorrectCount(client, guildB, user(1), 5), recordCorrectCount(client, guildB, user(2), 5)]);
    assert.equal((await getCountingGameConfig(client, guildB)).nextNumber, 6);
});

// --- health ------------------------------------------------------------------------------

test('pool error: isConnected clears, the next query health-checks and recovers', { skip }, async () => {
    pgDb.pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }));
    assert.equal(pgDb.isConnected, false);
    assert.equal(pgDb.isAvailable(), true, 'a lost idle connection is not an outage');
    assert.equal((await getGuildConfig(client, guildA)).prefix, '!');
    assert.equal(pgDb.isConnected, true);
});

test('outage: a failed health check makes everything throw until the database is back', { skip }, async () => {
    pgDb.markUnhealthy(new Error('simulated'));
    // The database stays unreachable until the fault is cleared.
    failNext(/^SELECT 1$/, undefined, { persistent: true });
    await assert.rejects(getGuildConfig(client, guildA), (error) => error.type === DATABASE);
    assert.equal(pgDb.isAvailable(), false);
    await assert.rejects(updateGuildConfig(client, guildA, { prefix: '#' }), (error) => error.type === DATABASE);
    fault = null;
    // Database answers again: the next call recovers by itself.
    assert.equal((await getGuildConfig(client, guildA)).prefix, '!');
    assert.equal(pgDb.isAvailable(), true);
});

// --- mass-action guard -------------------------------------------------------------

test('mass-action guard: the ban after the limit is refused, the moderator blocked, owners alerted', { skip }, async () => {
    const { enforceMassActionGuard, getMassActionBlock, clearMassActionBlock } = await import('../../src/services/enforcement/massActionGuard.js');
    const { enforcementConfig } = await import('../../src/config/enforcement.js');
    const moderatorId = user(900);
    const dms = [];
    const fakeClient = {
        guilds: { cache: new Map() },
        users: { fetch: async (id) => ({ send: async (msg) => dms.push({ id, msg }) }) },
    };
    const guild = { id: guildA, name: 'Test guild', client: fakeClient };
    const moderator = { id: moderatorId, user: { username: 'rogue' } };
    try {
        for (let i = 0; i < enforcementConfig.massActionLimit; i++) {
            await pgDb.pool.query(
                `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom)
                 VALUES ($1, $2, $3, 'x', $4, 'rogue', $5, $2, 'r', 'custom')`,
                [guildA, `T${runId.slice(-4)}${i}`.slice(0, 7), user(800 + i), moderatorId, i % 2 ? 'kick' : 'ban']
            );
        }
        await enforceMassActionGuard(guild, moderator, 'warn'); // warns don't count and aren't blocked yet
        await assert.rejects(enforceMassActionGuard(guild, moderator, 'ban'), (error) => error.type === 'permission');
        assert.ok(await getMassActionBlock(guildA, moderatorId), 'block stored');
        assert.equal(dms.length, (process.env.OWNER_IDS || '').split(',').filter(Boolean).length, 'every OWNER_IDS account got a DM');
        await assert.rejects(enforceMassActionGuard(guild, moderator, 'warn'), (error) => error.type === 'permission', 'blocked from every action');
        // Owners are never blocked.
        const ownerId = (process.env.OWNER_IDS || '').split(',')[0]?.trim();
        if (ownerId) await enforceMassActionGuard(guild, { id: ownerId, user: { username: 'owner' } }, 'ban');
        await clearMassActionBlock(guildA, moderatorId);
        assert.equal(await getMassActionBlock(guildA, moderatorId), null);
    } finally {
        await pgDb.pool.query('DELETE FROM mod_cases WHERE guild_id = $1 AND moderator_id = $2', [guildA, moderatorId]);
    }
});

// --- My appeals ---------------------------------------------------------------------

test('My appeals: lists only the member\'s own appeals, newest first, without test cases', { skip }, async () => {
    const { listUserAppeals } = await import('../../src/services/enforcement/caseService.js');
    const member = user(700);
    const other = user(701);
    const codes = [`A${runId.slice(-5)}1`, `A${runId.slice(-5)}2`, `A${runId.slice(-5)}3`].map((c) => c.slice(0, 7));
    const insertCase = (code, target, isTest = false) => pgDb.pool.query(
        `INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom, is_test)
         VALUES ($1, $2, $3, 'x', '1', 'mod', 'ban', $2, 'r', 'custom', $4)`, [guildA, code, target, isTest]);
    try {
        await insertCase(codes[0], member);
        await insertCase(codes[1], other);
        await insertCase(codes[2], member, true);
        await pgDb.pool.query(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, body, status, created_at) VALUES
            ('appeal', $1, $3, 'm', $4, '{}', 'denied', NOW() - INTERVAL '2 days'),
            ('appeal', $1, $3, 'm', $4, '{}', 'pending', NOW()),
            ('appeal', $2, $5, 'o', $4, '{}', 'pending', NOW())`, [codes[0], codes[1], member, guildA, other]);
        await pgDb.pool.query(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, body) VALUES ('appeal', $1, $2, 'm', $3, '{}')`, [codes[2], member, guildA]);
        const appeals = await listUserAppeals(member);
        assert.deepEqual(appeals.map((a) => a.status), ['pending', 'denied']);
        assert.ok(appeals.every((a) => a.case_code === codes[0]));
    } finally {
        await pgDb.pool.query('DELETE FROM mod_appeals WHERE case_code = ANY($1)', [codes]);
        await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = ANY($1)', [codes]);
    }
});

// --- stale appeal/report channels ------------------------------------------------------

test('stale channels: old report closed, pending appeal reminded once, leftover decided appeal closed', { skip }, async () => {
    const { tidyStaleAppealChannels } = await import('../../src/services/enforcement/staleAppealService.js');
    const { enforcementConfig } = await import('../../src/config/enforcement.js');
    const { SnowflakeUtil, Collection } = await import('discord.js');
    const longAgo = Date.now() - 30 * 24 * 3600_000;
    const events = [];
    const fakeChannel = (id) => ({
        id,
        lastMessageId: String(SnowflakeUtil.generate({ timestamp: longAgo })),
        createdTimestamp: longAgo,
        name: `c-${id}`,
        messages: { fetch: async () => new Collection() },
        send: async (msg) => events.push(['send', id, msg.content]),
        delete: async () => events.push(['delete', id]),
    });
    const ids = { report: '510000000000000001', pending: '510000000000000002', decided: '510000000000000003' };
    const channels = new Map(Object.values(ids).map((id) => [id, fakeChannel(id)]));
    const guild = { id: enforcementConfig.mainGuildId, channels: { cache: channels } };
    const client = { db, guilds: { cache: new Map([[guild.id, guild]]) }, channels: { fetch: async () => null } };
    const code = `S${runId.slice(-6)}`.slice(0, 7);
    const member = user(600);
    try {
        await pgDb.pool.query(`INSERT INTO mod_cases (guild_id, case_code, target_user_id, target_username, moderator_id, moderator_username, type, name, reason, prebuilt_or_custom)
            VALUES ($1, $2, $3, 'x', '1', 'm', 'ban', $2, 'r', 'custom')`, [guild.id, code, member]);
        const { rows } = await pgDb.pool.query(`INSERT INTO mod_appeals (kind, case_code, user_id, username, guild_id, body, status, channel_id, decided_at) VALUES
            ('report', NULL, $1, 'm', $2, '{}', 'pending', $3, NULL),
            ('appeal', $4, $1, 'm', $2, '{}', 'pending', $5, NULL),
            ('appeal', $4, $1, 'm', $2, '{}', 'denied', $6, NOW() - INTERVAL '1 hour') RETURNING id`,
            [member, guild.id, ids.report, code, ids.pending, ids.decided]);
        await tidyStaleAppealChannels(client);
        await tidyStaleAppealChannels(client); // a second run must not remind again
        const sends = events.filter(([type, id]) => type === 'send' && id === ids.pending);
        assert.equal(sends.length, 1, 'pending appeal reminded exactly once');
        assert.ok(events.some(([type, id]) => type === 'delete' && id === ids.report), 'stale report deleted');
        assert.ok(events.some(([type, id]) => type === 'delete' && id === ids.decided), 'leftover decided appeal deleted');
        assert.ok(!events.some(([type, id]) => type === 'delete' && id === ids.pending), 'pending appeal never deleted');
        const { rows: [report] } = await pgDb.pool.query('SELECT status FROM mod_appeals WHERE id = $1', [rows[0].id]);
        assert.equal(report.status, 'closed');
        for (const { id } of rows) await pgDb.pool.query('DELETE FROM temp_data WHERE key = $1', [`appeals:stale-reminded:${id}`]);
    } finally {
        await pgDb.pool.query('DELETE FROM mod_appeals WHERE channel_id = ANY($1)', [Object.values(ids)]);
        await pgDb.pool.query('DELETE FROM mod_cases WHERE case_code = $1', [code]);
    }
});

test('canned answers: built-ins plus own, own can replace text, built-ins cannot be removed', { skip }, async () => {
    const { listCanned, saveCanned, removeCanned, getCanned } = await import('../../src/services/cannedService.js');
    assert.ok(await getCanned(guildB, 'need-proof'), 'built-in present');
    await saveCanned(guildB, 'rules', 'Read #rules.');
    await saveCanned(guildB, 'need-proof', 'Screenshots please.');
    assert.equal(await getCanned(guildB, 'rules'), 'Read #rules.');
    assert.equal(await getCanned(guildB, 'need-proof'), 'Screenshots please.');
    assert.equal(await removeCanned(guildB, 'rules'), true);
    assert.equal(await removeCanned(guildB, 'appeal-received'), false);
    assert.ok(!('rules' in await listCanned(guildB)));
});
