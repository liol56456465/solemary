// Owner area → Website: text validation, "needs update" logic, override precedence, the image
// check + re-encode, slot serving (uploaded copy first, then the file), access (owners only, 404
// for anyone else), CSRF / Origin, a DB error answered with 503 and nothing shown as saved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const { createDashboard, dashboardSettings } = await import('../src/services/dashboard/routes.js');
const { createMemorySessionStore } = await import('../src/services/dashboard/sessionStore.js');
const { createAccessChecker } = await import('../src/services/dashboard/access.js');
const { SESSION_COOKIE, signValue } = await import('../src/services/dashboard/security.js');
const { OWNER_NAV } = await import('../src/services/dashboard/html.js');
const i18n = await import('../src/services/site/i18n.js');
const sc = await import('../src/services/site/siteContent.js');
const si = await import('../src/services/site/siteImages.js');
const { createSite } = await import('../src/services/site/site.js');
const { createCanvas } = await import('@napi-rs/canvas');

const SECRET = 'y'.repeat(64);
const OWNER = '200000000000000003';
const ADMIN = '200000000000000002';
const ORIGIN = 'https://bot.example';
const ENV = {
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'true', SESSION_SECRET: SECRET, CLIENT_ID: '400000000000000004',
    DISCORD_CLIENT_SECRET: 'cs', PUBLIC_URL: ORIGIN, MAIN_GUILD_ID: process.env.MAIN_GUILD_ID, NODE_ENV: 'test',
};

/** Small catalogs: English complete, German partly translated, Russian empty. */
function useTestCatalogs() {
    i18n.setCatalogsForTest(new Map([
        ['en', new Map([
            ['home.title', 'Hello {name}'], ['home.intro', 'Welcome to **Mewvo**.'],
            ['billing.day.one', '{count} day'], ['billing.day.other', '{count} days'],
        ])],
        ['de', new Map([['home.title', 'Hallo {name}'], ['billing.day.one', '{count} Tag'], ['billing.day.other', '{count} Tage']])],
        ...i18n.LANG_CODES.filter((c) => c !== 'en' && c !== 'de').map((c) => [c, new Map()]),
    ]));
    sc.setOverrideRows([]);
    sc.installOverrides();
}
function restoreCatalogs() {
    sc.setOverrideRows([]);
    i18n.setCatalogsForTest(null);
}

test('validation: length, empty, same {params}, {count} free in plural forms, unknown keys, HTML warning', () => {
    useTestCatalogs();
    try {
        assert.equal(sc.validateSiteText('de', 'home.title', '  Servus {name}\r\n').text, 'Servus {name}');
        assert.throws(() => sc.validateSiteText('de', 'home.title', '   '), /empty/);
        assert.throws(() => sc.validateSiteText('de', 'home.title', `{name}${'x'.repeat(5000)}`), /at most 5000/);
        assert.throws(() => sc.validateSiteText('de', 'home.title', 'Servus'), /missing \{name\}/);
        assert.throws(() => sc.validateSiteText('de', 'home.title', 'Servus {name} {evil}'), /not allowed \{evil\}/);
        assert.throws(() => sc.validateSiteText('de', 'home.nope', 'x'), /unknown key/);
        assert.throws(() => sc.validateSiteText('xx', 'home.title', '{name}'), /Unknown language/);
        // Plural forms: {count} may be left out ("one day"); Russian gets its own forms (few, many).
        assert.equal(sc.validateSiteText('de', 'billing.day.one', 'ein Tag').text, 'ein Tag');
        assert.ok(sc.isEditableKey('ru', 'billing.day.few'));
        assert.ok(!sc.isEditableKey('en', 'billing.day.few'), 'English only has its own keys');
        assert.ok(sc.editorKeys('ru').includes('billing.day.many'));
        const warned = sc.validateSiteText('en', 'home.intro', 'Hi <b>there</b>');
        assert.equal(warned.warnings.length, 1);
        assert.match(warned.warnings[0], /HTML is not supported/);
        // The preview is the site's own escaping.
        assert.equal(String(i18n.previewMarkup('Hi <b>x</b> **y**')), '<p>Hi &lt;b&gt;x&lt;/b&gt; <strong>y</strong></p>');
    } finally { restoreCatalogs(); }
});

