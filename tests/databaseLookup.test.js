// /database (owner only): structured read-only lookups with a fake query function, secret
// masking, pagination within embed limits, the owner/server checks in the gate, the command
// and the page buttons, and registration in OWNER_TOOLS_GUILD_ID only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const lookupLib = await import('../src/services/owner/databaseLookup.js');
const {
    HIDDEN, USER_SECTIONS, LookupInputError, createDatabaseLookup, createPageStore, isSensitiveName, likePattern,
    looksSecret, paginate, parseCaseCode, parseUserId, redact, PAGE_TEXT_MAX,
} = lookupLib;
const { DEFAULT_OWNER_TOOLS_GUILD_ID, ownerToolsGuildId } = await import('../src/config/ownerTools.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');
const { botConfig } = await import('../src/config/bot.js');
const { checkCommandAccess, canUseOwnerTools, isCommandAvailableInGuild, OWNER_TOOLS_REFUSAL } = await import('../src/utils/commandGate.js');
const { buildRegistrationBodies, collectCommandPayloads, registerCommandSets } = await import('../src/handlers/loaders/commandLoader.js');
const { commandEntries } = await import('../src/config/commands/retirement.js');
const { default: databaseCommand, runDatabaseCommand } = await import('../src/commands/Owner/database.js');
const { handleLookupButton } = await import('../src/interactions/buttons/owner/databaseLookup.js');
const { LOOKUP_DB_ERROR, LOOKUP_EXPIRED, lookupMessage, parseLookupArgs } = await import('../src/handlers/databaseLookupView.js');

const OWNER = '1999999999999999991';
const STRANGER = '1999999999999999992';
const USER = '1888888888888888881';
const OWNER_GUILD = DEFAULT_OWNER_TOOLS_GUILD_ID;
const MAIN = enforcementConfig.mainGuildId;

function withOwners(ids, fn) {
    const saved = botConfig.commands.owners;
    botConfig.commands.owners = ids;
    const restore = () => { botConfig.commands.owners = saved; };
    try {
        const out = fn();
        if (out?.then) return out.finally(restore);
        restore();
        return out;
    } catch (error) {
        restore();
        throw error;
    }
}

function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
    try {
        const out = fn();
        if (out?.then) return out.finally(restore);
        restore();
        return out;
    } catch (error) {
        restore();
        throw error;
    }
}

/** A fake query: records every call, answers with `answer(text, params)` rows. */
function fakeQuery(answer = () => []) {
    const calls = [];
    const query = async (text, params = []) => {
        calls.push({ text, params });
        return { rows: answer(text, params) };
    };
    return { query, calls };
}

// ── Inputs ───────────────────────────────────────────────────────────────

test('parse inputs: user ids and mentions, case codes', () => {
    assert.equal(parseUserId(USER), USER);
    assert.equal(parseUserId(`<@${USER}>`), USER);
    assert.equal(parseUserId(`<@!${USER}>`), USER);
    assert.equal(parseUserId('abc'), null);
    assert.equal(parseUserId(`${USER}; DROP TABLE mod_cases`), null);
    assert.equal(parseCaseCode(' AbC23x '), 'abc23x');
    assert.equal(parseCaseCode('ab'), null);
    assert.equal(parseCaseCode("x' OR 1=1"), null);
});

test('likePattern escapes \\, % and _ so they match literally', () => {
    assert.equal(likePattern('50%_off\\'), '%50\\%\\_off\\\\%');
    assert.equal(likePattern('plain'), '%plain%');
});

// ── Secrets ──────────────────────────────────────────────────────────────

test('secret names: token, secret, password, session, key, hash (any case, any position)', () => {
    for (const name of ['token', 'access_token', 'refreshToken', 'client_secret', 'password_hash', 'id_hash', 'session',
        'sessionId', 'api_key', 'reason_key', 'OAUTH_TOKEN_KEY', 'csrf', 'totp_secret_enc', 'ip_hash']) {
        assert.equal(isSensitiveName(name), true, name);
    }
    for (const name of ['case_code', 'reason', 'username', 'guild_id', 'created_at', 'code_end', 'status']) {
        assert.equal(isSensitiveName(name), false, name);
    }
});

