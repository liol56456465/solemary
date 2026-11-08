// B1 "case lookups": no case of one server can be read or changed from another server. Mewvo's
// main and support servers count as one (as in isCaseOfCallerServer). Each entry point refuses
// another server's code in both directions and still works for its own server's codes. The pool
// is faked: it returns the stored row for any code, so every refusal below comes from the code
// under test, not from the SQL.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import {
    caseServerGuildIds, getCaseByCode, getCaseByCodeAnyServer, getLatestAppealStatuses, isSameCaseServer, listUserAppeals,
} from '../src/services/enforcement/caseService.js';
import { editCase, voidCase } from '../src/services/enforcement/caseEditService.js';
import { buildCaseDossier } from '../src/services/enforcement/appealService.js';
import { resolveContestCase } from '../src/handlers/automodContest.js';
import { handleCaseSearchSelect } from '../src/handlers/caseSearchView.js';
import { handleReviewAction } from '../src/services/automod/reviewCards.js';
import { staffActivityForWeek } from '../src/services/staffActivityService.js';
import { getMemberStanding } from '../src/services/enforcement/standingService.js';
import { linkedUserId } from '../src/services/modmailLinks.js';
import caseCommand from '../src/commands/Enforcement/case.js';
import appealsCommand from '../src/commands/Enforcement/appeals.js';
import { handleInteractionError } from '../src/utils/errorHandler.js';
import { resetSettingsCacheForTests, setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';

// The env ids too: appealStaffGuildId / isHomeGuild read MAIN_GUILD_ID / SUPPORT_GUILD_ID.
process.env.MAIN_GUILD_ID ||= '1700000000000000001';
process.env.SUPPORT_GUILD_ID ||= '1700000000000000002';
const MAIN = process.env.MAIN_GUILD_ID;
const SUPPORT = process.env.SUPPORT_GUILD_ID;
const OTHER = '1800000000000000009';
const THIRD = '1800000000000000077';
const ADMIN = '1700000000000000300';
const TARGET = '1700000000000000500';
const CODE = 'abc2345';

const saved = { main: enforcementConfig.mainGuildId, support: enforcementConfig.supportGuildId };
function homeIds() {
    enforcementConfig.mainGuildId = MAIN;
    enforcementConfig.supportGuildId = SUPPORT;
    for (const id of [MAIN, SUPPORT, OTHER, THIRD]) setSettingsCacheForTests(id, {});
}
afterEach(() => {
    resetSettingsCacheForTests();
    enforcementConfig.mainGuildId = saved.main;
    enforcementConfig.supportGuildId = saved.support;
});

const caseIn = (guildId, over = {}) => ({
    id: 1, guild_id: guildId, case_code: CODE, type: 'warn', name: 'cat warn 1', status: 'active',
    target_user_id: TARGET, target_username: 'target', moderator_id: '1700000000000000200', moderator_username: 'issuer',
    reason: 'spam', prebuilt_or_custom: 'prebuilt', reason_key: null, is_auto: false, is_test: true, tags: [],
    created_at: new Date('2026-10-01T00:00:00Z'), ladder_level_after: 0, dm_delivered: true, ...over,
});

/** Fake pool: every mod_cases lookup by code returns `record`; records each query + params. */
function installPool({ record = null, rows = () => null } = {}) {
    const queries = [];
    const answer = (text, params = []) => {
        const sql = String(text).replace(/\s+/g, ' ').trim();
        queries.push({ sql, params });
        const custom = rows(sql, params);
        if (custom) return custom;
        if (/FROM \S*mod_cases\S* WHERE case_code = \$1/.test(sql)) return { rows: record ? [record] : [] };
        return { rows: [], rowCount: 0 };
    };
    const savedPool = pgDb.pool;
    const savedConnected = pgDb.isConnected;
    pgDb.pool = {
        query: async (text, params) => answer(text, params),
        connect: async () => ({ query: async (text, params) => answer(text, params), release() {} }),
    };
    pgDb.isConnected = true;
    return {
        queries,
        writes: () => queries.filter((q) => /^(UPDATE|INSERT|DELETE)/.test(q.sql)),
        restore() { pgDb.pool = savedPool; pgDb.isConnected = savedConnected; },
    };
}
async function withPool(options, fn) {
    const pool = installPool(options);
    try { return await fn(pool); } finally { pool.restore(); }
}

// Pairs (case's server, caller's server) that must be refused, and pairs that must work.
const CROSS = [[OTHER, MAIN], [OTHER, SUPPORT], [MAIN, OTHER], [SUPPORT, OTHER], [THIRD, OTHER]];
const OWN = [[MAIN, MAIN], [SUPPORT, MAIN], [MAIN, SUPPORT], [OTHER, OTHER]];

const fakeClient = () => ({
    user: { id: '1700000000000000100', username: 'Mewvo' },
    guilds: { cache: new Map(), fetch: async () => null },
    users: { fetch: async () => { throw new Error('unknown user'); }, cache: new Map() },
    channels: { cache: new Map(), fetch: async () => null },
});

function fakeInteraction({ guildId, options = {}, group = null, sub = null, values = [] } = {}) {
    const replies = [];
    return {
        replies,
        id: '1700000000000009999',
        createdTimestamp: Date.now(),
        guildId,
        guild: { id: guildId, channels: { cache: new Map(), fetch: async () => null } },
        deferred: true,
        replied: false,
        values,
        user: { id: ADMIN, username: 'admin' },
        member: { id: ADMIN, guild: { ownerId: 'someone' }, permissions: { has: (p) => p === PermissionFlagsBits.Administrator } },
        options: {
            getString: (name) => options[name] ?? null,
            getInteger: (name) => options[name] ?? null,
            getAttachment: () => null,
            getUser: () => null,
            getSubcommandGroup: () => group,
            getSubcommand: () => sub,
        },
        isRepliable: () => true,
        isChatInputCommand: () => true,
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); return payload; },
        followUp: async (payload) => { replies.push(payload); return payload; },
        reply: async (payload) => { replies.push(payload); return payload; },
    };
}
const replyText = (interaction) => interaction.replies.flatMap((p) => [p.content || '', ...(p.embeds || []).map((e) => {
    const d = e.data || e;
    return `${d.title || ''}\n${d.description || ''}`;
})]).join('\n');

