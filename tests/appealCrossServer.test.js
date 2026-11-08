// Multi-server: a server's staff see and decide only that server's appeals. decideAppeal refuses
// another server's case (both directions, no owner exception); the Accept / Deny / Claim buttons
// work in a non-home server for its own Administrators and its own cases; /appeals in the main
// server cannot open another server's dossier. Mewvo's two servers count as one (as before).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { botConfig } from '../src/config/bot.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import { resetSettingsCacheForTests, setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';
import {
    OTHER_SERVER_CASE, assertCaseOfCallerServer, decideAppeal, isCaseOfCallerServer,
} from '../src/services/enforcement/appealService.js';
import { canDecideAppeals, handleAppealDecisionButton } from '../src/handlers/appealsHandler.js';
import appealsCommand from '../src/commands/Enforcement/appeals.js';
import { handleInteractionError } from '../src/utils/errorHandler.js';

const MAIN = '1700000000000000001';
const SUPPORT = '1700000000000000002';
const OTHER = '1800000000000000009';
const THIRD = '1800000000000000077';
process.env.MAIN_GUILD_ID ??= MAIN;
process.env.SUPPORT_GUILD_ID ??= SUPPORT;
const BOT = '1700000000000000100';
const ADMIN = '1700000000000000300';
const OWNER = '1700000000000000400';
const TARGET = '1700000000000000500';

const caseIn = (guildId, over = {}) => ({
    id: 1, guild_id: guildId, case_code: 'abc2345', type: 'ban', name: 'cat ban 1', status: 'appeal_pending',
    target_user_id: TARGET, target_username: 'target', moderator_id: '1700000000000000200', moderator_username: 'issuer',
    is_auto: false, is_test: true, reason: 'spam', created_at: new Date('2026-10-01T00:00:00Z'), ...over,
});
// B1: another server's case code reads as unknown (getCaseByCode is scoped to the caller's server).
const NOT_IN_THIS_SERVER = /No case with code `abc2345` in this server\./;
const appealIn = (guildId) => ({ id: 9, case_code: 'abc2345', kind: 'appeal', status: 'pending', guild_id: guildId, channel_id: null, staff_channel_id: null });

const saved = {
    main: enforcementConfig.mainGuildId, support: enforcementConfig.supportGuildId, owners: [...botConfig.commands.owners],
};
function homeIds() {
    enforcementConfig.mainGuildId = process.env.MAIN_GUILD_ID;
    enforcementConfig.supportGuildId = process.env.SUPPORT_GUILD_ID;
    // The other servers' settings are "read" (empty): resolveSetting gives neutral defaults.
    setSettingsCacheForTests(OTHER, {});
    setSettingsCacheForTests(THIRD, {});
}
afterEach(() => {
    resetSettingsCacheForTests();
    enforcementConfig.mainGuildId = saved.main;
    enforcementConfig.supportGuildId = saved.support;
    botConfig.commands.owners.splice(0, botConfig.commands.owners.length, ...saved.owners);
});

function installPool({ record, appeal = null }) {
    const queries = [];
    const answer = (text) => {
        queries.push(String(text).replace(/\s+/g, ' ').trim());
        if (/FROM \S*mod_cases\S* WHERE case_code = \$1/.test(text)) return { rows: record ? [record] : [] };
        if (/mod_appeals\S* SET claimed_by/.test(text)) return { rows: appeal ? [{ user_id: TARGET, case_code: 'abc2345' }] : [] };
        if (/FROM \S*mod_appeals\S* WHERE case_code = \$1 AND kind = 'appeal' AND status = 'pending'/.test(text)) return { rows: appeal ? [appeal] : [] };
        return { rows: [], rowCount: 1 };
    };
    const savedPool = pgDb.pool;
    const savedConnected = pgDb.isConnected;
    pgDb.pool = {
        query: async (text) => answer(text),
        connect: async () => ({ query: async (text) => answer(text), release() {} }),
    };
    pgDb.isConnected = true;
    return {
        queries,
        writes: () => queries.filter((q) => /^(UPDATE|INSERT|DELETE)/.test(q)),
        restore() { pgDb.pool = savedPool; pgDb.isConnected = savedConnected; },
    };
}

async function withPool(options, fn) {
    const pool = installPool(options);
    try { return await fn(pool); } finally { pool.restore(); }
}

const fakeClient = () => ({
    user: { id: BOT, username: 'Mewvo' },
    guilds: { cache: new Map(), fetch: async () => null },
    users: { fetch: async () => { throw new Error('unknown user'); } },
});