test('secret-looking values are hidden whatever the column is called', () => {
    assert.equal(looksSecret('MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789'), true, 'bot token');
    assert.equal(looksSecret('postgresql://mewvo:hunter2@db.example.com/mewvo'), true, 'db url with password');
    assert.equal(looksSecret('a'.repeat(64)), true, 'sha-256 hex');
    assert.equal(looksSecret('Zm9vYmFyYmF6cXV4MTIz:YWJjZGVmZ2hpamtsbW5vcA:cXdlcnR5dWlvcGFzZGZnaA'), true, 'iv:tag:data');
    assert.equal(looksSecret('Reached warning limit'), false);
    assert.equal(looksSecret('https://discord.com/channels/1/2/3'), false);
    assert.equal(looksSecret(`${USER}:${USER}`), false, 'two snowflakes are not a secret');
});

test('redact: nested JSON, arrays and settings; normal values stay', () => {
    const out = redact({
        username: 'alice',
        config: { oauth: { accessToken: 'abc', scope: 'identify' }, list: [{ secret: 'x' }, 'fine'], channelId: '123' },
        password_hash: 'scrypt$...',
        note: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789',
        when: new Date(0),
        big: 12n,
        bytes: Buffer.from('x'),
    });
    assert.equal(out.username, 'alice');
    assert.equal(out.config.oauth.accessToken, HIDDEN);
    assert.equal(out.config.oauth.scope, 'identify');
    assert.equal(out.config.list[0].secret, HIDDEN);
    assert.equal(out.config.list[1], 'fine');
    assert.equal(out.config.channelId, '123');
    assert.equal(out.password_hash, HIDDEN);
    assert.equal(out.note, HIDDEN);
    assert.ok(out.when instanceof Date);
    assert.equal(out.big, '12');
    assert.equal(out.bytes, HIDDEN);
});

test('PROOF: secrets returned by the database never reach the rendered pages', async () => {
    const secrets = {
        token: 'tok-AAAA-1111', refresh_token: 'ref-BBBB-2222', password_hash: 'scrypt$CCCC$3333', session_id: 'sess-DDDD-4444',
        csrf: 'csrf-EEEE-5555', totp_secret_enc: 'enc-FFFF-6666', api_key: 'key-GGGG-7777', ip_hash: 'iph-HHHH-8888',
        botToken: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789',
        dbUrl: 'postgres://mewvo:pw-IIII-9999@db.example.com/mewvo',
    };
    // Every query answers with a row full of secrets (as if a column were added later).
    const { query } = fakeQuery(() => [{
        _n: '1', username: 'alice', token: secrets.token, password_hash: secrets.password_hash, session_id: secrets.session_id,
        csrf: secrets.csrf, totp_secret_enc: secrets.totp_secret_enc, ip_hash: secrets.ip_hash,
        data: { oauth: { refresh_token: secrets.refresh_token, apiKey: secrets.api_key }, note: secrets.botToken },
        reason: secrets.dbUrl,
        setting: 'oauthTokenKey', value: secrets.api_key,
        tbl: 'mod_cases', n: 1,
    }]);
    const lookup = createDatabaseLookup({ query });
    const results = [await lookup.user(USER), await lookup.server(MAIN), await lookup.caseByCode('abc23x'), await lookup.stats(), await lookup.search('alice')];
    for (const result of results) {
        const text = paginate(result).pages.join('\n') + JSON.stringify(result);
        for (const [name, secret] of Object.entries(secrets)) assert.ok(!text.includes(secret), `${result.kind}: ${name} leaked`);
        if (result.kind !== 'stats') assert.ok(text.includes(HIDDEN), `${result.kind}: shows (hidden)`);
    }
});

test('the user lookup never selects secret columns; premium codes only as their last 4', () => {
    const sql = USER_SECTIONS.map(([, build]) => build(new Proxy({}, { get: (_, k) => String(k) }))).join('\n');
    for (const column of ['password_hash', 'totp_secret_enc', 'id_hash', 'csrf', 'ip_hash', 'code_hash', 'token_hash', 'value', 'flash']) {
        assert.ok(!new RegExp(`\\b${column}\\b`).test(sql), `selects ${column}`);
    }
    assert.ok(!/SELECT[^;]*\bcode\b,/.test(sql.replace(/RIGHT\(code, 4\)/g, '')), 'premium code selected in full');
    assert.ok(/RIGHT\(code, 4\)/.test(sql) && /RIGHT\(key_code, 4\)/.test(sql));
    assert.ok(!/\bSELECT \*/.test(sql), 'no SELECT * in the user lookup');
});