// ── The lookup itself ─────────────────────────────────────────────────────

test('isSameCaseServer / caseServerGuildIds: home servers are one, any other server only itself', () => {
    homeIds();
    for (const [own, caller] of OWN) assert.equal(isSameCaseServer(own, caller), true, `${own} from ${caller}`);
    for (const [own, caller] of CROSS) assert.equal(isSameCaseServer(own, caller), false, `${own} from ${caller}`);
    assert.equal(isSameCaseServer(MAIN, null), false);
    assert.equal(isSameCaseServer(null, MAIN), false);
    assert.deepEqual(caseServerGuildIds(SUPPORT), [MAIN, SUPPORT]);
    assert.deepEqual(caseServerGuildIds(OTHER), [OTHER]);
    assert.deepEqual(caseServerGuildIds(null), []);
});

test('getCaseByCode: another server\'s case is null (both directions); own server\'s case is returned', async () => {
    homeIds();
    for (const [own, caller] of CROSS) {
        await withPool({ record: caseIn(own) }, async () => {
            assert.equal(await getCaseByCode(CODE, caller), null, `${own} from ${caller}`);
        });
    }
    for (const [own, caller] of OWN) {
        await withPool({ record: caseIn(own) }, async () => {
            assert.equal((await getCaseByCode(CODE, caller))?.guild_id, own, `${own} from ${caller}`);
        });
    }
});

test('getCaseByCode refuses to run without a guild; getCaseByCodeAnyServer is the explicit any-server lookup', async () => {
    homeIds();
    await withPool({ record: caseIn(OTHER) }, async (pool) => {
        await assert.rejects(getCaseByCode(CODE), /needs the guildId/);
        await assert.rejects(getCaseByCode(CODE, ''), /needs the guildId/);
        assert.equal(pool.queries.length, 0, 'nothing read');
        assert.equal((await getCaseByCodeAnyServer(CODE)).guild_id, OTHER);
    });
});