test('status: translated / needs update / missing, from override hashes and English edits', () => {
    useTestCatalogs();
    try {
        assert.equal(sc.keyStatus('de', 'home.title').state, 'translated', 'catalog translation, English unchanged');
        assert.equal(sc.keyStatus('ru', 'home.title').state, 'missing');
        assert.equal(sc.keyStatus('en', 'home.title').state, 'default');
        // An override made for the current English text.
        sc.putOverride({ lang: 'ru', key: 'home.title', text: 'Привет {name}', source_hash: sc.sha256('Hello {name}') });
        assert.equal(sc.keyStatus('ru', 'home.title').state, 'translated');
        // English changes: the Russian override and the German catalog text need an update.
        sc.putOverride({ lang: 'en', key: 'home.title', text: 'Hi there {name}', source_hash: null });
        assert.equal(sc.keyStatus('en', 'home.title').state, 'edited');
        assert.equal(sc.keyStatus('ru', 'home.title').state, 'needs-update');
        assert.equal(sc.keyStatus('de', 'home.title').state, 'needs-update');
        // A German override saved against the new English text is up to date.
        sc.putOverride({ lang: 'de', key: 'home.title', text: 'Hallo du {name}', source_hash: sc.sha256('Hi there {name}') });
        assert.equal(sc.keyStatus('de', 'home.title').state, 'translated');
        const counts = sc.statusCounts('ru', sc.editorKeys('ru'));
        assert.equal(counts.needsUpdate, 1);
        assert.equal(counts.edited, 1);
        assert.equal(counts.total, sc.editorKeys('ru').length);
    } finally { restoreCatalogs(); }
});

test('precedence: own edit → own catalog → English edit → English catalog; rows of unknown keys are skipped', () => {
    useTestCatalogs();
    try {
        assert.equal(i18n.translate('de', 'home.title', { name: 'A' }), 'Hallo A');
        assert.equal(i18n.translate('ru', 'home.title', { name: 'A' }), 'Hello A');
        const kept = sc.setOverrideRows([
            { lang: 'en', key: 'home.title', text: 'Hi {name}' },
            { lang: 'de', key: 'home.intro', text: 'Willkommen' },
            { lang: 'de', key: 'gone.key', text: 'x' },
            { lang: 'xx', key: 'home.title', text: 'x' },
        ]);
        assert.equal(kept, 2);
        assert.equal(i18n.translate('ru', 'home.title', { name: 'A' }), 'Hi A', 'English edit before the English catalog');
        assert.equal(i18n.translate('de', 'home.title', { name: 'A' }), 'Hallo A', 'a translation is not replaced by an English edit');
        assert.equal(i18n.translate('de', 'home.intro'), 'Willkommen', 'own edit first');
        sc.dropOverride('de', 'home.intro');
        assert.equal(i18n.translate('de', 'home.intro'), 'Welcome to **Mewvo**.');
    } finally { restoreCatalogs(); }
});

test('loadSiteContent: a DB error is logged and the site keeps the catalog texts', async () => {
    useTestCatalogs();
    try {
        sc.putOverride({ lang: 'en', key: 'home.intro', text: 'old' });
        assert.equal(await sc.loadSiteContent({ listAll: async () => { throw new Error('connection refused'); } }), null);
        assert.equal(await sc.loadSiteContent({ listAll: async () => [{ lang: 'en', key: 'home.intro', text: 'New intro' }] }), 1);
        assert.equal(i18n.translate('fr', 'home.intro'), 'New intro');
    } finally { restoreCatalogs(); }
});

// ── Images ────────────────────────────────────────────────────────────────