// ── Lookups (fake query) ─────────────────────────────────────────────────

test('user: one parameterized query per section; input only in params; counts and recent rows', async () => {
    const { query, calls } = fakeQuery((text) => (/FROM mod_cases WHERE target_user_id/.test(text)
        ? [{ case_code: 'abc23x', type: 'warn', created_at: new Date('2026-11-01T00:00:00Z'), _n: '12' }]
        : []));
    const result = await createDatabaseLookup({ query }).user(`<@${USER}>`);
    assert.equal(calls.length, USER_SECTIONS.length);
    for (const call of calls) {
        assert.ok(!call.text.includes(USER), 'the id is never in the SQL text');
        assert.deepEqual(call.params, [USER, 5]);
    }
    const cases = result.sections.find((s) => s.name === 'Cases against them');
    assert.equal(cases.count, 12);
    assert.equal(cases.rows.length, 1);
    assert.equal(cases.rows[0]._n, undefined, 'the window count is not shown as a column');
    const names = result.sections.map((s) => s.name);
    for (const expected of ['Warn ladder', 'Appeals', 'Watchlist', 'Keep-apart orders', 'Levels / XP', 'Economy', 'Modmail channels',
        'Modmail blocked in', 'Verification log', 'OAuth verification link', 'Staff reports they filed', 'Tickets opened', 'Birthdays',
        'Mewvo website account', 'Website logins (My record)', 'Premium plan', 'Premium orders']) {
        assert.ok(names.includes(expected), expected);
    }
    const lines = paginate(result).pages.join('\n');
    assert.match(lines, /\*\*Cases against them\*\*: 12 \(showing 1\)/);
    assert.match(lines, /<t:\d+:f>/);
});

test('bad input: refused before any query', async () => {
    const { query, calls } = fakeQuery();
    const lookup = createDatabaseLookup({ query });
    await assert.rejects(lookup.user('nobody'), LookupInputError);
    await assert.rejects(lookup.server('12'), LookupInputError);
    await assert.rejects(lookup.caseByCode('!!'), LookupInputError);
    await assert.rejects(lookup.search('a'), LookupInputError);
    await assert.rejects(lookup.search('x'.repeat(101)), LookupInputError);
    assert.equal(calls.length, 0);
});

test('a database error is thrown, never an empty result', async () => {
    const failing = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
    const lookup = createDatabaseLookup({ query: failing });
    await assert.rejects(lookup.user(USER), /ECONNREFUSED/);
    await assert.rejects(lookup.server(MAIN), /ECONNREFUSED/);
    await assert.rejects(lookup.caseByCode('abc23x'), /ECONNREFUSED/);
    await assert.rejects(lookup.stats(), /ECONNREFUSED/);
    await assert.rejects(lookup.search('alice'), /ECONNREFUSED/);
});

test('search: ILIKE with the escaped pattern and ESCAPE, a LIMIT, the text only in params', async () => {
    const { query, calls } = fakeQuery();
    await createDatabaseLookup({ query }).search("50%_o'k");
    assert.ok(calls.length >= 5);
    for (const call of calls) {
        assert.match(call.text, /ILIKE \$1 ESCAPE '\\'/);
        assert.match(call.text, /LIMIT \$2/);
        assert.ok(!call.text.includes("o'k"));
        assert.equal(call.params[0], "%50\\%\\_o'k%");
        assert.ok(call.params[1] <= 25);
    }
});

