// Independent appeal review (setting independentAppealReview, default off): the moderator
// who issued a punishment cannot decide its appeal. Enforced once in decideAppeal(), so the
// Accept / Deny buttons, /appeals and the dashboard all refuse; OWNER_IDS may decide anyway
// (logged as an owner override); bot-issued cases (warn ladder, automod) never conflict.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { botConfig } from '../src/config/bot.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import { logger } from '../src/utils/logger.js';
import { resetSettingsCacheForTests, setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';
import { getSettingEntry, defaultValue } from '../src/services/settings/settingsRegistry.js';
import {
    SECOND_REVIEWER_MESSAGE, checkAppealReviewer, hasHumanIssuer, isIndependentReviewOn, needsSecondReviewer,
} from '../src/services/enforcement/appealReviewer.js';
import { buildCaseDossier, decideAppeal } from '../src/services/enforcement/appealService.js';
import { handleAppealDecisionButton } from '../src/handlers/appealsHandler.js';
import appealsCommand from '../src/commands/Enforcement/appeals.js';
import { handleInteractionError } from '../src/utils/errorHandler.js';

const GUILD = '1700000000000000001';
const BOT = '1700000000000000100';
const ISSUER = '1700000000000000200';
const OTHER = '1700000000000000300';
const OWNER = '1700000000000000400';
const TARGET = '1700000000000000500';

const humanCase = (over = {}) => ({
    id: 1, guild_id: GUILD, case_code: 'abc2345', type: 'ban', name: 'cat ban 1', status: 'appeal_pending',
    target_user_id: TARGET, target_username: 'target', moderator_id: ISSUER, moderator_username: 'issuer',
    is_auto: false, is_test: true, reason: 'spam', created_at: new Date('2026-10-01T00:00:00Z'), ...over,
});
const ladderCase = (over = {}) => humanCase({ moderator_id: BOT, moderator_username: 'Meowist', is_auto: true, reason_key: 'warn_ladder', ...over });
const automodCase = (over = {}) => humanCase({ moderator_id: BOT, moderator_username: 'Meowist', is_auto: false, reason_key: 'automod:spam', ...over });

const settingOn = () => setSettingsCacheForTests(GUILD, { independentAppealReview: true });
const settingOff = () => setSettingsCacheForTests(GUILD, { independentAppealReview: false });

const savedOwners = [...botConfig.commands.owners];
const savedMain = enforcementConfig.mainGuildId;
afterEach(() => {
    resetSettingsCacheForTests();
    botConfig.commands.owners.splice(0, botConfig.commands.owners.length, ...savedOwners);
    enforcementConfig.mainGuildId = savedMain;
});

// ── A fake pool: decideAppeal reads the case, then (if allowed) the pending appeal ──

function installPool({ record, appeal = null }) {
    const queries = [];
    const answer = (text) => {
        queries.push(String(text).replace(/\s+/g, ' ').trim());
        if (/FROM \S*mod_cases\S* WHERE case_code = \$1/.test(text)) return { rows: record ? [record] : [] };
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
        restore() {
            pgDb.pool = savedPool;
            pgDb.isConnected = savedConnected;
        },
    };
}

const fakeClient = () => ({
    user: { id: BOT, username: 'Meowist' },
    guilds: { cache: new Map(), fetch: async () => null },
    users: { fetch: async () => { throw new Error('unknown user'); } },
});

const pendingAppeal = { id: 9, case_code: 'abc2345', kind: 'appeal', status: 'pending', guild_id: GUILD, channel_id: null, staff_channel_id: null };

async function withPool(options, fn) {
    const pool = installPool(options);
    try {
        return await fn(pool);
    } finally {
        pool.restore();
    }
}

function captureWarnings() {
    const lines = [];
    const original = logger.warn;
    logger.warn = (message, ...rest) => {
        lines.push(String(message));
        return original.call(logger, message, ...rest);
    };
    return { lines, restore: () => { logger.warn = original; } };
}

// ── The setting ───────────────────────────────────────────────────────────

test('setting: registered for the main server, boolean, default off, no env var', () => {
    const entry = getSettingEntry('independentAppealReview');
    assert.ok(entry);
    assert.equal(entry.kind, 'boolean');
    assert.equal(entry.guild, 'main');
    assert.equal(entry.env, null);
    assert.equal(defaultValue(entry), false);
    assert.equal(entry.schema.safeParse(true).success, true);
    assert.equal(entry.schema.safeParse('yes').success, false);
    resetSettingsCacheForTests();
    assert.equal(isIndependentReviewOn(GUILD), false, 'nothing stored: off');
    settingOn();
    assert.equal(isIndependentReviewOn(GUILD), true);
    assert.equal(isIndependentReviewOn(null), false);
});

// ── The rule (pure) ───────────────────────────────────────────────────────

test('rule: the issuing moderator is refused, other staff are allowed', () => {
    const owners = () => false;
    assert.deepEqual(checkAppealReviewer(humanCase(), ISSUER, { botUserId: BOT, enabled: true, isOwner: owners }),
        { allowed: false, message: SECOND_REVIEWER_MESSAGE });
    assert.deepEqual(checkAppealReviewer(humanCase(), OTHER, { botUserId: BOT, enabled: true, isOwner: owners }), { allowed: true });
    assert.equal(SECOND_REVIEWER_MESSAGE, 'You issued this punishment, so another staff member has to decide this appeal.');
});

test('rule: a bot owner who issued the case is allowed as an owner override', () => {
    const record = humanCase({ moderator_id: OWNER });
    assert.deepEqual(checkAppealReviewer(record, OWNER, { botUserId: BOT, enabled: true, isOwner: (id) => id === OWNER }),
        { allowed: true, ownerOverride: true });
    // An owner deciding someone else's case is not an override.
    assert.deepEqual(checkAppealReviewer(humanCase(), OWNER, { botUserId: BOT, enabled: true, isOwner: (id) => id === OWNER }), { allowed: true });
});

test('rule: warn-ladder and automod (bot-issued) cases never need a second reviewer', () => {
    for (const record of [ladderCase(), automodCase(), ladderCase({ moderator_id: ISSUER })]) {
        assert.equal(needsSecondReviewer(record, { botUserId: BOT, enabled: true }), false, record.reason_key);
    }
    assert.equal(hasHumanIssuer(automodCase(), BOT), false);
    assert.equal(hasHumanIssuer(humanCase(), BOT), true);
    // The bot id is the decider only in theory, but even then nothing is refused.
    assert.deepEqual(checkAppealReviewer(automodCase(), BOT, { botUserId: BOT, enabled: true, isOwner: () => false }), { allowed: true });
});

test('rule: setting off → everyone allowed, including the issuer', () => {
    assert.deepEqual(checkAppealReviewer(humanCase(), ISSUER, { botUserId: BOT, enabled: false, isOwner: () => false }), { allowed: true });
    resetSettingsCacheForTests();
    assert.deepEqual(checkAppealReviewer(humanCase(), ISSUER, { botUserId: BOT, isOwner: () => false }), { allowed: true }, 'default reads the setting: off');
    settingOn();
    assert.equal(checkAppealReviewer(humanCase(), ISSUER, { botUserId: BOT, isOwner: () => false }).allowed, false, 'default reads the setting: on');
});

// ── decideAppeal: the shared service every path calls ─────────────────────

test('decideAppeal: the issuer is refused before anything is read or written', async () => {
    settingOn();
    await withPool({ record: humanCase(), appeal: pendingAppeal }, async (pool) => {
        await assert.rejects(
            decideAppeal({ client: fakeClient(), admin: { id: ISSUER, username: 'issuer' }, caseCode: 'abc2345', decision: 'accept', note: null }),
            (error) => error.userMessage === SECOND_REVIEWER_MESSAGE && error.context?.expected === true,
        );
        assert.equal(pool.queries.length, 1, 'only the case lookup ran');
        assert.deepEqual(pool.writes(), []);
    });
});

test('decideAppeal: another staff member decides (deny) normally', async () => {
    settingOn();
    await withPool({ record: humanCase(), appeal: pendingAppeal }, async (pool) => {
        const result = await decideAppeal({ client: fakeClient(), admin: { id: OTHER, username: 'other' }, caseCode: 'abc2345', decision: 'deny', note: null, via: 'slash' });
        assert.equal(result.label, 'denied');
        assert.equal(result.ownerOverride, false);
        assert.ok(pool.writes().some((q) => /UPDATE \S*mod_appeals\S* SET status = \$2, decided_by = \$3/.test(q)), 'the appeal row was decided');
    });
});

test('decideAppeal: an owner deciding their own case is allowed and logged as an owner override', async () => {
    settingOn();
    botConfig.commands.owners.splice(0, botConfig.commands.owners.length, OWNER);
    const warnings = captureWarnings();
    try {
        await withPool({ record: humanCase({ moderator_id: OWNER, moderator_username: 'owner' }), appeal: pendingAppeal }, async () => {
            const result = await decideAppeal({ client: fakeClient(), admin: { id: OWNER, username: 'owner' }, caseCode: 'abc2345', decision: 'deny', note: null, via: 'button' });
            assert.equal(result.label, 'denied');
            assert.equal(result.ownerOverride, true);
        });
    } finally {
        warnings.restore();
    }
    const line = warnings.lines.find((l) => l.startsWith('Owner override:'));
    assert.ok(line, 'owner override logged');
    assert.match(line, new RegExp(`owner \\(${OWNER}\\) ran appeal denied on \`abc2345\` via button`));
    assert.match(line, /issued this punishment themselves \(independent appeal review is on\)/);
});

test('decideAppeal: an owner deciding someone else\'s case is not an override (nothing logged)', async () => {
    settingOn();
    botConfig.commands.owners.splice(0, botConfig.commands.owners.length, OWNER);
    const warnings = captureWarnings();
    try {
        await withPool({ record: humanCase(), appeal: pendingAppeal }, async () => {
            const result = await decideAppeal({ client: fakeClient(), admin: { id: OWNER, username: 'owner' }, caseCode: 'abc2345', decision: 'deny', note: null });
            assert.equal(result.ownerOverride, false);
        });
    } finally {
        warnings.restore();
    }
    assert.ok(!warnings.lines.some((l) => l.startsWith('Owner override:')));
});

test('decideAppeal: warn-ladder and automod cases are unaffected (the "issuer" is the bot)', async () => {
    settingOn();
    for (const record of [ladderCase(), automodCase()]) {
        await withPool({ record, appeal: pendingAppeal }, async () => {
            const result = await decideAppeal({ client: fakeClient(), admin: { id: BOT, username: 'Meowist' }, caseCode: 'abc2345', decision: 'deny', note: null });
            assert.equal(result.label, 'denied');
        });
    }
});

test('decideAppeal: setting off → the issuer decides exactly as before', async () => {
    for (const set of [settingOff, resetSettingsCacheForTests]) {
        set();
        await withPool({ record: humanCase(), appeal: pendingAppeal }, async (pool) => {
            const result = await decideAppeal({ client: fakeClient(), admin: { id: ISSUER, username: 'issuer' }, caseCode: 'abc2345', decision: 'deny', note: null });
            assert.equal(result.label, 'denied');
            assert.equal(result.ownerOverride, false);
            assert.ok(pool.writes().length > 0);
        });
        // And the usual "no pending appeal" refusal is unchanged.
        await withPool({ record: humanCase(), appeal: null }, async () => {
            await assert.rejects(
                decideAppeal({ client: fakeClient(), admin: { id: ISSUER, username: 'issuer' }, caseCode: 'abc2345', decision: 'accept', note: null }),
                (error) => /There is no pending appeal for `abc2345`/.test(error.userMessage),
            );
        });
    }
});

// ── Discord paths show the message ────────────────────────────────────────

function fakeInteraction({ guildId = GUILD, userId = ISSUER, options = {} } = {}) {
    const replies = [];
    return {
        replies,
        id: '1700000000000009999',
        createdTimestamp: Date.now(),
        guildId,
        deferred: true,
        replied: false,
        user: { id: userId, username: 'issuer' },
        member: { id: userId, guild: { ownerId: 'someone' }, permissions: { has: () => true } },
        options: { getString: (name) => options[name] ?? null },
        isRepliable: () => true,
        isChatInputCommand: () => Boolean(options.code),
        editReply: async (payload) => { replies.push(payload); return payload; },
        followUp: async (payload) => { replies.push(payload); return payload; },
        reply: async (payload) => { replies.push(payload); return payload; },
    };
}

const replyText = (interaction) => interaction.replies.flatMap((p) => (p.embeds || []).map((e) => (e.data || e).description || '')).join('\n');

test('Accept / Deny button: the issuer gets the message (nothing decided)', async () => {
    settingOn();
    enforcementConfig.mainGuildId = GUILD;
    await withPool({ record: humanCase(), appeal: pendingAppeal }, async (pool) => {
        const interaction = fakeInteraction();
        const error = await handleAppealDecisionButton(interaction, fakeClient(), ['accept', 'abc2345']).then(() => null, (e) => e);
        assert.ok(error, 'the button handler throws the refusal to the interaction error handler');
        await handleInteractionError(interaction, error, { type: 'button', handler: 'appealdecide' });
        assert.match(replyText(interaction), /You issued this punishment, so another staff member has to decide this appeal\./);
        assert.deepEqual(pool.writes(), []);
    });
});

test('/appeals code decision: the issuer gets the message (nothing decided)', async () => {
    settingOn();
    enforcementConfig.mainGuildId = GUILD;
    await withPool({ record: humanCase(), appeal: pendingAppeal }, async (pool) => {
        const interaction = fakeInteraction({ options: { code: 'abc2345', decision: 'deny' } });
        const error = await appealsCommand.execute(interaction, {}, fakeClient()).then(() => null, (e) => e);
        assert.ok(error);
        await handleInteractionError(interaction, error, { type: 'command', commandName: 'appeals' });
        assert.match(replyText(interaction), /You issued this punishment, so another staff member has to decide this appeal\./);
        assert.deepEqual(pool.writes(), []);
    });
});

test('/appeals code decision: another admin decides and the reply is the usual one', async () => {
    settingOn();
    enforcementConfig.mainGuildId = GUILD;
    await withPool({ record: humanCase(), appeal: pendingAppeal }, async () => {
        const interaction = fakeInteraction({ userId: OTHER, options: { code: 'abc2345', decision: 'deny' } });
        await appealsCommand.execute(interaction, {}, fakeClient());
        const embed = interaction.replies.at(-1).embeds[0];
        assert.match((embed.data || embed).title, /Appeal denied/);
        assert.ok(!/owner override/.test(replyText(interaction)));
    });
});

// ── Staff dossier embed ───────────────────────────────────────────────────

test('dossier: "Issued by … — needs a second reviewer" only when the setting is on and a person issued it', async () => {
    const field = async (record) => withPool({ record, appeal: null }, async () => {
        const embeds = await buildCaseDossier(record, { client: fakeClient() });
        return ((embeds[0].data || embeds[0]).fields || []).find((f) => f.name === 'Independent review') || null;
    });
    settingOn();
    assert.equal((await field(humanCase()))?.value, 'Issued by issuer — needs a second reviewer');
    assert.equal(await field(ladderCase()), null);
    assert.equal(await field(automodCase()), null);
    settingOff();
    assert.equal(await field(humanCase()), null);
});
