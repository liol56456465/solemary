// Multi-server B0b review fixes: things that fell back to the home server because no guild was
// passed. Another server gets its own name in DMs, its own rule hint, its own custom rules and
// blocked words, only its own review cards; the support server maps to the main server for
// evidence and appeal settings (as channelRouting / appealService do). Home servers unchanged.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const OTHER = '100000000000000777'; // not a home server
const THIRD = '100000000000000888';
const MAIN_CHANNEL = '300000000000000001';
const SUPPORT_CHANNEL = '300000000000000009';
const USER = '500000000000000002';

Object.assign(process.env, {
    MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT,
    EVIDENCE_CHANNEL_ID: MAIN_CHANNEL, MOD_LOG_CHANNEL_ID: MAIN_CHANNEL,
});

const { pgDb } = await import('../src/utils/postgresDatabase.js');
const { logger } = await import('../src/utils/logger.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');
const {
    SettingsUnavailableError, resetSettingsCacheForTests, setSettingsCacheForTests,
} = await import('../src/services/settings/guildSettings.js');
const { resetSettingsUnavailableNotes } = await import('../src/services/settings/guildScoped.js');
const dm = await import('../src/services/enforcement/dmTemplates.js');
const { notifyPunishmentEnded } = await import('../src/services/enforcement/enforcementService.js');
const { flowSummary } = await import('../src/services/enforcement/flowBuilder.js');
const { confirmationPayload } = await import('../src/handlers/enforcementPanel.js');
const { worstHit, headsUpPlan } = await import('../src/services/automod/automodService.js');
const { maskExcerpt } = await import('../src/services/automod/backtest.js');
const { registerCard } = await import('../src/services/automod/reviewRegistry.js');
const { collectOpenReviews } = await import('../src/services/automod/reviewQueue.js');
const { addImageEvidence } = await import('../src/services/enforcement/evidenceService.js');
const { appealConfigFor } = await import('../src/services/site/memberPortal.js');
const { appealSettingsGuild } = await import('../src/services/enforcement/appealService.js');
const { checkCatGrowth } = await import('../src/services/community/catService.js');

afterEach(() => {
    resetSettingsCacheForTests();
    resetSettingsUnavailableNotes();
});

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

function captureWarnings() {
    const lines = [];
    const original = logger.warn;
    logger.warn = (message) => { lines.push(String(message)); };
    return { lines, restore: () => { logger.warn = original; } };
}

const caseOf = (guildId, extra = {}) => ({
    id: 7, guild_id: guildId, case_code: 'abc2345', type: 'ban', moderator_username: 'mod', reason: 'Spam', reason_key: 'spam',
    prebuilt_or_custom: 'prebuilt', created_at: new Date('2026-10-28T10:00:00Z'),
    expires_at: new Date('2026-11-04T10:00:00Z'), duration_ms: 7 * 86400000, ...extra,
});

// ── 8: the server a DM names ──────────────────────────────────────────────

test('DM server name: home servers keep "Mewvo" (also when a name is passed); another server its own Discord name', () => {
    setSettingsCacheForTests(OTHER, {});
    for (const gid of [MAIN, SUPPORT, undefined]) {
        assert.ok(dm.banDm(caseOf(gid), { serverName: 'Cat Café' }).includes('**Banned from Mewvo**'), String(gid));
    }
    const rec = caseOf(OTHER);
    const named = { serverName: 'Cat Café' };
    assert.ok(dm.banDm(rec, named).includes('**Banned from Cat Café**'));
    assert.ok(dm.kickDm(rec, null, named).includes('**Kicked from Cat Café**'));
    assert.ok(dm.muteDm(rec, named).includes('**Muted in Cat Café**'));
    assert.ok(dm.warnDm(rec, 1, named).includes('in Cat Café**'));
    assert.ok(dm.banEndedDm(rec, null, named).includes('**Your ban from Cat Café has ended**'));
    assert.ok(dm.muteEndedDm(rec, named).includes('**Your mute in Cat Café has ended**'));
    assert.ok(dm.caseVoidedDm(rec, 'mistake', null, named).includes('in Cat Café was removed**'));
    assert.ok(dm.noContactStartedDm(rec, null, named).includes('an order in Cat Café**'));
    assert.ok(dm.noContactEndedDm(rec, null, named).includes('order in Cat Café has ended**'));
    for (const text of [dm.banDm(rec, named), dm.kickDm(rec, null, named), dm.muteDm(rec, named), dm.warnDm(rec, 1, named)]) {
        assert.ok(!/\bMewvo\b/.test(text.split('\n').find((l) => l.startsWith('**')) || ''), text);
    }
    // rec.guild_name when the caller passes no name.
    assert.ok(dm.banDm(caseOf(OTHER, { guild_name: 'Row Name' })).includes('**Banned from Row Name**'));
});

