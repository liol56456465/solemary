// Privileged intents from env (src/config/intents.js): the intent list, hasIntent, the startup
// warnings, and the guard at each feature's entry point (B5 T5). Plus the /gateway/bot boot line.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GatewayIntentBits } from 'discord.js';

process.env.MAIN_GUILD_ID ??= '100000000000000001';

const {
    buildIntents, hasIntent, featureAvailable, disabledFeatures, warnDisabledFeatures, INTENT_FEATURES, PRIVILEGED_INTENTS,
} = await import('../src/config/intents.js');
const { describeSessionStartLimit, logSessionStartLimit } = await import('../src/utils/sessionStartLimit.js');

const saved = { mc: process.env.ENABLE_MESSAGE_CONTENT, gm: process.env.ENABLE_GUILD_MEMBERS };
function setEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}
afterEach(() => {
    setEnv('ENABLE_MESSAGE_CONTENT', saved.mc);
    setEnv('ENABLE_GUILD_MEMBERS', saved.gm);
});

const TODAY = [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildBans, GatewayIntentBits.AutoModerationExecution,
    GatewayIntentBits.GuildInvites,
];
const sorted = (list) => [...list].sort((a, b) => a - b);

// ── the intent list ───────────────────────────────────────────────────────

test('unset or empty env: the same ten intents (nine + GuildInvites for invite tracking)', () => {
    assert.deepEqual(sorted(buildIntents({})), sorted(TODAY));
    assert.deepEqual(sorted(buildIntents({ ENABLE_MESSAGE_CONTENT: '', ENABLE_GUILD_MEMBERS: ' ' })), sorted(TODAY));
    assert.deepEqual(sorted(buildIntents({ ENABLE_MESSAGE_CONTENT: 'true', ENABLE_GUILD_MEMBERS: 'yes' })), sorted(TODAY));
});

test('false/0/no/off (any case) drops exactly that privileged intent', () => {
    for (const off of ['false', 'FALSE', '0', 'no', 'Off', ' false ']) {
        const noContent = buildIntents({ ENABLE_MESSAGE_CONTENT: off });
        assert.equal(noContent.includes(GatewayIntentBits.MessageContent), false, off);
        assert.equal(noContent.includes(GatewayIntentBits.GuildMembers), true, off);
        assert.equal(noContent.length, TODAY.length - 1);
        const noMembers = buildIntents({ ENABLE_GUILD_MEMBERS: off });
        assert.equal(noMembers.includes(GatewayIntentBits.GuildMembers), false, off);
        assert.equal(noMembers.includes(GatewayIntentBits.MessageContent), true, off);
    }
    const neither = buildIntents({ ENABLE_MESSAGE_CONTENT: 'false', ENABLE_GUILD_MEMBERS: 'false' });
    assert.deepEqual(sorted(neither), sorted(TODAY.filter((bit) => bit !== GatewayIntentBits.MessageContent && bit !== GatewayIntentBits.GuildMembers)));
});

test('hasIntent: privileged intents follow env, everything else is always on', () => {
    assert.equal(hasIntent('MessageContent', {}), true);
    assert.equal(hasIntent('MessageContent', { ENABLE_MESSAGE_CONTENT: 'false' }), false);
    assert.equal(hasIntent('GuildMembers', { ENABLE_GUILD_MEMBERS: '0' }), false);
    assert.equal(hasIntent('Guilds', { ENABLE_MESSAGE_CONTENT: 'false', ENABLE_GUILD_MEMBERS: 'false' }), true);
    // Reads process.env when no env is passed (the live path).
    setEnv('ENABLE_MESSAGE_CONTENT', 'false');
    assert.equal(hasIntent('MessageContent'), false);
    setEnv('ENABLE_MESSAGE_CONTENT', undefined);
    assert.equal(hasIntent('MessageContent'), true);
    assert.deepEqual(Object.values(PRIVILEGED_INTENTS), ['ENABLE_MESSAGE_CONTENT', 'ENABLE_GUILD_MEMBERS']);
});

// ── startup warnings ──────────────────────────────────────────────────────