// ── /case edit | remove (caseEditService) ─────────────────────────────────

test('editCase / voidCase: another server\'s case is "no case in this server", nothing written (both directions)', async () => {
    homeIds();
    const editor = { id: ADMIN, username: 'admin' };
    // The edit service compares strictly (as before): only the exact server, not its home twin.
    for (const [own, caller] of [...CROSS, [SUPPORT, MAIN], [MAIN, SUPPORT]]) {
        await withPool({ record: caseIn(own) }, async (pool) => {
            await assert.rejects(editCase(fakeClient(), { guildId: caller, caseCode: CODE, editor, reason: 'new' }),
                (error) => /No case with code `abc2345` in this server\./.test(error.userMessage), `edit ${own} from ${caller}`);
            await assert.rejects(voidCase(fakeClient(), { guildId: caller, caseCode: CODE, admin: editor, reason: 'x' }),
                (error) => /No case with code `abc2345` in this server\./.test(error.userMessage), `void ${own} from ${caller}`);
            assert.deepEqual(pool.writes(), []);
        });
    }
});

test('editCase: own server\'s case is edited', async () => {
    homeIds();
    for (const guildId of [MAIN, OTHER]) {
        const record = caseIn(guildId);
        await withPool({
            record,
            rows: (sql) => (/WHERE id = \$1 FOR UPDATE/.test(sql) ? { rows: [record] }
                : /^UPDATE \S*mod_cases\S* SET reason/.test(sql) ? { rows: [{ ...record, reason: 'new' }] } : null),
        }, async (pool) => {
            const { changes } = await editCase(fakeClient(), { guildId, caseCode: CODE, editor: { id: ADMIN, username: 'admin' }, reason: 'new' });
            assert.deepEqual(changes.map((c) => c.field), ['reason']);
            assert.ok(pool.writes().some((q) => /SET reason = \$2/.test(q.sql)));
        });
    }
});

// ── /case history and /case evidence list ─────────────────────────────────

test('/case history and /case evidence list: another server\'s code is refused; own code shown', async () => {
    homeIds();
    const run = async (record, sub, group = null) => withPool({ record }, async (pool) => {
        const interaction = fakeInteraction({ guildId: MAIN, options: { code: CODE }, group, sub });
        const error = await caseCommand.execute(interaction, {}, fakeClient()).then(() => null, (e) => e);
        if (error) await handleInteractionError(interaction, error, { type: 'command', commandName: 'case' });
        return { text: replyText(interaction), writes: pool.writes() };
    });
    for (const [group, sub] of [[null, 'history'], ['evidence', 'list'], ['note', 'list']]) {
        for (const own of [OTHER, THIRD, SUPPORT]) {
            const { text, writes } = await run(caseIn(own), sub, group);
            assert.match(text, /No case with code `abc2345` in this server\./, `${group} ${sub} on ${own}`);
            assert.ok(!/cat warn 1/.test(text), 'nothing of the case shown');
            assert.deepEqual(writes, []);
        }
        const { text } = await run(caseIn(MAIN), sub, group);
        assert.ok(!/No case with code/.test(text), `${group} ${sub} own: ${text}`);
        assert.match(text, /abc2345/);
    }
});

test('/case in another server (multi-server B1): only that server\'s own cases', async () => {
    homeIds();
    const run = (record) => withPool({ record }, async () => {
        const interaction = fakeInteraction({ guildId: OTHER, options: { code: CODE }, sub: 'history' });
        const error = await caseCommand.execute(interaction, {}, fakeClient()).then(() => null, (e) => e);
        if (error) await handleInteractionError(interaction, error, { type: 'command', commandName: 'case' });
        return replyText(interaction);
    });
    for (const own of [MAIN, SUPPORT, THIRD]) {
        const text = await run(caseIn(own));
        assert.match(text, /No case with code `abc2345` in this server\./, own);
        assert.ok(!/cat warn 1/.test(text));
    }
    assert.match(await run(caseIn(OTHER)), /abc2345/);
});

// ── /appeals code (dossier) ───────────────────────────────────────────────

