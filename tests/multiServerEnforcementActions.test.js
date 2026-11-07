// Multi-server B0b, batch 1 (enforcement actions): the mass-action guard, the Muted role, the
// warning roles, the evidence channel, independent appeal review, the panel templates and the
// admin refusal read the settings of the server they act in (resolveSetting). Another server
// never gets the main server's env values or production IDs; a server whose settings could not
// be read throws SettingsUnavailableError instead of falling back to defaults.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000777'; // not a home server
const MAIN_CHANNEL = '300000000000000001';
const MAIN_ROLE = '300000000000000002';
const MAIN_ROLE_2 = '300000000000000003';
const OWN_CHANNEL = '400000000000000001';
const OWN_ROLE_1 = '400000000000000002';
const OWN_ROLE_2 = '400000000000000003';
const MODERATOR = '500000000000000001';
const USER = '500000000000000002';

// A production-like env: if any of these reached OTHER, the tests would see the main server's IDs.
Object.assign(process.env, {
    MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT,
    MUTED_ROLE_ID: MAIN_ROLE, WARN_ROLE_IDS: `${MAIN_ROLE},${MAIN_ROLE_2}`,
    MASS_ACTION_LIMIT: '1', MASS_MUTE_LIMIT: '1', MASS_ACTION_WINDOW_MINUTES: '99',
    EVIDENCE_CHANNEL_ID: MAIN_CHANNEL, MOD_LOG_CHANNEL_ID: MAIN_CHANNEL, ADMIN_REQUEST_CHANNEL_ID: MAIN_CHANNEL,
});

const { pgDb } = await import('../src/utils/postgresDatabase.js');
const { db: kv } = await import('../src/utils/database/wrapper.js');
const {
    SettingsUnavailableError, resetSettingsCacheForTests, setSettingsCacheForTests,
} = await import('../src/services/settings/guildSettings.js');
const { enforceMassActionGuard, recentBanKickCount, recentMuteCount } = await import('../src/services/enforcement/massActionGuard.js');
const { findMutedRole } = await import('../src/services/enforcement/muteService.js');
const { syncWarnRoles } = await import('../src/services/enforcement/warnRoleService.js');
const { addImageEvidence } = await import('../src/services/enforcement/evidenceService.js');
const { isIndependentReviewOn, checkAppealReviewer } = await import('../src/services/enforcement/appealReviewer.js');
const { readTemplates } = await import('../src/handlers/enforcementPanel.js');
const { getAdminRequiredMessage } = await import('../src/utils/commandGate.js');

const MINUTE = 60_000;

afterEach(() => {
    resetSettingsCacheForTests();
});

/** A fake pg pool; `answer(sql, params)` returns rows, every query is recorded. */
async function withPool(answer, fn) {
    const queries = [];
    const saved = { pool: pgDb.pool, isConnected: pgDb.isConnected };
    const run = async (sql, params = []) => {
        queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return { rows: (await answer(String(sql), params)) || [], rowCount: 1 };
    };
    pgDb.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    pgDb.isConnected = true;
    try {
        return await fn(queries);
    } finally {
        pgDb.pool = saved.pool;
        pgDb.isConnected = saved.isConnected;
    }
}

/** The key/value store the guard keeps its blocks in: no block stored. */
async function withNoBlocks(fn) {
    kv.get = async (key, fallback = null) => fallback;
    try {
        return await fn();
    } finally {
        delete kv.get;
    }
}

const roleCache = (ids) => new Map(ids.map((id) => [id, { id }]));

// ── Mass-action guard ─────────────────────────────────────────────────────

test('mass-action guard: another server counts with its own window and limits, never the main server\'s env', () => withNoBlocks(async () => {
    setSettingsCacheForTests(OTHER, { massActionLimit: 10, massMuteLimit: 20, massActionWindowMs: 30 * MINUTE });
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 6 }] : []), async (queries) => {
        assert.equal(await recentBanKickCount(OTHER, MODERATOR), 6);
        assert.equal(await recentMuteCount(OTHER, MODERATOR), 6);
        const windows = queries.filter((q) => /COUNT\(\*\)/.test(q.sql)).map((q) => q.params[2]);
        assert.deepEqual(windows, [30 * MINUTE, 30 * MINUTE], 'its own window, not MASS_ACTION_WINDOW_MINUTES');
        // 6 bans/kicks and 6 mutes: under its own limits (10 / 20) although the env says 1.
        const guild = { id: OTHER, name: 'Other', client: {} };
        await enforceMassActionGuard(guild, { id: MODERATOR }, 'ban');
        await enforceMassActionGuard(guild, { id: MODERATOR }, 'mute');
    });
}));