test('every feature named in the task maps to the right intent', () => {
    const content = ['automodContent', 'counting', 'tagAutoResponses', 'prefixCommands'];
    const members = ['welcome', 'joinGate', 'memberLogs', 'muteReapply', 'roleRules', 'levelRoles'];
    for (const key of content) assert.equal(INTENT_FEATURES[key]?.intent, 'MessageContent', key);
    for (const key of members) assert.equal(INTENT_FEATURES[key]?.intent, 'GuildMembers', key);
    assert.equal(featureAvailable('counting', { ENABLE_MESSAGE_CONTENT: 'false' }), false);
    assert.equal(featureAvailable('counting', { ENABLE_GUILD_MEMBERS: 'false' }), true);
    assert.equal(featureAvailable('welcome', { ENABLE_GUILD_MEMBERS: 'false' }), false);
    assert.equal(featureAvailable('unknown-feature', { ENABLE_GUILD_MEMBERS: 'false', ENABLE_MESSAGE_CONTENT: 'false' }), true);
});

test('warnDisabledFeatures: nothing by default; one line per disabled feature, once per process', () => {
    const lines = [];
    assert.equal(warnDisabledFeatures((line) => lines.push(line), {}, { force: true }), 0);
    assert.deepEqual(lines, []);

    const env = { ENABLE_MESSAGE_CONTENT: 'false' };
    const expected = disabledFeatures(env);
    assert.ok(expected.length >= 4);
    assert.ok(expected.every((entry) => entry.intent === 'MessageContent' && entry.variable === 'ENABLE_MESSAGE_CONTENT'));
    assert.equal(warnDisabledFeatures((line) => lines.push(line), env, { force: true }), expected.length);
    assert.equal(lines.length, expected.length);
    assert.ok(lines.every((line) => line.startsWith('Intent MessageContent is off (ENABLE_MESSAGE_CONTENT=false): disabled: ')));
    // A second call (no force) in the same process logs nothing.
    assert.equal(warnDisabledFeatures((line) => lines.push(line), env), 0);
    assert.equal(lines.length, expected.length);
});

// ── guards at the entry points ────────────────────────────────────────────

test('tag auto-responses: no reply without Message Content', async () => {
    const { setTagsForTests, respondToTags } = await import('../src/services/community/tagService.js');
    setTagsForTests([{ id: 1, guild_id: 'g1', name: 'ip', content: 'play.example.com', trigger_kind: 'word', trigger: 'server ip', cooldown_s: 60, allow_channels: [], deny_channels: [], created_by: 'x', uses: 0 }]);
    const replies = [];
    const msg = (channelId) => ({ guild: { id: 'g1' }, author: { bot: false }, channel: { id: channelId, isThread: () => false }, content: 'what is the server ip', reply: async (body) => { replies.push(body); } });
    setEnv('ENABLE_MESSAGE_CONTENT', 'false');
    assert.equal(await respondToTags(msg('c1')), false);
    assert.equal(replies.length, 0);
    setEnv('ENABLE_MESSAGE_CONTENT', undefined);
    assert.equal(await respondToTags(msg('c2')), true);
    assert.equal(replies.length, 1);
});