test('/appeals code: another server\'s dossier is never shown (both directions); own dossier is', async () => {
    homeIds();
    const run = (record, guildId) => withPool({ record }, async () => {
        const interaction = fakeInteraction({ guildId, options: { code: CODE } });
        const error = await appealsCommand.execute(interaction, {}, fakeClient()).then(() => null, (e) => e);
        if (error) await handleInteractionError(interaction, error, { type: 'command', commandName: 'appeals' });
        return replyText(interaction);
    });
    for (const [own, caller] of CROSS) {
        const text = await run(caseIn(own), caller);
        // /appeals works in every server (B1) except Mewvo's Support server, each for its own cases.
        const refusal = caller === SUPPORT ? /Decide Mewvo appeals in the main server/ : /No case with code `abc2345` in this server\./;
        assert.match(text, refusal, `${own} from ${caller}: ${text}`);
        assert.ok(!/cat warn 1/.test(text), `${own} from ${caller}: no dossier`);
    }
    for (const [own, caller] of [[MAIN, MAIN], [SUPPORT, MAIN], [OTHER, OTHER]]) {
        assert.match(await run(caseIn(own), caller), /cat warn 1/, `${own} from ${caller}`);
    }
});

test('buildCaseDossier: the member\'s appeal count and statuses are read for this case\'s server only', async () => {
    homeIds();
    for (const [record, staff] of [[caseIn(MAIN), MAIN], [caseIn(SUPPORT), MAIN], [caseIn(OTHER), OTHER]]) {
        await withPool({ record }, async (pool) => {
            await buildCaseDossier(record, { client: fakeClient() });
            const userQueries = pool.queries.filter((q) => /FROM \S*mod_appeals\S* WHERE user_id = \$1/.test(q.sql));
            assert.equal(userQueries.length, 2);
            for (const q of userQueries) {
                assert.match(q.sql, /guild_id = \$2/);
                assert.equal(q.params[1], staff, `${record.guild_id} → ${staff}`);
            }
        });
    }
});

// ── /case search result menu ──────────────────────────────────────────────

test('/case search result menu: another server\'s code reads as gone; own code opens', async () => {
    homeIds();
    const open = (record) => withPool({ record }, async () => {
        const interaction = fakeInteraction({ guildId: MAIN, values: [CODE] });
        await handleCaseSearchSelect(interaction, fakeClient(), ['open', ADMIN]);
        return replyText(interaction);
    });
    for (const own of [OTHER, THIRD, SUPPORT]) {
        const text = await open(caseIn(own));
        assert.match(text, /That case no longer exists\./, own);
        assert.ok(!/cat warn 1/.test(text));
    }
    assert.match(await open(caseIn(MAIN)), /cat warn 1/);
    // Another server (multi-server B1): its own case opens, a main-server code reads as gone.
    const openIn = (record) => withPool({ record }, async () => {
        const interaction = fakeInteraction({ guildId: OTHER, values: [CODE] });
        await handleCaseSearchSelect(interaction, fakeClient(), ['open', ADMIN]);
        return replyText(interaction);
    });
    assert.match(await openIn(caseIn(OTHER)), /cat warn 1/);
    assert.match(await openIn(caseIn(MAIN)), /That case no longer exists\./);
});

// ── Automod review cards ──────────────────────────────────────────────────

test('automod review card Keep: another server\'s case code counts as gone (both directions); own is kept', async () => {
    homeIds();
    const press = (record, guildId) => withPool({ record }, async () => {
        const interaction = {
            ...fakeInteraction({ guildId }),
            client: fakeClient(),
            message: { id: `m${Math.random()}`, embeds: [], content: 'automod card', edit: async () => {}, reply: async () => null },
        };
        return handleReviewAction(interaction, ['keep', CODE]).then((text) => text, (e) => e.userMessage || e.message);
    });
    for (const [own, caller] of CROSS) {
        assert.match(await press(caseIn(own, { is_auto: true }), caller), /no longer exists/, `${own} from ${caller}`);
    }
    for (const [own, caller] of OWN) {
        assert.match(await press(caseIn(own, { is_auto: true }), caller), /^Kept `abc2345`/, `${own} from ${caller}`);
    }
});