function png(width, height, { extra = null } = {}) {
    const c = createCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#336699';
    ctx.fillRect(0, 0, width, height);
    let data = c.toBuffer('image/png');
    if (extra) {
        // A tEXt chunk after IHDR (8 + 25 bytes): metadata the re-encode must drop.
        const body = Buffer.from(`Comment\0${extra}`, 'latin1');
        const chunk = Buffer.alloc(12 + body.length);
        chunk.writeUInt32BE(body.length, 0);
        chunk.write('tEXt', 4, 'latin1');
        body.copy(chunk, 8);
        data = Buffer.concat([data.subarray(0, 33), chunk, data.subarray(33)]);
    }
    return data;
}

test('image upload: PNG/JPEG/WebP only, 2 MB, header size checked, re-encoded to the slot size without metadata', async () => {
    const screen = si.slotDef('screen-overview-dark');
    const og = si.slotDef('og');
    const source = png(160, 100, { extra: 'SECRET-LOCATION' });
    assert.ok(source.includes(Buffer.from('SECRET-LOCATION')));
    const out = await si.prepareSiteImage(screen, source);
    assert.equal(out.mime, 'image/webp');
    assert.equal(out.bytes.subarray(8, 12).toString('latin1'), 'WEBP');
    assert.deepEqual([out.width, out.height], [1280, 800]);
    assert.deepEqual(si.imageDimensions(out.bytes, 'image/webp'), { width: 1280, height: 800 });
    assert.ok(!out.bytes.includes(Buffer.from('SECRET-LOCATION')), 'metadata dropped');
    assert.ok(out.warnings.some((w) => /smaller/.test(w)));
    assert.ok(!out.warnings.some((w) => /cropped/.test(w)), '16:10 is the slot shape');
    assert.match(out.sha256, /^[0-9a-f]{64}$/);

    const square = await si.prepareSiteImage(og, png(300, 300));
    assert.equal(square.mime, 'image/png');
    assert.deepEqual(si.imageDimensions(square.bytes, 'image/png'), { width: 1200, height: 630 });
    assert.ok(square.warnings.some((w) => /cropped/.test(w)), 'more than 10% off: allowed with a warning');

    const jpeg = createCanvas(120, 63).toBuffer('image/jpeg');
    assert.deepEqual(si.imageDimensions(jpeg, 'image/jpeg'), { width: 120, height: 63 });
    assert.equal((await si.prepareSiteImage(og, jpeg)).mime, 'image/png');

    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
    await assert.rejects(si.prepareSiteImage(og, gif), /Only PNG, JPEG or WebP/);
    await assert.rejects(si.prepareSiteImage(og, Buffer.from('not an image')), /Only PNG, JPEG or WebP/);
    await assert.rejects(si.prepareSiteImage(og, Buffer.alloc(si.IMAGE_MAX_BYTES + 1)), /larger than 2 MB/);
    await assert.rejects(si.prepareSiteImage(og, null), /Choose an image/);
    // A header claiming 5000×5000 is refused before decoding.
    const bomb = png(10, 10);
    bomb.writeUInt32BE(5000, 16);
    bomb.writeUInt32BE(5000, 20);
    await assert.rejects(si.prepareSiteImage(og, bomb), /too large: at most 4000×4000/);
    // Right magic bytes, broken content.
    const broken = Buffer.concat([png(10, 10).subarray(0, 40), Buffer.alloc(30)]);
    await assert.rejects(si.prepareSiteImage(og, broken), /could not be read/);
});