test('case: the case with edits, evidence, notes and appeals; unknown code says nothing found', async () => {
    const { query, calls } = fakeQuery((text) => (/FROM mod_cases WHERE case_code/.test(text)
        ? [{ case_code: 'abc23x', reason: 'spam', reason_key: 'spam', import_key: 'legacy:1' }]
        : [{ id: 1 }]));
    const result = await createDatabaseLookup({ query }).caseByCode('ABC23X');
    assert.deepEqual(result.sections.map((s) => s.name), ['Case', 'Edits', 'Evidence', 'Staff notes', 'Appeals']);
    assert.ok(calls.every((call) => call.params[0] === 'abc23x'));
    assert.equal(result.sections[0].rows[0].import_key, HIDDEN);
    assert.ok(!/\burl\b,/.test(calls.find((c) => /mod_case_evidence/.test(c.text)).text), 'no signed CDN url');

    const empty = await createDatabaseLookup({ query: fakeQuery().query }).caseByCode('zzzzz');
    assert.equal(empty.notFound, true);
    assert.deepEqual(paginate(empty).pages, ['Nothing found.']);
});

test('server: setting values hidden by the setting name; empty tables left out of the counts', async () => {
    const { query } = fakeQuery((text) => {
        if (/jsonb_each/.test(text)) return [{ setting: 'modLogChannelId', value: '123' }, { setting: 'webhookToken', value: 'abc' }];
        if (/UNION ALL/.test(text)) return [{ tbl: 'mod_cases', n: 3 }, { tbl: 'tags', n: 0 }];
        return [];
    });
    const result = await createDatabaseLookup({ query }).server(MAIN);
    const settings = result.sections.find((s) => s.name.startsWith('Settings'));
    assert.deepEqual(settings.rows, [{ setting: 'modLogChannelId', value: '123' }, { setting: 'webhookToken', value: HIDDEN }]);
    const counts = result.sections.find((s) => s.name.startsWith('Rows per table'));
    assert.deepEqual(counts.rows, [{ table: 'mod_cases', rows: 3 }]);
});

test('stats: a missing migrations table is "not recorded"; other errors still throw', async () => {
    const missing = fakeQuery((text) => {
        if (/schema_migrations/.test(text)) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        if (/pg_database_size/.test(text)) return [{ size: '12 MB' }];
        return [];
    });
    const result = await createDatabaseLookup({ query: missing.query }).stats();
    assert.match(result.sections.find((s) => s.name === 'Schema version').note, /not recorded/);
    const broken = async (text) => { if (/schema_migrations/.test(text)) throw Object.assign(new Error('timeout'), { code: '57014' }); return { rows: [] }; };
    await assert.rejects(createDatabaseLookup({ query: broken }).stats(), /timeout/);
});

// ── Pages and embed limits ───────────────────────────────────────────────

test('paginate: every page within the embed limits (description 4096, total 6000)', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ case_code: `c${i}`, reason: 'x'.repeat(400), created_at: new Date() }));
    const result = { title: 'User 1', sections: [{ name: 'Cases', count: 300, rows }] };
    const { title, pages } = paginate(result);
    assert.ok(pages.length > 1 && pages.length <= 25);
    for (const [index, page] of pages.entries()) {
        assert.ok(page.length <= PAGE_TEXT_MAX);
        const message = lookupMessage({ title, pages }, index, { ownerId: OWNER, nonce: 'abcdef123456' });
        const embed = message.embeds[0].toJSON();
        assert.ok(embed.description.length <= 4096);
        assert.ok(embed.title.length + embed.description.length + embed.footer.text.length <= 6000);
        assert.deepEqual(message.allowedMentions, { parse: [] });
    }
});

test('page buttons: customId carries the owner id; Previous disabled on page 1', () => {
    const message = lookupMessage({ title: 't', pages: ['a', 'b', 'c'] }, 0, { ownerId: OWNER, nonce: 'abcdef123456' });
    const [prev, next] = message.components[0].toJSON().components;
    assert.equal(prev.disabled, true);
    assert.equal(next.custom_id, `dblookup:${OWNER}:abcdef123456:next:1`);
    assert.ok(next.custom_id.length <= 100);
    assert.deepEqual(parseLookupArgs([OWNER, 'abcdef123456', 'next', '1']), { ownerId: OWNER, nonce: 'abcdef123456', page: 1 });
    assert.equal(parseLookupArgs(['x', 'abcdef123456', 'next', '1']), null);
    assert.equal(lookupMessage({ title: 't', pages: ['a'] }, 0, { ownerId: OWNER, nonce: 'abcdef123456' }).components.length, 0);
});