function fakeInteraction({ guildId, userId = ADMIN, admin = true, options = {} } = {}) {
    const replies = [];
    return {
        replies,
        id: '1700000000000009999',
        createdTimestamp: Date.now(),
        guildId,
        deferred: true,
        replied: false,
        user: { id: userId, username: 'admin' },
        member: { id: userId, guild: { ownerId: 'someone' }, permissions: { has: (p) => admin && p === PermissionFlagsBits.Administrator } },
        options: { getString: (name) => options[name] ?? null },
        isRepliable: () => true,
        isChatInputCommand: () => Boolean(options.code),
        editReply: async (payload) => { replies.push(payload); return payload; },
        followUp: async (payload) => { replies.push(payload); return payload; },
        reply: async (payload) => { replies.push(payload); return payload; },
    };
}

const replyText = (interaction) => interaction.replies.flatMap((p) => (p.embeds || []).map((e) => {
    const d = e.data || e;
    return `${d.title || ''}\n${d.description || ''}`;
})).join('\n');

async function pressButton(interaction, args) {
    const error = await handleAppealDecisionButton(interaction, fakeClient(), args).then(() => null, (e) => e);
    if (error) await handleInteractionError(interaction, error, { type: 'button', handler: 'appealdecide' });
    return replyText(interaction);
}

// ── The rule ──────────────────────────────────────────────────────────────

test('isCaseOfCallerServer: home servers count as one; any other server only its own cases', () => {
    homeIds();
    assert.equal(isCaseOfCallerServer(caseIn(MAIN), MAIN), true);
    assert.equal(isCaseOfCallerServer(caseIn(SUPPORT), MAIN), true, 'a support-server case is decided in the main server, as before');
    assert.equal(isCaseOfCallerServer(caseIn(MAIN), SUPPORT), true, 'pressed in the support server, as before');
    assert.equal(isCaseOfCallerServer(caseIn(OTHER), OTHER), true);
    assert.equal(isCaseOfCallerServer(caseIn(OTHER), MAIN), false, 'main → other server: no');
    assert.equal(isCaseOfCallerServer(caseIn(OTHER), SUPPORT), false, 'support → other server: no');
    assert.equal(isCaseOfCallerServer(caseIn(MAIN), OTHER), false, 'other server → main: no');
    assert.equal(isCaseOfCallerServer(caseIn(SUPPORT), OTHER), false, 'other server → support: no');
    assert.equal(isCaseOfCallerServer(caseIn(OTHER), THIRD), false, 'between two other servers: no');
    assert.equal(isCaseOfCallerServer(caseIn(OTHER), null), false, 'no caller server: no');
    assert.throws(() => assertCaseOfCallerServer(caseIn(OTHER), MAIN), (e) => e.userMessage === OTHER_SERVER_CASE && e.context?.expected === true);
});

// ── decideAppeal ──────────────────────────────────────────────────────────

test('decideAppeal: needs the caller server', async () => {
    homeIds();
    await withPool({ record: caseIn(MAIN), appeal: appealIn(MAIN) }, async (pool) => {
        await assert.rejects(
            decideAppeal({ client: fakeClient(), admin: { id: ADMIN, username: 'admin' }, caseCode: 'abc2345', decision: 'deny', note: null }),
            /callerGuildId is required/,
        );
        assert.deepEqual(pool.writes(), []);
    });
});

test('decideAppeal: the main server cannot decide another server\'s appeal (nothing written, even for an owner)', async () => {
    homeIds();
    botConfig.commands.owners.splice(0, botConfig.commands.owners.length, OWNER);
    for (const admin of [{ id: ADMIN, username: 'admin' }, { id: OWNER, username: 'owner' }]) {
        for (const caller of [MAIN, SUPPORT]) {
            await withPool({ record: caseIn(OTHER), appeal: appealIn(OTHER) }, async (pool) => {
                await assert.rejects(
                    decideAppeal({ client: fakeClient(), admin, caseCode: 'abc2345', decision: 'accept', note: null, callerGuildId: caller }),
                    (error) => NOT_IN_THIS_SERVER.test(error.userMessage),
                );
                assert.equal(pool.queries.length, 1, 'only the case lookup ran');
                assert.deepEqual(pool.writes(), []);
            });
        }
    }
});

test('decideAppeal: another server cannot decide a home appeal, nor a third server\'s', async () => {
    homeIds();
    for (const [record, caller] of [[caseIn(MAIN), OTHER], [caseIn(SUPPORT), OTHER], [caseIn(THIRD), OTHER]]) {
        await withPool({ record, appeal: appealIn(record.guild_id) }, async (pool) => {
            await assert.rejects(
                decideAppeal({ client: fakeClient(), admin: { id: ADMIN, username: 'admin' }, caseCode: 'abc2345', decision: 'accept', note: null, callerGuildId: caller }),
                (error) => NOT_IN_THIS_SERVER.test(error.userMessage),
            );
            assert.deepEqual(pool.writes(), []);
        });
    }
});