test('automod: text filters see no text without Message Content; mention checks still run', async () => {
    const { contentHits } = await import('../src/services/automod/automodService.js');
    const message = (content, mentions = []) => ({
        id: 'm1', content, guildId: process.env.MAIN_GUILD_ID, channelId: 'c1', guild: { id: process.env.MAIN_GUILD_ID },
        client: { user: { id: 'bot' } }, author: { id: 'u1', username: 'amy', createdTimestamp: 0 },
        mentions: { users: new Map(mentions.map((u) => [u, { id: u }])), roles: new Map(), repliedUser: null },
        reference: null, attachments: new Map(),
    });
    const member = { id: 'u1', guild: { ownerId: 'o' }, joinedTimestamp: 0, permissions: { has: () => false } };
    const scam = message('claim free nitro at https://dlscord-gift.com/x');
    assert.ok((await contentHits(scam, member)).some((hit) => hit.rule === 'scam'));
    setEnv('ENABLE_MESSAGE_CONTENT', 'false');
    assert.deepEqual(await contentHits(scam, member), []);
    const pings = await contentHits(message('', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10']), member);
    assert.ok(pings.some((hit) => hit.rule === 'mentions'));
});

test('full member list: no fetch without Guild Members, the cache is returned as partial', async () => {
    const { fetchAllMembers, resetMemberFetchGate } = await import('../src/utils/memberFetchGate.js');
    resetMemberFetchGate();
    let calls = 0;
    const guild = { id: 'g9', memberCount: 50, members: { cache: new Map([['m1', {}]]), fetch: async () => { calls += 1; } } };
    setEnv('ENABLE_GUILD_MEMBERS', 'false');
    const result = await fetchAllMembers(guild);
    assert.equal(result.reason, 'no-intent');
    assert.equal(result.partial, true);
    assert.equal(result.members.size, 1);
    assert.equal(calls, 0);
    setEnv('ENABLE_GUILD_MEMBERS', undefined);
    assert.equal((await fetchAllMembers(guild)).reason, 'fetched');
    assert.equal(calls, 1);
});

test('member events (welcome, join gate, member logs, mute re-apply, role and level rules) return before touching the member', async () => {
    // A member that throws on any property read: the guard must run first.
    const untouchable = new Proxy({}, { get: (_, key) => { throw new Error(`member.${String(key)} read`); } });
    setEnv('ENABLE_GUILD_MEMBERS', 'false');
    for (const file of ['guildMemberAdd', 'guildMemberRemove', 'guildMemberUpdate']) {
        const { default: event } = await import(`../src/events/${file}.js`);
        const args = file === 'guildMemberUpdate' ? [untouchable, untouchable] : [untouchable];
        assert.equal(await event.execute(...args), undefined, file);
    }
});

test('messageCreate: counting, prefix commands and the modmail staff relay check the intent first', async () => {
    // These handlers are module-private; the guard must be their first statement.
    const source = await readFile(new URL('../src/events/messageCreate.js', import.meta.url), 'utf8');
    const firstStatement = (fn) => {
        const start = source.indexOf(`async function ${fn}(`);
        assert.ok(start !== -1, fn);
        const body = source.slice(source.indexOf('{', start) + 1);
        return body.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('//'))[0];
    };
    assert.equal(firstStatement('handleCountingGame'), "if (!featureAvailable('counting')) return false;");
    assert.equal(firstStatement('handlePrefixCommand'), "if (!featureAvailable('prefixCommands')) return false;");
    assert.equal(firstStatement('relayModmailStaffMessage'), "if (!featureAvailable('modmailStaffRelay')) return;");
    // Tag auto-responses only run when the prefix handler says "not a command" (false).
    assert.match(source, /if \(await handlePrefixCommand\(message, client\) === false\) await respondToTags\(message\);/);
});

test('the client constructor takes its intents from buildIntents()', async () => {
    const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
    assert.match(source, /intents: buildIntents\(\),/);
    assert.doesNotMatch(source, /GatewayIntentBits\./);
});

// ── session start limit at boot ───────────────────────────────────────────

test('session start limit: one line from /gateway/bot, a warning when low, never throws', async () => {
    const body = { url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { total: 1000, remaining: 998, reset_after: 86_000_000, max_concurrency: 1 } };
    assert.equal(describeSessionStartLimit(body), 'Session starts: 998 of 1000 left today (reset in 23.9 h), max concurrency 1, recommended shards 1');
    assert.match(describeSessionStartLimit({ session_start_limit: { ...body.session_start_limit, remaining: 12 } }), /LOW: check for a restart loop/);
    assert.match(describeSessionStartLimit({}), /unknown/);

    const logs = [];
    const warns = [];
    const routes = [];
    const ok = { rest: { get: async (route) => { routes.push(route); return body; } } };
    assert.match(await logSessionStartLimit(ok, { log: (l) => logs.push(l), warn: (l) => warns.push(l) }), /998 of 1000/);
    assert.deepEqual(routes, ['/gateway/bot']);
    assert.equal(logs.length, 1);
    assert.equal(warns.length, 0);

    const failing = { rest: { get: async () => { throw new Error('503 Service Unavailable'); } } };
    assert.equal(await logSessionStartLimit(failing, { log: (l) => logs.push(l), warn: (l) => warns.push(l) }), null);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /could not read \/gateway\/bot \(503/);
});