test('page store: TTL and size bound', () => {
    let now = 0;
    const store = createPageStore({ ttlMs: 1000, max: 2, now: () => now });
    store.put('a', { ownerId: OWNER });
    store.put('b', { ownerId: OWNER });
    store.put('c', { ownerId: OWNER });
    assert.equal(store.size, 2);
    assert.equal(store.get('a'), null);
    now = 1001;
    assert.equal(store.get('c'), null);
});

// ── Config, gate, registration ───────────────────────────────────────────

test('OWNER_TOOLS_GUILD_ID: default, override, invalid, never the main or support server', () => {
    const ids = { mainGuildId: '100000000000000001', supportGuildId: '100000000000000002' };
    assert.equal(ownerToolsGuildId({ env: {}, ...ids }), '1564332751170044186');
    assert.equal(ownerToolsGuildId({ env: { OWNER_TOOLS_GUILD_ID: '1777777777777777771' }, ...ids }), '1777777777777777771');
    assert.equal(ownerToolsGuildId({ env: { OWNER_TOOLS_GUILD_ID: 'nope' }, ...ids }), null);
    assert.equal(ownerToolsGuildId({ env: { OWNER_TOOLS_GUILD_ID: ids.mainGuildId }, ...ids }), null);
    assert.equal(ownerToolsGuildId({ env: { OWNER_TOOLS_GUILD_ID: ids.supportGuildId }, ...ids }), null);
    // The real Mewvo servers are refused even when MAIN_GUILD_ID / SUPPORT_GUILD_ID are unset or wrong.
    assert.equal(ownerToolsGuildId({ env: { OWNER_TOOLS_GUILD_ID: '1527697154926182492' }, mainGuildId: null, supportGuildId: null }), null);
    assert.equal(ownerToolsGuildId({ env: { OWNER_TOOLS_GUILD_ID: '1564312871976829009' }, mainGuildId: null, supportGuildId: null }), null);
});

test('gate: only OWNER_IDS, only in the owner-tools server; Administrator is not enough', () => withOwners([OWNER], () => {
    const command = databaseCommand;
    const admin = { has: () => true };
    const check = (guildId, userId) => checkCommandAccess({ command, accessKey: 'database stats', guild: { id: guildId, ownerId: userId }, userId, permissions: admin });
    assert.deepEqual(check(OWNER_GUILD, OWNER), { allowed: true });
    assert.deepEqual(check(OWNER_GUILD, STRANGER), { allowed: false, message: OWNER_TOOLS_REFUSAL }, 'admin + server owner, not in OWNER_IDS');
    assert.deepEqual(check(MAIN, OWNER), { allowed: false, message: OWNER_TOOLS_REFUSAL }, 'not in the main server');
    assert.equal(check(enforcementConfig.supportGuildId, OWNER).allowed, false, 'not in the support server');
    assert.equal(isCommandAvailableInGuild(command, MAIN), false);
    assert.equal(isCommandAvailableInGuild(command, OWNER_GUILD), true);
    assert.equal(canUseOwnerTools({ guildId: OWNER_GUILD, userId: OWNER }), true);
    // Other commands run in the owner-tools server like in any server (global commands, B2).
    assert.equal(isCommandAvailableInGuild({ data: { name: 'ping' } }, OWNER_GUILD), true);
}));