test('decideAppeal: a server decides its own appeal; home decides home appeals as before', async () => {
    homeIds();
    for (const [record, caller] of [[caseIn(OTHER), OTHER], [caseIn(MAIN), MAIN], [caseIn(SUPPORT), MAIN]]) {
        await withPool({ record, appeal: appealIn(record.guild_id) }, async (pool) => {
            const result = await decideAppeal({ client: fakeClient(), admin: { id: ADMIN, username: 'admin' }, caseCode: 'abc2345', decision: 'deny', note: null, callerGuildId: caller });
            assert.equal(result.label, 'denied');
            assert.ok(pool.writes().some((q) => /UPDATE \S*mod_appeals\S* SET status = \$2, decided_by = \$3/.test(q)));
        });
    }
});

// ── Buttons ───────────────────────────────────────────────────────────────

test('canDecideAppeals: a non-home server\'s Administrators, for that server\'s own case only', async () => {
    homeIds();
    const at = (guildId, admin) => fakeInteraction({ guildId, admin });
    assert.equal(await canDecideAppeals(at(OTHER, true), fakeClient(), caseIn(OTHER)), true);
    assert.equal(await canDecideAppeals(at(OTHER, false), fakeClient(), caseIn(OTHER)), false, 'not an Administrator');
    assert.equal(await canDecideAppeals(at(OTHER, true), fakeClient(), null), false, 'no case: no');
    assert.equal(await canDecideAppeals(at(OTHER, true), fakeClient(), caseIn(THIRD)), false, 'a third server\'s case');
    assert.equal(await canDecideAppeals(at(OTHER, true), fakeClient(), caseIn(MAIN)), false, 'a home case');
});

test('button in another server: its Administrator denies its own appeal', async () => {
    homeIds();
    await withPool({ record: caseIn(OTHER), appeal: appealIn(OTHER) }, async (pool) => {
        const text = await pressButton(fakeInteraction({ guildId: OTHER }), ['deny', 'abc2345']);
        assert.match(text, /Appeal denied/);
        assert.ok(pool.writes().some((q) => /SET status = \$2, decided_by = \$3/.test(q)));
    });
});

test('button in another server: a member without Administrator is refused with this server\'s wording', async () => {
    homeIds();
    await withPool({ record: caseIn(OTHER), appeal: appealIn(OTHER) }, async (pool) => {
        const text = await pressButton(fakeInteraction({ guildId: OTHER, admin: false }), ['accept', 'abc2345']);
        assert.match(text, /Only administrators of this server can decide its appeals\./);
        assert.deepEqual(pool.writes(), []);
    });
});

test('buttons refuse a case of another server, both directions, also Claim', async () => {
    homeIds();
    for (const [record, at] of [[caseIn(MAIN), OTHER], [caseIn(OTHER), MAIN], [caseIn(THIRD), OTHER]]) {
        for (const action of ['accept', 'deny', 'claim']) {
            await withPool({ record, appeal: appealIn(record.guild_id) }, async (pool) => {
                const text = await pressButton(fakeInteraction({ guildId: at }), [action, 'abc2345']);
                assert.match(text, NOT_IN_THIS_SERVER, `${action} in ${at} on ${record.guild_id}`);
                assert.deepEqual(pool.writes(), []);
            });
        }
    }
});

test('button in the main server on a home case: decided as before', async () => {
    homeIds();
    await withPool({ record: caseIn(MAIN), appeal: appealIn(MAIN) }, async () => {
        const text = await pressButton(fakeInteraction({ guildId: MAIN }), ['deny', 'abc2345']);
        assert.match(text, /Appeal denied/);
    });
});

// ── /appeals (main server) ────────────────────────────────────────────────

test('/appeals code: the main server cannot view or decide another server\'s case', async () => {
    homeIds();
    for (const options of [{ code: 'abc2345' }, { code: 'abc2345', decision: 'accept' }]) {
        await withPool({ record: caseIn(OTHER), appeal: appealIn(OTHER) }, async (pool) => {
            const interaction = fakeInteraction({ guildId: MAIN, options });
            const error = await appealsCommand.execute(interaction, {}, fakeClient()).then(() => null, (e) => e);
            assert.ok(error, JSON.stringify(options));
            await handleInteractionError(interaction, error, { type: 'command', commandName: 'appeals' });
            assert.match(replyText(interaction), NOT_IN_THIS_SERVER);
            assert.ok(!/cat ban 1/.test(replyText(interaction)), 'no dossier shown');
            assert.deepEqual(pool.writes(), []);
        });
    }
});
