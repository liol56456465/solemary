// Verification and appeals in servers that are not Mewvo's own (beginner audit 1.1, 1.5, 1.6,
// 2.4, D2, D3): identify-only OAuth with nothing of the token kept, the honest privacy line,
// translated result pages under a strict CSP, the dashboard appeal panel that never touches the
// Support server, the 'own' appeals default and the auto-created Appeals category. Home servers
// keep their behaviour; each part checks that too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const MAIN = '100000000000000001';
const SUPPORT = '100000000000000002';
const REPLACEMENT = '100000000000000003';
const OTHER = '300000000000000003';
const USER = '400000000000000004';
const BOT = '500000000000000005';
// Fake values for tests only (no real client or secret).
Object.assign(process.env, {
    MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, MEMBER_RESTORE_GUILD_IDS: REPLACEMENT,
    CLIENT_ID: '100000000000000123', DISCORD_CLIENT_SECRET: 'test-secret-not-real', PUBLIC_URL: 'http://localhost:3100',
});

const { ChannelType, Collection, PermissionFlagsBits } = await import('discord.js');
const oauth = await import('../src/services/oauthVerification.js');
const { buildOAuthVerifyReply, verifyPrivacyNote } = await import('../src/handlers/verificationButtons.js');
const { OAUTH_SERVER_SENTENCE, oauthVerifyPrivacyNote } = await import('../src/utils/privacyNotice.js');
const { LANG_CODES, translator } = await import('../src/services/site/i18n.js');
const { botText } = await import('../src/utils/botText.js');
const { getSettingEntry, neutralValue, seedValue } = await import('../src/services/settings/settingsRegistry.js');
const { resetSettingsCacheForTests, resolveSetting, setSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const { APPEALS_CATEGORY_NAME, ensureServerAppealsCategory, postServerAppealPanel } = await import('../src/services/enforcement/appealPanelService.js');
const { getAction, getModule } = await import('../src/services/dashboard/modules/index.js');

const scopeOf = (url) => new URL(url).searchParams.get('scope');
const stateOf = (url) => new URL(url).searchParams.get('state');

// ── 1.5 / D3: scopes per server ───────────────────────────────────────────

test('scopes: home servers and restore targets ask identify + guilds.join; any other server identify only', () => {
    for (const id of [MAIN, SUPPORT, REPLACEMENT]) {
        assert.deepEqual(oauth.oauthScopesFor(id), ['identify', 'guilds.join'], id);
        assert.equal(oauth.keepsVerifyToken(id), true, id);
        assert.equal(scopeOf(oauth.buildVerifyUrl(id, USER)), 'identify guilds.join', id);
    }
    assert.deepEqual(oauth.oauthScopesFor(OTHER), ['identify']);
    assert.equal(oauth.keepsVerifyToken(OTHER), false);
    assert.equal(oauth.keepsVerifyToken(null), false);
    assert.equal(scopeOf(oauth.buildVerifyUrl(OTHER, USER)), 'identify');
});

test('state: carries the member\'s language (known codes only); readable also when expired', async () => {
    assert.equal(oauth.stateLanguage(stateOf(oauth.buildVerifyUrl(OTHER, USER, { lang: 'de' }))), 'de');
    assert.equal(oauth.stateLanguage(stateOf(oauth.buildVerifyUrl(OTHER, USER, { lang: 'xx"<' }))), null);
    assert.equal(oauth.stateLanguage(stateOf(oauth.buildVerifyUrl(OTHER, USER))), null);
    assert.equal(oauth.stateLanguage('forged.signature'), null);
    const rows = new Map();
    const read = await oauth.readState(stateOf(oauth.buildVerifyUrl(OTHER, USER, { lang: 'pt-BR' })), {
        getStored: async (k, f) => (rows.has(k) ? rows.get(k) : f), setStored: async (k, v) => { rows.set(k, v); return true; },
    });
    assert.deepEqual(read, { guildId: OTHER, userId: USER, lang: 'pt-BR' });
});

// A fake Express response that keeps status, headers, body and redirect.
function fakeRes() {
    const res = { statusCode: 200, headers: {}, body: null, redirectTo: null };
    res.set = (name, value) => { res.headers[name.toLowerCase()] = value; return res; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.type = () => res;
    res.send = (body) => { res.body = body; return res; };
    res.redirect = (code, to) => { res.statusCode = code; res.redirectTo = to; return res; };
    return res;
}

/** Runs the callback for a valid state in `guildId` with every outside call faked; returns { res, calls }. */
async function callback(guildId, { lang = null, hold = false, redirect = null, headers = {} } = {}) {
    const calls = [];
    const note = (name) => async (...args) => { calls.push(name); return args; };
    const res = fakeRes();
    await oauth.handleOAuthCallback({}, { query: { state: 'x', code: 'c' }, headers, ip: '203.0.113.9' }, res, {
        read: async () => ({ guildId, userId: USER, ...(lang ? { lang } : {}) }),
        setupProblem: async () => null,
        exchange: async () => ({ access_token: 'a', refresh_token: 'r', scope: oauth.oauthScopesFor(guildId).join(' '), expires_in: 600 }),
        fetchMe: async () => ({ id: USER }),
        getStored: async () => { calls.push('getStored'); return null; },
        record: note('record'),
        store: note('store'),
        alreadyVerified: async () => false,
        assess: async () => ({ hold, reasons: hold ? ['young'] : [], items: [] }),
        hold: note('hold'),
        verify: note('verify'),
        markVerified: note('markVerified'),
        redirectFor: () => redirect,
        env: { PUBLIC_URL: 'https://mewvo.example' },
    });
    return { res, calls };
}

test('callback, another server: verified with nothing of the token read, recorded or stored', async () => {
    const { res, calls } = await callback(OTHER);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ['verify'], 'no getStored / record / store / markVerified');
    assert.match(res.body, /You are verified/);
    assert.ok(res.body.includes('no login token is kept'), 'the identify-only privacy line');
    assert.ok(!res.body.includes('Mewvo support server'));
    const held = await callback(OTHER, { hold: true });
    assert.equal(held.res.statusCode, 202);
    assert.deepEqual(held.calls, ['hold']);
});

test('callback, home server: unchanged (token read, authorization recorded, token stored, verified marked)', async () => {
    const { res, calls } = await callback(MAIN, { redirect: 'https://discord.gg/home' });
    assert.deepEqual(calls, ['getStored', 'record', 'store', 'verify', 'markVerified']);
    assert.equal(res.redirectTo, 'https://discord.gg/home');
    const page = await callback(SUPPORT);
    assert.ok(page.res.body.includes('an encrypted login token (to add you to the Mewvo support server)'));
});

// ── privacy line per scope ────────────────────────────────────────────────

test('privacy line: home keeps its sentence; another server gets the identify-only one in all 8 languages', () => {
    const env = { PUBLIC_URL: 'https://mewvo.example' };
    assert.equal(verifyPrivacyNote('oauth', { env }), oauthVerifyPrivacyNote(env), 'home English unchanged');
    assert.equal(verifyPrivacyNote('oauth', { env, home: false }), oauthVerifyPrivacyNote(env, { home: false }));
    assert.ok(oauthVerifyPrivacyNote({}, { home: false }) === OAUTH_SERVER_SENTENCE);
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const server = tr.t('verification.privacy.oauthServer');
        assert.notEqual(server, tr.t('verification.privacy.oauth'), lang);
        assert.ok(!/Mewvo[- ]?(support|Support)|serveur de support|server di supporto|servidor de soporte|servidor de suporte|serwera wsparcia|сервер поддержки/i.test(server), `${lang}: no support server`);
        assert.ok(server.includes('IP'), `${lang}: names the IP fingerprint`);
        if (lang !== 'en') assert.notEqual(server, OAUTH_SERVER_SENTENCE, `${lang} is translated`);
    }
    const reply = buildOAuthVerifyReply(OTHER, USER, { lang: 'fr' });
    const embed = reply.embeds[0].toJSON ? reply.embeds[0].toJSON() : reply.embeds[0].data;
    assert.ok(embed.description.includes(botText('fr').t('verification.privacy.oauthServer')));
    const url = reply.components[0].components[0].data.url;
    assert.equal(scopeOf(url), 'identify');
    assert.equal(oauth.stateLanguage(stateOf(url)), 'fr', 'the result page will be in French');
    const home = buildOAuthVerifyReply(MAIN, USER, { lang: 'en' });
    assert.equal(scopeOf(home.components[0].components[0].data.url), 'identify guilds.join');
});