test('slot serving: an uploaded image wins (ETag, 5 min cache, 304), reset → the file again; other images unchanged', async () => {
    const app = express();
    app.use(createSite({ client: { commands: null }, env: { CLIENT_ID: '400000000000000004' }, leaderboard: async () => ({ enabled: true, rows: [] }), status: () => ({ state: 'online', uptimeMs: 1 }) }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const before = await fetch(`${base}/img/og.png`);
        const fileBytes = Buffer.from(await before.arrayBuffer());
        assert.equal(before.status, 200);
        assert.equal(before.headers.get('cache-control'), 'public, max-age=300');

        const bytes = png(1200, 630);
        si.setUploadedImage({ slot: 'og', mime: 'image/png', width: 1200, height: 630, bytes, sha256: 'a'.repeat(64), updated_by: OWNER, updated_at: new Date() });
        const after = await fetch(`${base}/img/og.png?v=1`);
        assert.equal(after.status, 200);
        assert.equal(after.headers.get('etag'), `"${'a'.repeat(64)}"`);
        assert.equal(after.headers.get('cache-control'), 'public, max-age=300');
        assert.match(after.headers.get('content-security-policy'), /default-src 'none'/);
        assert.ok(Buffer.from(await after.arrayBuffer()).equals(bytes));
        // node:http, not fetch: fetch adds "Cache-Control: no-cache" to conditional requests.
        const conditional = await new Promise((resolve, reject) => {
            http.get(`${base}/img/og.png`, { headers: { 'If-None-Match': `"${'a'.repeat(64)}"` } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
        });
        assert.equal(conditional, 304);

        si.setUploadedImage({ slot: 'logo', mime: 'image/png', width: 64, height: 64, bytes, sha256: 'b'.repeat(64), updated_by: OWNER, updated_at: new Date() });
        assert.ok(Buffer.from(await (await fetch(`${base}/favicon.png`)).arrayBuffer()).equals(bytes), 'the favicon follows the logo slot');

        si.clearUploadedImage('og');
        si.clearUploadedImage('logo');
        assert.ok(Buffer.from(await (await fetch(`${base}/img/og.png`)).arrayBuffer()).equals(fileBytes), 'back to the file');
        assert.equal((await fetch(`${base}/favicon.png`)).headers.get('cache-control'), 'public, max-age=86400');
        assert.equal((await fetch(`${base}/img/cat/young-happy.png`)).headers.get('cache-control'), 'public, max-age=604800', 'cat pictures are not slots');
        assert.equal((await fetch(`${base}/img/nope.png`)).status, 404);
    } finally {
        si.resetUploadedImagesForTest();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('loadSiteImages: a DB error leaves the files; unknown slots are skipped', async () => {
    si.resetUploadedImagesForTest();
    assert.equal(await si.loadSiteImages({ listAll: async () => { throw new Error('down'); } }), null);
    assert.equal(si.uploadedImage('og'), null);
    assert.equal(await si.loadSiteImages({ listAll: async () => [{ slot: 'og', bytes: Buffer.from('x'), sha256: 'c'.repeat(64), mime: 'image/png' }, { slot: 'evil', bytes: Buffer.from('x') }] }), 1);
    assert.ok(si.uploadedImage('og'));
    si.resetUploadedImagesForTest();
});

// ── Dashboard handlers ────────────────────────────────────────────────────

function fakeRes() {
    return {
        statusCode: 200, headers: {}, cookies: [], body: null, redirectedTo: null,
        status(code) { this.statusCode = code; return this; },
        type() { return this; },
        send(body) { this.body = body; return this; },
        set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; },
        append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
}

function memoryContentStore({ failSave = false } = {}) {
    const rows = new Map();
    const history = [];
    const calls = [];
    return {
        rows, log: history, calls,
        listAll: async () => [...rows.values()],
        save: async ({ lang, key, text, sourceHash, userId }) => {
            calls.push(['save', lang, key]);
            if (failSave) throw new Error('connection refused');
            const oldText = rows.get(`${lang}|${key}`)?.text ?? null;
            const row = { lang, key, text, source_hash: sourceHash, updated_by: userId, updated_at: new Date() };
            rows.set(`${lang}|${key}`, row);
            history.unshift({ id: history.length + 1, lang, key, old_text: oldText, new_text: text, changed_by: userId, changed_at: new Date() });
            return { row, oldText };
        },
        reset: async ({ lang, key, userId }) => {
            const old = rows.get(`${lang}|${key}`);
            rows.delete(`${lang}|${key}`);
            if (old) history.unshift({ id: history.length + 1, lang, key, old_text: old.text, new_text: null, changed_by: userId, changed_at: new Date() });
            return { removed: Boolean(old), oldText: old?.text ?? null };
        },
        history: async (lang, key) => history.filter((h) => h.lang === lang && h.key === key),
        historyEntry: async (id) => history.find((h) => h.id === id) || null,
    };
}

async function setup({ userId = OWNER, env = ENV, content = memoryContentStore(), images = null, createdAt = Date.now() } = {}) {
    const client = { user: { id: '999999999999999998', username: 'Mewvo' }, guilds: { cache: new Map() }, users: { cache: new Map(), fetch: async () => null } };
    const sessions = createMemorySessionStore({ ttlMs: 48 * 3600 * 1000 });
    const access = createAccessChecker(client, { facts: async (c, id) => ({ inGuild: true, isAdmin: id === ADMIN || id === OWNER, isOwnerId: id === OWNER }) });
    const auditRows = [];
    const auditStore = { writeRows: async (g, actor, module, changes) => { for (const c of changes) auditRows.push({ module, ...c }); return changes.length; }, list: async () => ({ rows: [], total: 0 }), users: async () => [] };
    const services = { postModLog: async () => {}, getAutomodSettings: async () => ({}), getJoinToCreateConfiguration: async () => ({}), getApplicationSettings: async () => ({}) };
    const data = { overview: { getGuildConfig: async () => ({}), getWelcomeConfig: async () => ({}) } };
    const imageCalls = [];
    const imageStore = images || {
        save: async (row) => { imageCalls.push(['save', row.slot]); return { row: { slot: row.slot, mime: row.mime, width: row.width, height: row.height, sha256: row.sha256, updated_by: row.userId, updated_at: new Date() }, oldSha256: null }; },
        remove: async (slot) => { imageCalls.push(['remove', slot]); return { removed: true, oldSha256: 'd'.repeat(64) }; },
    };
    const d = createDashboard({
        client, settings: dashboardSettings(env), sessions, access, services, auditStore, env, data,
        owner: { isBotOwner: (id) => id === OWNER }, website: { content, images: imageStore },
    });
    const session = await sessions.create({ userId, username: 'owner' }, createdAt);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, SECRET))}`;
    return { d, session, cookie, auditRows, content, imageCalls, ow: d.owner, wb: d.website };
}

async function run(h, handler, req) {
    const res = fakeRes();
    let passed = false;
    await h.d.requireUser(req, res, () => { passed = true; });
    if (!passed) return res;
    let ownerOk = false;
    await h.ow.requireOwner(req, res, () => { ownerOk = true; });
    if (ownerOk) await handler(req, res, () => {});
    return res;
}
const get = (h, handler, { query = {}, params = {} } = {}) => run(h, handler, { method: 'GET', params, query, headers: { cookie: h.cookie } });
const post = (h, handler, { form = {}, origin = ORIGIN, csrf = h.session.csrf, params = {}, upload = undefined } = {}) => run(h, handler, {
    method: 'POST', params, query: {}, path: '/owner/website', headers: { cookie: h.cookie, ...(origin ? { origin } : {}) }, body: { csrf, ...form }, upload,
});

test('website: in the Owner nav; non-owners get 404 on every page and POST, nothing saved', async () => {
    useTestCatalogs();
    try {
        assert.ok(OWNER_NAV.items.some((item) => item.key === 'owner/website'));
        const h = await setup({ userId: ADMIN });
        for (const [handler, opts] of [[h.wb.home], [h.wb.images], [h.wb.namespace, { params: { ns: 'home' } }], [h.wb.key, { query: { k: 'home.title' } }]]) {
            assert.equal((await get(h, handler, opts)).statusCode, 404);
        }
        assert.equal((await post(h, h.wb.save, { form: { key: 'home.title', lang: 'de', text: 'X {name}', do: 'save' } })).statusCode, 404);
        assert.equal((await post(h, h.wb.reset, { form: { key: 'home.title', lang: 'de' } })).statusCode, 404);
        assert.equal((await post(h, h.wb.imageReset, { params: { slot: 'og' } })).statusCode, 404);
        assert.deepEqual(h.content.calls, []);
        assert.deepEqual(h.imageCalls, []);
    } finally { restoreCatalogs(); }
});

test('website: wrong origin / CSRF → 403, editing off → 403, old login → 401; nothing saved', async () => {
    useTestCatalogs();
    try {
        const form = { key: 'home.title', lang: 'de', text: 'Servus {name}', do: 'save' };
        const h = await setup();
        assert.equal((await post(h, h.wb.save, { form, origin: 'https://evil.example' })).statusCode, 403);
        assert.equal((await post(h, h.wb.save, { form, csrf: 'nope' })).statusCode, 403);
        const off = await setup({ env: { ...ENV, DASHBOARD_EDIT_ENABLED: 'false' } });
        assert.equal((await post(off, off.wb.save, { form })).statusCode, 403);
        const stale = await setup({ createdAt: Date.now() - 13 * 3600 * 1000 });
        assert.equal((await post(stale, stale.wb.save, { form })).statusCode, 401);
        assert.deepEqual([...h.content.calls, ...off.content.calls, ...stale.content.calls], []);
    } finally { restoreCatalogs(); }
});

test('website: overview, group and key pages; preview does not save; save is live and audited; reset and restore', async () => {
    useTestCatalogs();
    try {
        const h = await setup();
        const home = await get(h, h.wb.home);
        assert.equal(home.statusCode, 200);
        assert.match(home.body, /legal pages/i);
        assert.match(home.body, /href="\/dashboard\/owner\/website\/ns\/home"/);
        const ns = await get(h, h.wb.namespace, { params: { ns: 'home' }, query: { lang: 'ru', filter: 'missing' } });
        assert.equal(ns.statusCode, 200);
        assert.match(ns.body, /home\.title/);
        assert.equal((await get(h, h.wb.namespace, { params: { ns: 'nope' } })).statusCode, 404);
        const keyPage = await get(h, h.wb.key, { query: { k: 'home.title' } });
        assert.equal(keyPage.statusCode, 200);
        assert.match(keyPage.body, /id="lang-de"/);
        assert.match(keyPage.body, /name="do" value="preview"/);
        assert.ok(!/<script/i.test(keyPage.body.replace(/<script src="\/dashboard\/static\/[^"]+"[^>]*><\/script>/g, '')), 'no inline script');
        assert.ok(!/ style="/.test(keyPage.body), 'no inline style');
        assert.equal((await get(h, h.wb.key, { query: { k: 'nope.key' } })).statusCode, 404);

        const preview = await post(h, h.wb.save, { form: { key: 'home.title', lang: 'de', text: 'Servus **{name}** <i>', do: 'preview' } });
        assert.equal(preview.statusCode, 200);
        assert.match(preview.body, /<strong>\{name\}<\/strong> &lt;i&gt;/);
        assert.match(preview.body, /HTML is not supported/);
        assert.deepEqual(h.content.calls, [], 'a preview saves nothing');

        const refused = await post(h, h.wb.save, { form: { key: 'home.title', lang: 'de', text: 'Servus', do: 'save' } });
        assert.equal(refused.statusCode, 400);
        assert.match(refused.body, /missing \{name\}/);
        assert.match(refused.body, />Servus<\/textarea>/, 'the draft is kept');

        const saved = await post(h, h.wb.save, { form: { key: 'home.title', lang: 'de', text: 'Servus {name}', do: 'save' } });
        assert.equal(saved.statusCode, 303);
        assert.match(saved.redirectedTo, /\/owner\/website\/key\?k=home\.title#lang-de$/);
        assert.equal(i18n.translate('de', 'home.title', { name: 'A' }), 'Servus A', 'live at once');
        assert.equal(sc.overrideOf('de', 'home.title').source_hash, sc.sha256('Hello {name}'));
        assert.deepEqual(h.auditRows.at(-1), { module: 'website', key: 'de.home.title', old: null, new: 'Servus {name}' });

        const same = await post(h, h.wb.save, { form: { key: 'home.title', lang: 'de', text: 'Servus {name}', do: 'save' } });
        assert.equal(same.statusCode, 400);
        assert.match(same.body, /Nothing changed/);

        const long = `{name} ${'ä'.repeat(900)}`;
        await post(h, h.wb.save, { form: { key: 'home.title', lang: 'de', text: long, do: 'save' } });
        assert.equal(h.auditRows.at(-1).new.length, 500, 'audit values are cut to 500 characters');

        const reset = await post(h, h.wb.reset, { form: { key: 'home.title', lang: 'de' } });
        assert.equal(reset.statusCode, 303);
        assert.equal(i18n.translate('de', 'home.title', { name: 'A' }), 'Hallo A', 'catalog text again');
        assert.equal(h.auditRows.at(-1).new, null);
        assert.equal((await post(h, h.wb.reset, { form: { key: 'home.title', lang: 'de' } })).statusCode, 400, 'already default');

        const first = h.content.log.find((e) => e.new_text === 'Servus {name}');
        const restored = await post(h, h.wb.restore, { form: { key: 'home.title', lang: 'de', id: String(first.id) } });
        assert.equal(restored.statusCode, 303);
        assert.equal(i18n.translate('de', 'home.title', { name: 'A' }), 'Servus A');
        assert.equal((await post(h, h.wb.restore, { form: { key: 'home.intro', lang: 'de', id: String(first.id) } })).statusCode, 400, 'a version of another key');
    } finally { restoreCatalogs(); }
});

test('website: a DB error on save → 503 "nothing was changed", the site and the audit log unchanged', async () => {
    useTestCatalogs();
    try {
        const h = await setup({ content: memoryContentStore({ failSave: true }) });
        const res = await post(h, h.wb.save, { form: { key: 'home.title', lang: 'de', text: 'Servus {name}', do: 'save' } });
        assert.equal(res.statusCode, 503);
        assert.match(res.body, /Nothing was changed/);
        assert.equal(sc.overrideOf('de', 'home.title'), null);
        assert.equal(i18n.translate('de', 'home.title', { name: 'A' }), 'Hallo A');
        assert.equal(h.auditRows.length, 0);
    } finally { restoreCatalogs(); }
});

test('website images: upload re-encodes, goes live and is audited; refused files change nothing; reset', async () => {
    si.resetUploadedImagesForTest();
    try {
        const h = await setup();
        const page = await get(h, h.wb.images);
        assert.equal(page.statusCode, 200);
        for (const def of si.SITE_IMAGE_SLOTS) assert.ok(page.body.includes(`/owner/website/images/${def.slot}/upload`), def.slot);
        assert.match(page.body, /enctype="multipart\/form-data"/);

        const bad = await post(h, h.wb.imageUpload, { params: { slot: 'og' }, upload: { file: { data: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1') } } });
        assert.equal(bad.statusCode, 400);
        assert.match(bad.body, /Only PNG, JPEG or WebP/);
        assert.equal((await post(h, h.wb.imageUpload, { params: { slot: 'nope' }, upload: { file: { data: png(10, 10) } } })).statusCode, 400);
        assert.deepEqual(h.imageCalls, []);

        const ok = await post(h, h.wb.imageUpload, { params: { slot: 'og' }, upload: { file: { data: png(240, 126) } } });
        assert.equal(ok.statusCode, 303);
        const live = si.uploadedImage('og');
        assert.deepEqual([live.width, live.height], [1200, 630]);
        assert.ok(Buffer.isBuffer(live.bytes));
        assert.equal(h.auditRows.at(-1).key, 'image.og');
        assert.equal(h.auditRows.at(-1).old, 'default file');
        assert.match(h.auditRows.at(-1).new, /image\/png 1200×630/);

        const reset = await post(h, h.wb.imageReset, { params: { slot: 'og' } });
        assert.equal(reset.statusCode, 303);
        assert.equal(si.uploadedImage('og'), null);
        assert.deepEqual(h.imageCalls, [['save', 'og'], ['remove', 'og']]);
        assert.equal((await post(h, h.wb.imageReset, { params: { slot: 'og' } })).statusCode, 400, 'already default');

        const down = await setup({ images: { save: async () => { throw new Error('connection refused'); }, remove: async () => { throw new Error('x'); } } });
        const failed = await post(down, down.wb.imageUpload, { params: { slot: 'logo' }, upload: { file: { data: png(64, 64) } } });
        assert.equal(failed.statusCode, 503);
        assert.equal(si.uploadedImage('logo'), null, 'nothing shown as saved');
        assert.equal(down.auditRows.length, 0);
    } finally { si.resetUploadedImagesForTest(); }
});

test('review fixes: control characters, {params} in link addresses, stale edits skipped on load, a broken edit never breaks a page', () => {
    i18n.setCatalogsForTest(new Map([
        ['en', new Map([['home.title', 'Hello {name}'], ['home.link', 'See [the case]({url}) {code}']])],
        ...i18n.LANG_CODES.filter((c) => c !== 'en').map((c) => [c, new Map()]),
    ]));
    sc.setOverrideRows([]);
    sc.installOverrides();
    try {
        assert.throws(() => sc.validateSiteText('de', 'home.title', 'Hi {name}\u0000'), /control characters/);
        assert.throws(() => sc.validateSiteText('de', 'home.link', 'Siehe [den Fall]({code}) {url}'), /\{code\} cannot be used inside a link address/);
        assert.equal(sc.validateSiteText('de', 'home.link', 'Siehe [den Fall]({url}) {code}').text, 'Siehe [den Fall]({url}) {code}');
        // A row saved for an older English text ({who} no longer exists) is not loaded.
        assert.equal(sc.setOverrideRows([{ lang: 'de', key: 'home.title', text: 'Hallo {who}' }, { lang: 'fr', key: 'home.title', text: 'Salut {name}' }]), 1);
        // If an edit still cannot be rendered with what the page passes, the catalog text is shown.
        sc.putOverride({ lang: 'it', key: 'home.title', text: 'Ciao {who}' });
        assert.equal(i18n.translate('it', 'home.title', { name: 'A' }), 'Hello A');
        assert.equal(String(i18n.translateInline('it', 'home.title', { name: 'A' })), 'Hello A');
    } finally { restoreCatalogs(); }
});

test('website: after a failed load at startup the editor retries, and shows 503 instead of "default" while the DB is down', async () => {
    useTestCatalogs();
    try {
        const down = memoryContentStore();
        down.listAll = async () => { throw new Error('connection refused'); };
        await sc.loadSiteContent(down);
        assert.equal(sc.isSiteContentLoaded(), false);
        const h = await setup({ content: down });
        assert.equal((await get(h, h.wb.home)).statusCode, 503);
        assert.equal((await post(h, h.wb.reset, { form: { key: 'home.title', lang: 'de' } })).statusCode, 503);
        const back = memoryContentStore();
        back.rows.set('de|home.title', { lang: 'de', key: 'home.title', text: 'Servus {name}', source_hash: null });
        const h2 = await setup({ content: back });
        assert.equal((await get(h2, h2.wb.home)).statusCode, 200, 'loaded on the next request');
        assert.equal(sc.overrideOf('de', 'home.title').text, 'Servus {name}');
    } finally { restoreCatalogs(); }
});