// ── Automod "Contest this" (DM, no guild) ─────────────────────────────────

test('automod contest: any-server lookup; only the member\'s own automod case passes, in every server (B1)', async () => {
    homeIds();
    const automod = (guildId) => caseIn(guildId, { reason_key: 'automod:links' });
    // Automod runs in every server now: a member contests their own automod case of any server;
    // the contest goes to that case's own server's review channel (automodContest.markReviewCard).
    for (const guildId of [MAIN, OTHER, THIRD]) {
        await withPool({ record: automod(guildId) }, async () => {
            assert.equal((await resolveContestCase(TARGET, CODE)).record?.case_code, CODE, guildId);
            assert.match((await resolveContestCase(ADMIN, CODE)).error, /Only the member/, guildId);
        });
    }
    // Not an automod case: never contestable, whatever the server.
    await withPool({ record: caseIn(OTHER) }, async () => {
        assert.ok((await resolveContestCase(TARGET, CODE)).error, 'manual case');
    });
});

// ── Appeal statuses and standing lists ────────────────────────────────────

test('getLatestAppealStatuses: scoped to the caller\'s server (home = both home servers); needs a guild', async () => {
    homeIds();
    await withPool({}, async (pool) => {
        await assert.rejects(getLatestAppealStatuses(TARGET), /needs the guildId/);
        await getLatestAppealStatuses(TARGET, MAIN);
        await getLatestAppealStatuses(TARGET, OTHER);
        const [home, other] = pool.queries;
        assert.match(home.sql, /c\.guild_id = ANY\(\$2::varchar\[\]\)/);
        assert.deepEqual(home.params, [TARGET, [MAIN, SUPPORT]]);
        assert.deepEqual(other.params, [TARGET, [OTHER]]);
    });
});

test('listUserAppeals: the member\'s own list spans servers; a standing view is scoped to its server', async () => {
    homeIds();
    await withPool({ rows: (sql) => (/mod_ladder/.test(sql) ? { rows: [] } : null) }, async (pool) => {
        await listUserAppeals(TARGET, 10);
        assert.deepEqual(pool.queries[0].params, [TARGET, 10], 'own list: every server');
        await listUserAppeals(TARGET, 5, { guildId: OTHER });
        assert.deepEqual(pool.queries[1].params, [TARGET, 5, [OTHER]]);
        await getMemberStanding(OTHER, TARGET).catch(() => null);
        const standing = pool.queries.find((q) => /FROM \S*mod_appeals\S* a JOIN/.test(q.sql) && q !== pool.queries[0] && q !== pool.queries[1]);
        assert.deepEqual(standing?.params, [TARGET, 5, [OTHER]], 'standing of OTHER never lists other servers\' appeals');
    });
});

test('staff activity: appeal decisions are counted for this server only', async () => {
    homeIds();
    await withPool({}, async (pool) => {
        const guild = { id: OTHER, client: { user: { id: '1700000000000000100' } }, members: { cache: new Map() } };
        await staffActivityForWeek(guild, '2026-11-02');
        const appeals = pool.queries.find((q) => /FROM \S*mod_appeals/.test(q.sql));
        assert.match(appeals.sql, /guild_id = \$3/);
        assert.equal(appeals.params[2], OTHER);
    });
});

// ── Modmail links ─────────────────────────────────────────────────────────

test('modmail link: a channel resolves to its member only in the server the link was stored for', async () => {
    const CHANNEL = '1900000000000000001';
    await withPool({ rows: (sql) => (/FROM \S*modmail_links/.test(sql) ? { rows: [{ channel_id: CHANNEL, guild_id: MAIN, user_id: TARGET }] } : null) }, async () => {
        assert.equal(await linkedUserId({ id: CHANNEL, guildId: MAIN }), TARGET, 'own server');
        assert.equal(await linkedUserId({ id: CHANNEL, guild: { id: MAIN } }), TARGET, 'own server (guild object)');
        assert.equal(await linkedUserId({ id: CHANNEL, guildId: OTHER }), null, 'another server');
        assert.equal(await linkedUserId({ id: '1900000000000000002', guildId: MAIN }), null, 'not a modmail channel');
    });
});