test('DM server name: unknown → a neutral "the server" (in the DM\'s language), never "Mewvo"', () => {
    setSettingsCacheForTests(OTHER, {});
    assert.ok(dm.banDm(caseOf(OTHER)).includes('**Banned from the server**'));
    assert.ok(dm.banDm(caseOf(OTHER), { serverName: '   ' }).includes('**Banned from the server**'));
    assert.ok(dm.noContactEndedDm({ guild_id: OTHER }, null).includes('order in the server has ended'));
    assert.ok(dm.banDm(caseOf(OTHER), { lang: 'de' }).includes('**Von dem Server gebannt**'));
    assert.ok(dm.banDm(caseOf(OTHER), { lang: 'de', serverName: 'Katzen' }).includes('**Von Katzen gebannt**'));
    assert.ok(dm.banDm(caseOf(MAIN), { lang: 'de' }).includes('**Von Mewvo gebannt**'), 'home unchanged in German');
});

test('DM server name: markdown escaped, mentions broken, one line', () => {
    setSettingsCacheForTests(OTHER, {});
    const text = dm.banDm(caseOf(OTHER), { serverName: '**Big** _cats_ @everyone <@123>\nline2' });
    const title = text.split('\n').find((l) => l.startsWith('**Banned from'));
    assert.equal(title, '**Banned from \\*\\*Big\\*\\* \\_cats\\_ @​everyone <​@​123> line2**');
    assert.ok(!text.includes('@everyone'));
    assert.ok(!text.includes('<@123>'));
    assert.ok(!/(?<!\\)\[Appeal here(?<!\\)\]\(/.test(dm.safeServerName('[Appeal here](https://phish.example)')), 'no working masked link');
    assert.equal(dm.safeServerName(null), '');
    assert.equal(dm.safeServerName('x'.repeat(300)).length, 100);
});

test('DM server name: every bot catalog has the neutral word and the same {server} placeholders', () => {
    const base = new URL('../src/content/bot/', import.meta.url);
    const langs = readdirSync(base);
    assert.equal(langs.length, 8);
    const placeholders = (json) => JSON.stringify(json).match(/\{server\}/g)?.length || 0;
    const en = JSON.parse(readFileSync(new URL('en/enforcement.json', base), 'utf8'));
    for (const lang of langs) {
        const cat = JSON.parse(readFileSync(new URL(`${lang}/enforcement.json`, base), 'utf8'));
        assert.equal(typeof cat.dm.thisServer, 'string', lang);
        assert.ok(cat.dm.thisServer.trim(), lang);
        assert.ok(!/\{/.test(cat.dm.thisServer), lang);
        assert.equal(placeholders(cat), placeholders(en), `${lang}: {server} count`);
        // The neutral word renders in every language without falling back to English.
        setSettingsCacheForTests(OTHER, {});
        assert.ok(dm.banDm(caseOf(OTHER), { lang }).includes(cat.dm.thisServer), lang);
    }
});

// ── 3: the ban-ended DM names the ban's server ────────────────────────────

function dmClient() {
    const sent = [];
    const user = { id: USER, send: async (payload) => { sent.push(payload.content); } };
    return { sent, client: { users: { fetch: async () => user } } };
}
const noInviteGuild = (id, name) => ({ id, name, members: { me: null }, channels: { cache: new Map() }, rulesChannel: null, systemChannel: null });

test('notifyPunishmentEnded: another server\'s ban/mute-ended DM names that server and never Mewvo\'s Support invite', async () => {
    setSettingsCacheForTests(OTHER, {});
    await withPool(() => [], async () => {
        const { client, sent } = dmClient();
        // No record (nothing stored for it): only the guild says which server it is.
        assert.equal(await notifyPunishmentEnded(client, noInviteGuild(OTHER, 'Cat Café'), { type: 'ban', userId: USER, records: [] }), true);
        assert.ok(sent[0].includes('**Your ban from Cat Café has ended**'), sent[0]);
        assert.ok(!sent[0].includes(enforcementConfig.supportServerInvite), 'Mewvo\'s Support cannot invite into another server');
        await notifyPunishmentEnded(client, noInviteGuild(OTHER, 'Cat Café'), { type: 'mute', userId: USER, records: [caseOf(OTHER, { type: 'mute' })] });
        assert.ok(sent[1].includes('**Your mute in Cat Café has ended**'), sent[1]);
        // The bot left the server: the case's guild still decides, with the neutral name.
        await notifyPunishmentEnded(client, null, { type: 'ban', userId: USER, records: [caseOf(OTHER)] });
        assert.ok(sent[2].includes('**Your ban from the server has ended**'), sent[2]);
    });
});

test('notifyPunishmentEnded: home unchanged ("Mewvo", Mewvo\'s Support invite when no invite could be made)', async () => {
    await withPool(() => [], async () => {
        const { client, sent } = dmClient();
        await notifyPunishmentEnded(client, noInviteGuild(MAIN, 'Mewvo Discord name'), { type: 'ban', userId: USER, records: [] });
        assert.ok(sent[0].includes('**Your ban from Mewvo has ended**'), sent[0]);
        if (enforcementConfig.supportServerInvite) assert.ok(sent[0].includes(enforcementConfig.supportServerInvite));
    });
});

// ── 4: the confirm-step rule hint is the acting server's ──────────────────

const MAIN_RULES = { rules: [{ id: 'aaaa1111', title: 'Mewvo rule', text: '' }], updatedAt: null };
const OTHER_RULES = { rules: [{ id: 'bbbb2222', title: 'Be nice', text: '' }, { id: 'cccc3333', title: 'No spam here', text: '' }], updatedAt: null };

test('flowSummary / confirm step: another server\'s own rule hint; home keeps the main server\'s', () => {
    setSettingsCacheForTests(MAIN, { serverRules: MAIN_RULES, reasonRuleLinks: { spam: 'aaaa1111' } });
    setSettingsCacheForTests(OTHER, { serverRules: OTHER_RULES, reasonRuleLinks: { spam: 'cccc3333' } });
    const flow = { type: 'warn', targetUsername: 'member', targetId: USER, reason: 'Spam', reasonKey: 'spam', name: 'x', evidence: [] };
    assert.equal(flowSummary(flow, { guildId: OTHER }).ruleHint, 'Rule 2: No spam here.');
    assert.equal(flowSummary(flow, { guildId: MAIN }).ruleHint, 'Rule 1: Mewvo rule.');
    assert.equal(flowSummary(flow).ruleHint, 'Rule 1: Mewvo rule.', 'no guild: main, as before');
    const description = confirmationPayload(flow, '1', 'nonce', { guildId: OTHER }).embeds[0].data.description;
    assert.ok(description.includes('-# Rule 2: No spam here.'), description);
    assert.ok(!description.includes('Mewvo rule'));
    setSettingsCacheForTests(OTHER, {});
    assert.equal(flowSummary(flow, { guildId: OTHER }).ruleHint, null, 'a server without links: no hint (not the main server\'s)');
});

// ── 5: automod callers ────────────────────────────────────────────────────

test('worstHit / headsUpPlan: a custom-rule key without a carried definition is looked up in the message\'s server', () => {
    setSettingsCacheForTests(OTHER, { automodCustomRules: [
        { id: 'aaaa1111', name: 'Mild', action: 'delete', words: ['x'] },
        { id: 'bbbb2222', name: 'Severe', action: 'mute', muteDuration: '1h', words: ['y'] },
    ] });
    const hits = [{ rule: 'custom-aaaa1111' }, { rule: 'custom-bbbb2222' }];
    assert.equal(worstHit(hits, OTHER).rule, 'custom-bbbb2222', 'the mute rule is more severe');
    assert.equal(worstHit(hits).rule, 'custom-aaaa1111', 'without the guild both look like generic delete rules');
    assert.equal(headsUpPlan(hits, { headsUp: {} }, { guildId: OTHER }).hit.rule, 'custom-bbbb2222');
});

test('backtest maskExcerpt: another server\'s own blocked words are masked', () => {
    setSettingsCacheForTests(OTHER, { extraBlockedWords: ['zorbleflax'] });
    setSettingsCacheForTests(THIRD, {});
    const own = maskExcerpt('hello zorbleflax world', [], { guildId: OTHER });
    assert.ok(own === null || !own.includes('zorbleflax'), String(own));
    assert.ok(maskExcerpt('hello zorbleflax world', [], { guildId: THIRD }).includes('zorbleflax'), 'another server\'s list never applies');
});

test('collectOpenReviews: each server lists only its own cards; the home servers share the main list', async () => {
    const card = (n, guildId) => registerCard({
        messageId: `90000000000000000${n}`, open: true, tier: 'full', kind: 'action', rule: 'spam', guildId,
        userId: USER, username: 'member', firstAt: 1000 + n, lastAt: 1000 + n, count: 1, url: `https://discord.com/channels/x/y/${n}`, actions: [],
    });
    card(1, MAIN);
    card(2, SUPPORT);
    card(3, OTHER);
    card(4, THIRD);
    setSettingsCacheForTests(OTHER, {});
    const client = { user: { id: '1' }, guilds: { cache: new Map() } };
    const urls = async (guildId) => (await collectOpenReviews(client, guildId)).map((i) => i.url.split('/').at(-1)).sort();
    assert.deepEqual(await urls(OTHER), ['3']);
    assert.deepEqual(await urls(MAIN), ['1', '2']);
    assert.deepEqual(await urls(undefined), ['1', '2'], 'default: main, as before');
});

// ── 6: support-server mapping ─────────────────────────────────────────────

test('addImageEvidence: a support-server case uses the main server\'s evidence channel (as channelRouting does)', async () => {
    const sent = [];
    const channel = (id) => ({ id, isTextBased: () => true, send: async () => { sent.push(id); return { id: '900000000000000001', attachments: { first: () => null }, delete: async () => {} }; } });
    const guild = (id, channels) => ({ id, channels: { cache: new Map(channels.map((c) => [c, channel(c)])), fetch: async () => null } });
    const client = { guilds: { cache: new Map([[MAIN, guild(MAIN, [MAIN_CHANNEL])], [SUPPORT, guild(SUPPORT, [SUPPORT_CHANNEL])]]) } };
    setSettingsCacheForTests(SUPPORT, { evidenceChannelId: SUPPORT_CHANNEL });
    await withPool((sql) => (/INSERT INTO/.test(sql) ? [{ id: 1, kind: 'image', store_channel_id: MAIN_CHANNEL }] : []), async () => {
        await addImageEvidence(client, 'abc2345', { contentType: 'image/png', url: 'https://cdn.example/x.png', name: 'x.png' },
            { addedBy: { id: USER, username: 'mod' }, guildId: SUPPORT });
    });
    assert.deepEqual(sent, [MAIN_CHANNEL]);
});

test('member portal appealConfigFor: the same mapping as the bot (support → main, other → its own)', () => {
    const WEEK = 7 * 86400000;
    setSettingsCacheForTests(MAIN, { appealWindowMs: 3 * WEEK, appealCooldownMs: 2 * WEEK });
    setSettingsCacheForTests(SUPPORT, { appealWindowMs: WEEK });
    setSettingsCacheForTests(OTHER, { appealWindowMs: 5 * WEEK });
    assert.equal(appealSettingsGuild(SUPPORT), MAIN);
    assert.deepEqual(appealConfigFor(SUPPORT), { appealWindowMs: 3 * WEEK, appealCooldownMs: 2 * WEEK });
    assert.deepEqual(appealConfigFor(MAIN), appealConfigFor(SUPPORT));
    assert.equal(appealConfigFor(OTHER).appealWindowMs, 5 * WEEK);
    assert.equal(appealSettingsGuild(OTHER), OTHER);
});

// ── 7: server cat, unreadable settings ────────────────────────────────────

test('server cat cron: a server whose settings cannot be read is noted at most once, not warned every run', async () => {
    const warnings = captureWarnings();
    try {
        const client = { guilds: { cache: new Map([[OTHER, { id: OTHER }]]) } };
        const deps = { getLevelingConfig: async () => ({}), activeGuilds: () => [OTHER], getState: async () => { throw new SettingsUnavailableError(OTHER); } };
        await checkCatGrowth(client, deps);
        await checkCatGrowth(client, deps);
        await checkCatGrowth(client, deps);
    } finally {
        warnings.restore();
    }
    assert.equal(warnings.lines.length, 1, warnings.lines.join('\n'));
    assert.match(warnings.lines[0], /server cat skipped/);
});