test('mass-action guard: nothing stored → the generic defaults (5 / 10 / 10 minutes), not the env values', () => withNoBlocks(async () => {
    setSettingsCacheForTests(OTHER, {});
    await withPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ n: 4 }] : []), async (queries) => {
        await enforceMassActionGuard({ id: OTHER, name: 'Other', client: {} }, { id: MODERATOR }, 'kick');
        const [count] = queries.filter((q) => /COUNT\(\*\)/.test(q.sql));
        assert.equal(count.params[2], 10 * MINUTE);
    });
}));

test('mass-action guard: settings of another server never read → SettingsUnavailableError, no count', () => withNoBlocks(async () => {
    await withPool(() => [], async (queries) => {
        await assert.rejects(enforceMassActionGuard({ id: OTHER, name: 'Other', client: {} }, { id: MODERATOR }, 'ban'), SettingsUnavailableError);
        assert.equal(queries.filter((q) => /COUNT\(\*\)/.test(q.sql)).length, 0);
    });
}));

// ── Muted role ────────────────────────────────────────────────────────────

test('findMutedRole: another server never looks for the main server\'s MUTED_ROLE_ID', async () => {
    setSettingsCacheForTests(OTHER, {});
    // The main server's role id happens to exist in the role cache: it must still not be used.
    const guild = { id: OTHER, roles: { cache: roleCache([MAIN_ROLE, OWN_ROLE_1]), fetch: async () => null } };
    await withPool(() => [], async () => {
        assert.equal(await findMutedRole(guild), null, 'nothing set up: no role (ensureMutedRole then creates one)');
    });
    await withPool((sql) => (/muted_role_id/.test(sql) ? [{ muted_role_id: OWN_ROLE_1 }] : []), async () => {
        assert.equal((await findMutedRole(guild)).id, OWN_ROLE_1, 'the role the bot created there');
    });
    setSettingsCacheForTests(OTHER, { mutedRoleId: OWN_ROLE_1 });
    await withPool(() => [], async () => {
        assert.equal((await findMutedRole(guild)).id, OWN_ROLE_1, 'its configured role');
    });
});

test('findMutedRole: the main server keeps MUTED_ROLE_ID; an unread other server throws', async () => {
    const main = { id: MAIN, roles: { cache: roleCache([MAIN_ROLE]), fetch: async () => null } };
    await withPool(() => [], async () => {
        assert.equal((await findMutedRole(main)).id, MAIN_ROLE);
        await assert.rejects(findMutedRole({ id: OTHER, roles: { cache: new Map() } }), SettingsUnavailableError);
    });
});

// ── Warning roles ─────────────────────────────────────────────────────────

function warnGuild(id, held = []) {
    const added = [];
    const removed = [];
    const member = { roles: { cache: new Map(held.map((r) => [r, {}])), add: async (r) => added.push(r), remove: async (r) => removed.push(...r) } };
    let fetched = 0;
    return { added, removed, fetched: () => fetched, guild: { id, members: { fetch: async () => { fetched += 1; return member; } } } };
}

test('syncWarnRoles: another server uses its own warnRoleIds; none set up → nothing touched', async () => {
    await withPool((sql) => (/COUNT\(\*\)::int AS count/.test(sql) ? [{ count: 1 }] : []), async () => {
        setSettingsCacheForTests(OTHER, {});
        const none = warnGuild(OTHER);
        await syncWarnRoles(none.guild, USER);
        assert.equal(none.fetched(), 0, 'no warning roles there: the env WARN_ROLE_IDS is not used');

        setSettingsCacheForTests(OTHER, { warnRoleIds: [OWN_ROLE_1, OWN_ROLE_2] });
        const own = warnGuild(OTHER, [OWN_ROLE_2]);
        await syncWarnRoles(own.guild, USER);
        assert.deepEqual(own.added, [OWN_ROLE_1]);
        assert.deepEqual(own.removed, [OWN_ROLE_2]);
    });
});

test('syncWarnRoles: the main server keeps WARN_ROLE_IDS; the support server has none', async () => {
    await withPool((sql) => (/COUNT\(\*\)::int AS count/.test(sql) ? [{ count: 2 }] : []), async () => {
        const main = warnGuild(MAIN);
        await syncWarnRoles(main.guild, USER);
        assert.deepEqual(main.added, [MAIN_ROLE_2]);
        const support = warnGuild(SUPPORT);
        await syncWarnRoles(support.guild, USER);
        assert.equal(support.fetched(), 0);
    });
});

// ── Evidence channel ──────────────────────────────────────────────────────

function evidenceClient() {
    const sent = [];
    const channel = (id) => ({ id, isTextBased: () => true, send: async (payload) => { sent.push({ id, payload }); return { id: '900000000000000001', attachments: { first: () => null }, delete: async () => {} }; } });
    const guild = (id, channels) => ({ id, channels: { cache: new Map(channels.map((c) => [c, channel(c)])), fetch: async () => null } });
    return {
        sent,
        client: { guilds: { cache: new Map([[MAIN, guild(MAIN, [MAIN_CHANNEL])], [OTHER, guild(OTHER, [OWN_CHANNEL])]]) } },
    };
}
const IMAGE = { contentType: 'image/png', url: 'https://cdn.example/x.png', name: 'x.png' };
const addedBy = { id: MODERATOR, username: 'mod' };