test('registration: /database goes to the owner-tools server only, never global', async () => {
    const client = { commands: new Map([
        ['ping', { data: { name: 'ping', toJSON: () => ({ name: 'ping', description: 'p' }) } }],
        ['test', { scope: 'main', data: { name: 'test', toJSON: () => ({ name: 'test', description: 't' }) } }],
        ['database', databaseCommand],
    ]) };
    const { sets, totalSubcommands } = collectCommandPayloads(client);
    const withOwner = buildRegistrationBodies(sets, totalSubcommands, { quiet: true });
    const without = buildRegistrationBodies({ ...sets, owner: [] }, totalSubcommands, { quiet: true });
    assert.deepEqual(withOwner.globalCommands, without.globalCommands, 'global list identical with or without /database');
    assert.ok(!withOwner.globalCommands.some((c) => c.name === 'database'));
    assert.deepEqual(withOwner.globalCommands.map((c) => c.name), ['ping', 'test'], "scope 'main' commands are global now");
    assert.deepEqual(withOwner.ownerCommands.map((c) => c.name), ['database']);
    await withEnv({ RETIRE_ADMIN_COMMANDS: 'true' }, () => {
        assert.deepEqual(buildRegistrationBodies(sets, 0, { quiet: true }).ownerCommands.map((c) => c.name), ['database'], 'not retired');
    });

    const puts = [];
    const rest = { put: async (route, { body }) => { puts.push({ route: String(route), names: body.map((c) => c.name) }); } };
    await registerCommandSets(rest, '1600000000000000001', sets, totalSubcommands, { schedule: () => {} });
    const withDatabase = puts.filter((p) => p.names.includes('database'));
    assert.equal(withDatabase.length, 1);
    assert.match(withDatabase[0].route, new RegExp(`/guilds/${OWNER_GUILD}/commands$`));
    assert.deepEqual(puts.find((p) => p.route.endsWith('/applications/1600000000000000001/commands')).names, ['ping', 'test'], 'global: everything but /database');

    // Pointed at the main server: owner tools are off and /database is registered nowhere.
    puts.length = 0;
    await withEnv({ OWNER_TOOLS_GUILD_ID: MAIN }, () => registerCommandSets(rest, '1600000000000000001', sets, totalSubcommands, { schedule: () => {} }));
    assert.ok(!puts.some((p) => p.names.includes('database')));
});

test('the dashboard command lists leave /database out', () => {
    assert.deepEqual(commandEntries(new Map([['database', databaseCommand]])), []);
});

// ── The command and the buttons ──────────────────────────────────────────

function fakeInteraction({ userId = OWNER, guildId = OWNER_GUILD, subcommand = 'user', options = {} } = {}) {
    const calls = [];
    return {
        calls,
        id: '2000000000000000001', createdTimestamp: Date.now(),
        user: { id: userId, username: 'owner' }, guildId,
        deferred: false, replied: false,
        isChatInputCommand: () => true,
        options: { getSubcommand: () => subcommand, getString: (name) => options[name] ?? null },
        async deferReply(payload) { this.deferred = true; calls.push(['defer', payload]); },
        async reply(payload) { this.replied = true; calls.push(['reply', payload]); },
        async editReply(payload) { calls.push(['edit', payload]); },
        async followUp(payload) { calls.push(['followUp', payload]); },
        async deferUpdate() { this.deferred = true; calls.push(['deferUpdate']); },
    };
}