// ── 1.6: translated result pages, strict CSP ──────────────────────────────

test('result pages: every language, from the state or the mewvo_lang cookie, under a hash-only CSP', async () => {
    const keys = ['cancelled', 'unavailable', 'expired', 'notSetUp', 'wrongAccount', 'held', 'verified', 'failed'];
    for (const lang of LANG_CODES) {
        const tr = translator(lang);
        for (const key of keys) {
            assert.ok(tr.t(`verify.${key}.title`) && tr.t(`verify.${key}.message`), `${lang} ${key}`);
            if (lang !== 'en') assert.notEqual(tr.t(`verify.${key}.title`), translator('en').t(`verify.${key}.title`), `${lang} ${key} translated`);
        }
        // Cancelled: the state's language.
        const res = fakeRes();
        await oauth.handleOAuthCallback({}, { query: { error: 'access_denied', state: stateOf(oauth.buildVerifyUrl(OTHER, USER, { lang })) }, headers: {} }, res);
        assert.equal(res.statusCode, 400);
        assert.ok(res.body.includes(`<html lang="${lang}">`), lang);
        assert.ok(res.body.includes(`<h1>${tr.t('verify.cancelled.title').replace(/&/g, '&amp;').replace(/'/g, '&#39;')}</h1>`), `${lang}: ${res.body}`);
        // Expired / unknown state: the website's language cookie.
        const expired = fakeRes();
        await oauth.handleOAuthCallback({}, { query: { state: 'nope.nope', code: 'c' }, headers: { cookie: `mewvo_lang=${lang}` } }, expired);
        assert.ok(expired.body.includes(`<html lang="${lang}">`), `${lang} cookie`);
        const csp = expired.headers['content-security-policy'];
        assert.match(csp, /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
        const style = /<style>([\s\S]*?)<\/style>/.exec(expired.body)[1];
        assert.equal(csp.match(/sha256-([^']+)/)[1], crypto.createHash('sha256').update(style).digest('base64'), 'the hash is the page\'s one stylesheet');
        assert.ok(!/<script|style="/.test(expired.body), 'no script, no inline style attribute');
        assert.equal(expired.headers['cache-control'], 'no-store');
        assert.equal(expired.headers['x-content-type-options'], 'nosniff');
    }
    // Nothing from the request is echoed: an unknown cookie language falls back to English.
    const res = fakeRes();
    await oauth.handleOAuthCallback({}, { query: { error: '<script>' }, headers: { cookie: 'mewvo_lang="><script>' } }, res);
    assert.ok(res.body.includes('<html lang="en">') && !res.body.includes('<script>'));
});

test('result pages: the verified page of another server shows the translated identify-only note', async () => {
    const { res } = await callback(OTHER, { lang: 'ru' });
    assert.ok(res.body.includes('<html lang="ru">'));
    assert.ok(res.body.includes(translator('ru').t('verify.verified.title')));
    assert.ok(res.body.includes(botText('ru').t('verification.privacy.oauthServer').slice(0, 30)));
    assert.ok(res.body.includes(`>${translator('ru').t('verify.privacyLink')}</a>`));
});

// ── D2: appealsHome default per scope ─────────────────────────────────────

test('appealsHome: other servers default to own; a stored mewvo is kept; the home default stays mewvo', () => {
    const entry = getSettingEntry('appealsHome');
    assert.equal(neutralValue(entry), 'own');
    assert.equal(seedValue(entry, { MAIN_GUILD_ID: MAIN, NODE_ENV: 'test' }), 'mewvo');
    try {
        setSettingsCacheForTests(OTHER, {});
        assert.equal(resolveSetting(OTHER, 'appealsHome'), 'own');
        setSettingsCacheForTests(OTHER, { appealsHome: 'mewvo' });
        assert.equal(resolveSetting(OTHER, 'appealsHome'), 'mewvo');
    } finally {
        resetSettingsCacheForTests();
    }
});

// ── 1.1: the dashboard appeal panel in another server ─────────────────────

const allow = { has: () => true };
function fakeGuild(id, { canManage = true, categories = [] } = {}) {
    const created = [];
    const channels = new Map(categories.map((c) => [c.id, c]));
    const guild = {
        id, name: 'Cosy Cats', ownerId: '200000000000000009',
        members: { me: { id: BOT, permissions: { has: (perm) => canManage || perm !== PermissionFlagsBits.ManageChannels } } },
        client: { user: { id: BOT } },
        roles: { cache: new Map() },
        channels: {
            cache: channels,
            create: async (options) => {
                created.push(options);
                const category = { id: '600000000000000006', name: options.name, type: options.type, permissionsFor: () => allow, deleted: false };
                category.delete = async () => { category.deleted = true; };
                channels.set(category.id, category);
                return category;
            },
        },
        created,
    };
    return guild;
}
function fakeTextChannel(guild) {
    const sent = [];
    const channel = {
        id: '700000000000000007', name: 'appeals-here', type: ChannelType.GuildText, guild, client: guild.client,
        permissionsFor: () => allow, messages: { fetch: async () => new Collection() }, send: async (payload) => { sent.push(payload); return { id: '1' }; }, sent,
    };
    guild.channels.cache.set(channel.id, channel);
    return channel;
}

test('dashboard appeal panel, another server: postServerAppealPanel only; the Support server is never touched', async () => {
    const guild = fakeGuild(OTHER);
    const channel = fakeTextChannel(guild);
    const touched = [];
    // Any read of another guild through the client (the Support server) is recorded.
    const client = { guilds: { cache: { get: (id) => { touched.push(id); return undefined; } } } };
    const services = {
        postAppealPanels: async () => { throw new Error('the home-only postAppealPanels must not run in another server'); },
        postServerAppealPanel: (g, ch, opts) => postServerAppealPanel(g, ch, {
            ...opts, ensureCategory: (gg, o) => ensureServerAppealsCategory(gg, { ...o, find: async () => null, save: async (...args) => { saves.push(args); return { changes: [] }; } }),
        }),
    };
    const saves = [];
    const ctx = {
        lang: 'en', guildId: OTHER, env: { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test' }, services, guild, client,
        canEdit: true, canAct: true, actor: { userId: '200000000000000002', username: 'admin' }, csrf: 'c'.repeat(32), query: {},
    };
    const result = await getAction(getModule('enforcement'), 'appeal-panels').run(ctx, { channelId: channel.id });
    assert.deepEqual(touched, [], 'no guild other than this one was looked up');
    assert.equal(channel.sent.length, 1);
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    assert.equal(channel.sent[0].embeds[0].data.title, 'Cosy Cats appeals');
    assert.equal(guild.created.length, 1, 'the Appeals category was created');
    assert.deepEqual(saves.map((s) => [s[0], s[1]]), [[OTHER, { appealsCategoryId: '600000000000000006' }]]);
    assert.deepEqual(result.changes, [
        { key: 'appealPanels', old: null, new: { main: channel.id, support: null } },
        { key: 'appealsCategoryId', old: null, new: '600000000000000006' },
    ]);
    assert.match(result.message, /Appeal panel posted in #appeals-here\. Mewvo created the private category Appeals/);
});

test('dashboard appeal panel, home server: still postAppealPanels (main + Support), unchanged', async () => {
    const guild = fakeGuild(MAIN);
    const channel = fakeTextChannel(guild);
    const seen = [];
    const ctx = {
        lang: 'en', guildId: MAIN, env: { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test' }, guild, client: {},
        services: {
            postAppealPanels: async (c, g, ch) => { seen.push(ch.id); return { mainChannel: ch, supportChannel: { id: '1', name: 'appeals' }, created: false }; },
            postServerAppealPanel: async () => { throw new Error('not at home'); },
        },
        canEdit: true, canAct: true, actor: { userId: '200000000000000002', username: 'admin' }, csrf: 'c'.repeat(32), query: {},
    };
    const result = await getAction(getModule('enforcement'), 'appeal-panels').run(ctx, { channelId: channel.id });
    assert.deepEqual(seen, [channel.id]);
    assert.match(result.message, /support server/);
});

test('enforcement page, another server: one-panel wording and the own-server default selected', async () => {
    const module = getModule('enforcement');
    const env = { MAIN_GUILD_ID: MAIN, SUPPORT_GUILD_ID: SUPPORT, NODE_ENV: 'test' };
    const guild = fakeGuild(OTHER);
    const ctx = {
        lang: 'en', guildId: OTHER, env, guild, client: {}, canEdit: true, canAct: true, actor: { userId: '1', username: 'a' }, csrf: 'c'.repeat(32), query: {},
        services: { resolveSetting: (gid, key) => neutralValue(getSettingEntry(key)), getSetting: (gid, key) => seedValue(getSettingEntry(key), env) },
    };
    const page = String(module.render(ctx, await module.load(ctx)));
    assert.match(page, /type="radio" name="appealsHome" value="own" checked/);
    assert.ok(page.includes('Post the appeal panel<') || page.includes('>Post the appeal panel'), 'singular submit');
    assert.ok(!page.includes('A second panel goes to #appeals in the support server'), 'no Support panel promise');
    assert.ok(!page.includes('Posts the appeal panel here and in the support server'));
});

// ── 2.4: the Appeals category ─────────────────────────────────────────────

test('appeals category: created private (staff-only overwrites) and saved; an existing one is reused', async () => {
    const guild = fakeGuild(OTHER);
    const saves = [];
    const { category, created } = await ensureServerAppealsCategory(guild, {
        find: async () => null, save: async (...args) => { saves.push(args); return { changes: [] }; }, actor: { userId: '2', username: 'admin' },
    });
    assert.equal(created, true);
    assert.equal(category.name, APPEALS_CATEGORY_NAME);
    const options = guild.created[0];
    assert.equal(options.type, ChannelType.GuildCategory);
    const everyone = options.permissionOverwrites.find((o) => o.id === OTHER);
    assert.deepEqual(everyone.deny, [PermissionFlagsBits.ViewChannel], '@everyone cannot see it');
    assert.ok(!everyone.allow);
    const bot = options.permissionOverwrites.find((o) => o.id === BOT);
    for (const perm of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages]) assert.ok(bot.allow.includes(perm));
    assert.equal(options.permissionOverwrites.length, 2, 'nobody else is let in (administrators see it anyway)');
    assert.deepEqual(saves[0].slice(0, 2), [OTHER, { appealsCategoryId: category.id }]);
    assert.equal(saves[0][2].module, 'appeals');

    const again = fakeGuild(OTHER);
    const existing = { id: '9', name: 'Tickets' };
    assert.deepEqual(await ensureServerAppealsCategory(again, { find: async () => existing, save: async () => { throw new Error('no save'); } }), { category: existing, created: false });
    assert.equal(again.created.length, 0);
});

test('appeals category: without Manage Channels nothing is created and the error names the exact fix; a failed save removes it again', async () => {
    const guild = fakeGuild(OTHER, { canManage: false });
    await assert.rejects(ensureServerAppealsCategory(guild, { find: async () => null, save: async () => ({}) }),
        (error) => /Manage Channels/.test(error.userMessage || error.message) && /dashboard/.test(error.userMessage || error.message));
    assert.equal(guild.created.length, 0);

    const failing = fakeGuild(OTHER);
    await assert.rejects(ensureServerAppealsCategory(failing, { find: async () => null, save: async () => { throw new Error('db down'); } }),
        (error) => error.type === 'database' && /database is not responding/.test(error.userMessage));
    assert.equal(failing.channels.cache.get('600000000000000006').deleted, true, 'the unsaved category is removed');

    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const key of ['staff.setappeal.error.noServerCategory', 'staff.setappeal.error.categoryNotSaved', 'staff.setappeal.posted.categoryCreated']) {
            assert.ok(tr.has(key), `${lang} ${key}`);
        }
    }
});

test('postServerAppealPanel: a channel Mewvo cannot post in is refused before any category is created', async () => {
    const guild = fakeGuild(OTHER);
    const channel = { id: '8', permissionsFor: () => ({ has: () => false }) };
    let ensured = false;
    await assert.rejects(postServerAppealPanel(guild, channel, { ensureCategory: async () => { ensured = true; return {}; } }), /Send Messages/);
    assert.equal(ensured, false);
});