test('addImageEvidence: another server without an evidence or mod log channel → a clear "not set up in this server"', async () => {
    setSettingsCacheForTests(OTHER, {});
    const { client, sent } = evidenceClient();
    await assert.rejects(addImageEvidence(client, 'abc2345', IMAGE, { addedBy, guildId: OTHER }),
        (error) => /not set up in this server/.test(error.userMessage) && !/EVIDENCE_CHANNEL_ID/.test(error.userMessage));
    assert.equal(sent.length, 0, 'never posted in the main server\'s evidence channel');
});

test('addImageEvidence: re-hosted in the case server\'s own channel (evidence, else its mod log); no guildId → refused', async () => {
    const { client, sent } = evidenceClient();
    setSettingsCacheForTests(OTHER, { modLogChannelId: OWN_CHANNEL });
    await withPool((sql) => (/INSERT INTO/.test(sql) ? [{ id: 1, kind: 'image', store_channel_id: OWN_CHANNEL }] : []), async () => {
        const row = await addImageEvidence(client, 'abc2345', IMAGE, { addedBy, guildId: OTHER });
        assert.equal(row.store_channel_id, OWN_CHANNEL);
    });
    assert.deepEqual(sent.map((s) => s.id), [OWN_CHANNEL]);
    await assert.rejects(addImageEvidence(client, 'abc2345', IMAGE, { addedBy }), TypeError);
    resetSettingsCacheForTests();
    await assert.rejects(addImageEvidence(client, 'abc2345', IMAGE, { addedBy, guildId: OTHER }), SettingsUnavailableError);
    assert.equal(sent.length, 1);
});

// ── Independent appeal review ─────────────────────────────────────────────

test('independent review: per server; the main server\'s "on" never applies elsewhere; unread → throws, not "off"', () => {
    const record = { guild_id: OTHER, moderator_id: MODERATOR, is_auto: false };
    setSettingsCacheForTests(MAIN, { independentAppealReview: true });
    setSettingsCacheForTests(OTHER, {});
    assert.equal(isIndependentReviewOn(MAIN), true);
    assert.equal(isIndependentReviewOn(OTHER), false, 'nothing stored there: off');
    assert.deepEqual(checkAppealReviewer(record, MODERATOR, { isOwner: () => false }), { allowed: true });
    setSettingsCacheForTests(OTHER, { independentAppealReview: true });
    assert.equal(checkAppealReviewer(record, MODERATOR, { isOwner: () => false }).allowed, false);
    resetSettingsCacheForTests();
    assert.throws(() => isIndependentReviewOn(OTHER), SettingsUnavailableError);
    assert.throws(() => checkAppealReviewer(record, MODERATOR, { isOwner: () => false }), SettingsUnavailableError);
    assert.equal(isIndependentReviewOn(null), false);
});

// ── Panel templates ───────────────────────────────────────────────────────

test('panel templates: each server its own list; unread other server throws', () => {
    const template = { name: 'Spam ban', action: 'ban', reasonKey: 'spam' };
    setSettingsCacheForTests(MAIN, { enforcementTemplates: [template] });
    setSettingsCacheForTests(OTHER, {});
    assert.deepEqual(readTemplates(MAIN), [template]);
    assert.deepEqual(readTemplates(OTHER), [], 'the main server\'s templates are not offered elsewhere');
    resetSettingsCacheForTests();
    assert.throws(() => readTemplates(OTHER), SettingsUnavailableError);
});

// ── Admin refusal ─────────────────────────────────────────────────────────

test('admin refusal: another server names only its own request channel; the support server never gets the env channel', () => {
    setSettingsCacheForTests(OTHER, {});
    const neutral = getAdminRequiredMessage(OTHER);
    assert.ok(!neutral.includes(MAIN_CHANNEL), 'not the main server\'s channel');
    assert.match(neutral, /Ask an admin of this server/);
    setSettingsCacheForTests(OTHER, { adminRequestChannelId: OWN_CHANNEL });
    assert.match(getAdminRequiredMessage(OTHER), new RegExp(`<#${OWN_CHANNEL}>`));
    // Support (home, but resolveSetting would lend it ADMIN_REQUEST_CHANNEL_ID): only what it stored.
    assert.ok(!getAdminRequiredMessage(SUPPORT).includes(MAIN_CHANNEL));
    // Settings unreadable: still a refusal, with the neutral wording.
    resetSettingsCacheForTests();
    assert.match(getAdminRequiredMessage(OTHER), /Ask an admin of this server/);
});