function fakeLog() {
    const lines = [];
    const push = (level) => (message, meta) => lines.push({ level, message, meta });
    return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

test('command: a non-owner gets a plain ephemeral refusal; nothing is deferred or queried', async () => {
    const { query, calls } = fakeQuery();
    const interaction = fakeInteraction({ userId: STRANGER, options: { user: USER } });
    await withOwners([OWNER], () => runDatabaseCommand(interaction, { lookup: createDatabaseLookup({ query }), log: fakeLog() }));
    assert.equal(interaction.calls.length, 1);
    assert.equal(interaction.calls[0][0], 'reply');
    assert.equal(interaction.calls[0][1].content, OWNER_TOOLS_REFUSAL);
    assert.deepEqual(interaction.calls[0][1].allowedMentions, { parse: [] });
    assert.equal(calls.length, 0);
});

test('command: the owner outside the owner-tools server is refused too', async () => {
    const interaction = fakeInteraction({ guildId: MAIN, options: { user: USER } });
    await withOwners([OWNER], () => runDatabaseCommand(interaction, { lookup: createDatabaseLookup({ query: fakeQuery().query }), log: fakeLog() }));
    assert.equal(interaction.calls[0][1].content, OWNER_TOOLS_REFUSAL);
});

test('command: ephemeral defer, logged (who, subcommand, query) without results, page 1 with no mentions', async () => {
    const { query } = fakeQuery((text) => (/target_user_id/.test(text) ? [{ case_code: 'abc23x', reason: 'SECRET-RESULT-TEXT', _n: '1' }] : []));
    const log = fakeLog();
    const store = createPageStore();
    const interaction = fakeInteraction({ options: { user: `<@${USER}>` } });
    await withOwners([OWNER], () => runDatabaseCommand(interaction, { lookup: createDatabaseLookup({ query }), log, store, nonce: () => 'abcdef123456' }));
    assert.equal(interaction.calls[0][0], 'defer');
    assert.ok(interaction.calls[0][1].flags, 'ephemeral');
    const edit = interaction.calls.find(([kind]) => kind === 'edit')[1];
    assert.deepEqual(edit.allowedMentions, { parse: [] });
    assert.match(edit.embeds[0].toJSON().description, /SECRET-RESULT-TEXT/);
    const entry = log.lines.find((l) => l.meta?.event === 'owner.database.lookup');
    assert.equal(entry.meta.userId, OWNER);
    assert.equal(entry.meta.subcommand, 'user');
    assert.equal(entry.meta.query, `<@${USER}>`);
    assert.ok(!JSON.stringify(log.lines).includes('SECRET-RESULT-TEXT'), 'results never logged');
    assert.equal(store.get('abcdef123456').ownerId, OWNER);
});

test('command: a database error answers "not responding", never an empty result', async () => {
    const failing = async () => { throw Object.assign(new Error('Connection terminated'), { code: '08006' }); };
    const interaction = fakeInteraction({ subcommand: 'stats' });
    await withOwners([OWNER], () => runDatabaseCommand(interaction, { lookup: createDatabaseLookup({ query: failing }), log: fakeLog() }));
    const edit = interaction.calls.find(([kind]) => kind === 'edit')[1];
    assert.equal(edit.content, LOOKUP_DB_ERROR);
    assert.match(edit.content, /not responding.*nothing was changed/);
    assert.deepEqual(edit.embeds, []);
});

test('command: bad input answers with the reason', async () => {
    const interaction = fakeInteraction({ subcommand: 'case', options: { code: '!!' } });
    await withOwners([OWNER], () => runDatabaseCommand(interaction, { lookup: createDatabaseLookup({ query: fakeQuery().query }), log: fakeLog() }));
    assert.match(interaction.calls.find(([kind]) => kind === 'edit')[1].content, /not a case code/);
});

test('buttons: re-checked on click (other user, not an owner any more, wrong server), expiry, then the page', async () => {
    const store = createPageStore();
    store.put('abcdef123456', { ownerId: OWNER, title: 't', pages: ['one', 'two'] });
    const args = [OWNER, 'abcdef123456', 'next', '1'];
    await withOwners([OWNER, STRANGER], async () => {
        const other = fakeInteraction({ userId: STRANGER });
        await handleLookupButton(other, args, { store, log: fakeLog() });
        assert.equal(other.calls[0][1].content, OWNER_TOOLS_REFUSAL, 'another owner cannot page someone else\'s result');
        const wrongServer = fakeInteraction({ guildId: MAIN });
        await handleLookupButton(wrongServer, args, { store, log: fakeLog() });
        assert.equal(wrongServer.calls[0][1].content, OWNER_TOOLS_REFUSAL);
        const expired = fakeInteraction();
        await handleLookupButton(expired, [OWNER, 'ffffff000000', 'next', '1'], { store, log: fakeLog() });
        assert.equal(expired.calls[0][1].content, LOOKUP_EXPIRED);
        const ok = fakeInteraction();
        await handleLookupButton(ok, args, { store, log: fakeLog() });
        assert.equal(ok.calls[0][0], 'deferUpdate');
        assert.equal(ok.calls[1][1].embeds[0].toJSON().description, 'two');
    });
    await withOwners([], async () => {
        const removed = fakeInteraction();
        await handleLookupButton(removed, args, { store, log: fakeLog() });
        assert.equal(removed.calls[0][1].content, OWNER_TOOLS_REFUSAL, 'no longer in OWNER_IDS');
    });
});

test('the command is slash-only, scope owner, every subcommand present', () => {
    assert.equal(databaseCommand.scope, 'owner');
    assert.equal(databaseCommand.slashOnly, true);
    const json = databaseCommand.data.toJSON();
    assert.deepEqual(json.options.map((o) => o.name), ['user', 'profile', 'server', 'case', 'stats', 'search']);
});
