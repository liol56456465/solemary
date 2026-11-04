// dashboard-screenshots.js — retakes the website's dashboard screenshots and the share image
// from the CURRENT dashboard and site code, with made-up data ("Cozy Corner").
//
//   node scripts/dashboard-screenshots.js                 → writes src/services/site/static/img/
//        screen-overview-{dark,light}.webp, screen-cases-{dark,light}.webp (1280×800) and og.png (1200×630)
//   node scripts/dashboard-screenshots.js --serve         only start the preview (dark :5055, light :5056)
//        and keep it running; open http://127.0.0.1:5055/dashboard/overview or /og. Ctrl+C stops it.
//   node scripts/dashboard-screenshots.js --chrome <path> a different Chromium / headless shell binary
//
// How: createDashboard() is mounted on a bare Express app on 127.0.0.1 with fake data and
// fake services injected; a middleware adds a signed session cookie (an Administrator) and
// the theme cookie. The Discord client is a plain object: nothing logs in to Discord, and
// no database is used (every DB URL is removed from the environment before the app code
// is imported, so a stray query fails instead of reaching a real database). Screenshots are
// taken with the headless Chromium shell that Playwright installed, on 127.0.0.1 only, and
// encoded to WebP with @napi-rs/canvas. Run on Node 22 (`nvm use`).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = path.join(ROOT, 'src/services/site/static/img');
const HOST = '127.0.0.1';
const PORTS = { dark: 5055, light: 5056 };
const ORIGIN = (theme) => `http://${HOST}:${PORTS[theme]}`;

// ── a safe, fake environment (before any app module is imported) ───────────
// No DB: drop every connection string, so nothing can reach a real database.
for (const key of Object.keys(process.env)) {
    if (/(^|_)(DATABASE|POSTGRES|PG)(_|$)|_URL$|TOKEN|SECRET|^PG/.test(key)) delete process.env[key];
}
const GUILD = '100000000000000001';
const SUPPORT = '100000000000000002';
const ADMIN = '200000000000000001';
const CH = { general: '500000000000000001', modlog: '500000000000000002', review: '500000000000000003', alerts: '500000000000000004', tickets: '500000000000000005', welcome: '500000000000000006', appeals: '500000000000000007' };
const ROLE = { muted: '600000000000000001', staff: '600000000000000002', banned: '600000000000000003', member: '600000000000000004' };
Object.assign(process.env, {
    NODE_ENV: 'development', LOG_LEVEL: 'warn',
    DASHBOARD_ENABLED: 'true', DASHBOARD_EDIT_ENABLED: 'false', SESSION_SECRET: 'preview-only-'.padEnd(64, 'x'),
    CLIENT_ID: '400000000000000001', DISCORD_CLIENT_SECRET: 'preview-only', PUBLIC_URL: ORIGIN('dark'),
    MAIN_GUILD_ID: GUILD, SUPPORT_GUILD_ID: SUPPORT, OWNER_IDS: '',
    MOD_LOG_CHANNEL_ID: CH.modlog, AUTOMOD_REVIEW_CHANNEL_ID: CH.review, BOT_ALERTS_CHANNEL_ID: CH.alerts, MUTED_ROLE_ID: ROLE.muted,
    MAIN_APPEALS_CATEGORY_ID: CH.appeals, BANNED_ROLE_ID: ROLE.banned,
});
function refuseRemoteDb() {
    for (const [key, value] of Object.entries(process.env)) {
        if (!/postgres(ql)?:\/\//i.test(String(value))) continue;
        const host = (() => { try { return new URL(value).hostname; } catch { return ''; } })();
        if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`Refusing to run: ${key} points at a non-local database.`);
    }
}
refuseRemoteDb();

const express = (await import('express')).default;
const { createDashboard, dashboardRouter, dashboardSettings } = await import('../src/services/dashboard/routes.js');
const { createMemorySessionStore } = await import('../src/services/dashboard/sessionStore.js');
const { createAccessChecker } = await import('../src/services/dashboard/access.js');
const { defaultServices } = await import('../src/services/dashboard/services.js');
const { SESSION_COOKIE, signValue } = await import('../src/services/dashboard/security.js');
const { THEME_COOKIE } = await import('../src/services/dashboard/html.js');
const { warnDmMock } = await import('../src/services/site/pages/mockups.js');
const { createCanvas, loadImage } = await import('@napi-rs/canvas');
refuseRemoteDb();

// ── made-up data ───────────────────────────────────────────────────────────
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW - ms);
const userId = (n) => `30000000000000${String(1000 + n).padStart(4, '0')}`;
const MEMBERS = ['Ari', 'Mika', 'Noor', 'Tomas', 'Lena', 'Kai', 'Juno', 'Sasha', 'Robin', 'Elias', 'Ivy', 'Dana'];
const MODS = { juno: 'Juno', mira: 'Mira', mewvo: 'Mewvo' };

// Case codes: 5–7 characters from the alphabet without look-alikes (no 0 o 1 l i).
const CASES = [
    ['r4mzp', 'mute', 1, MODS.mira, 'Spamming emotes in #general', 25 * MIN, { status: 'appeal_pending', expires: 6 * HOUR }],
    ['p2nfe', 'warn', 5, MODS.juno, 'Arguing with staff in #help', 3 * HOUR, { status: 'appeal_pending' }],
    ['w8hd3a', 'ban', 9, MODS.mewvo, 'Reached warning limit', 7 * HOUR, { expires: 7 * DAY }],
    ['k7xq2', 'warn', 9, MODS.mira, 'Spam in #general', 9 * HOUR],
    ['t6bvn', 'kick', 3, MODS.juno, 'Alt account of a banned member', 20 * HOUR],
    ['h3ycr8', 'ban', 4, MODS.mewvo, 'Scam link (automod)', 1 * DAY + 2 * HOUR],
    ['m9ksd', 'mute', 6, MODS.juno, 'Slurs in voice chat', 2 * DAY, { status: 'revoked', revoke: 'Appeal accepted' }],
    ['v5ajx', 'warn', 1, MODS.mira, 'Off-topic after two reminders', 2 * DAY + 5 * HOUR],
    ['e2qwu7', 'warn', 7, MODS.mewvo, 'Mass mentions (automod)', 3 * DAY],
    ['f8gzt', 'ban', 10, MODS.juno, 'Raid account', 3 * DAY + 4 * HOUR],
    ['c4ner', 'mute', 11, MODS.mira, 'Flooding #art with memes', 4 * DAY, { expires: DAY }],
    ['y7hpm', 'warn', 0, MODS.juno, 'NSFW image in #general', 5 * DAY, { voided: true }],
    ['d3trk', 'kick', 8, MODS.mira, 'Ignoring a mute', 5 * DAY + 6 * HOUR],
    ['u6wsb', 'warn', 2, MODS.juno, 'Begging for roles', 6 * DAY],
];
const caseRows = CASES.map(([code, type, member, mod, reason, age, extra = {}]) => ({
    case_code: code, type, guild_id: GUILD, target_user_id: userId(member), target_username: MEMBERS[member].toLowerCase(),
    moderator_user_id: mod === MODS.mewvo ? '400000000000000001' : userId(mod === MODS.juno ? 20 : 21), moderator_username: mod,
    reason, created_at: ago(age), status: extra.status || (extra.revoke ? 'revoked' : 'active'), is_test: false,
    expires_at: extra.expires ? new Date(NOW - age + extra.expires) : null,
    voided_at: extra.voided ? ago(age - HOUR) : null, revoke_reason: extra.revoke || null,
}));
const appeals = [
    { case_code: 'r4mzp', type: 'mute', username: 'mika', user_id: userId(1), created_at: ago(18 * MIN), is_test: false },
    { case_code: 'p2nfe', type: 'warn', username: 'kai', user_id: userId(5), created_at: ago(2 * HOUR + 10 * MIN), is_test: false },
];
const perDay = (() => {
    const counts = [3, 5, 2, 6, 4, 1, 3];
    return Object.fromEntries(counts.map((count, i) => [new Date(NOW - (6 - i) * DAY).toISOString().slice(0, 10), count]));
})();
const auditRows = [
    { id: 3, created_at: ago(40 * MIN), user_id: ADMIN, username: 'mira', module: 'automod', key: 'secondChance', old: false, new: true },
    { id: 2, created_at: ago(5 * HOUR), user_id: ADMIN, username: 'juno', module: 'leveling', key: 'xpCooldown', old: 60, new: 45 },
    { id: 1, created_at: ago(1 * DAY + 3 * HOUR), user_id: ADMIN, username: 'mira', module: 'welcome', key: 'welcomeMessage', old: 'Welcome!', new: 'Welcome to Cozy Corner, {user}!' },
];

// ── fake Discord client (a plain object: it never connects) ────────────────
function makeGuild() {
    const guild = { id: GUILD, name: 'Cozy Corner', memberCount: 1284, iconURL: () => null };
    const ch = (id, name, type = 0, parentId = null) => ({ id, name, type, parentId, rawPosition: 0, guild, toString: () => `<#${id}>` });
    guild.channels = { cache: new Map([[CH.general, ch(CH.general, 'general')], [CH.modlog, ch(CH.modlog, 'mod-log')], [CH.review, ch(CH.review, 'automod-review')],
        [CH.alerts, ch(CH.alerts, 'alerts')], [CH.tickets, ch(CH.tickets, 'Tickets', 4)], [CH.welcome, ch(CH.welcome, 'welcome')], [CH.appeals, ch(CH.appeals, 'Appeals', 4)]]) };
    const role = (id, name, position) => ({ id, name, position, managed: false, permissions: { has: () => false }, guild });
    guild.roles = { cache: new Map([[GUILD, role(GUILD, '@everyone', 0)], [ROLE.member, role(ROLE.member, 'Member', 1)], [ROLE.muted, role(ROLE.muted, 'Muted', 2)], [ROLE.staff, role(ROLE.staff, 'Staff', 3)]]) };
    // 1284 members, 37 of them joined this week; about a fifth online.
    const members = new Map();
    for (let i = 0; i < guild.memberCount; i += 1) {
        const id = `31${String(i).padStart(16, '0')}`;
        members.set(id, { id, joinedTimestamp: NOW - (i < 37 ? (i + 1) * 4 * HOUR : 30 * DAY + i * HOUR), user: { id, username: `member${i}` } });
    }
    const presences = new Map([...members.keys()].slice(0, 263).map((id) => [id, { status: 'online' }]));
    guild.presences = { cache: presences };
    guild.members = {
        cache: members, me: { permissionsIn: () => ({ has: () => true }), roles: { highest: { position: 10 } }, permissions: { has: () => true } },
        fetch: async () => null,
    };
    guild.bans = { fetch: async () => new Map() };
    return guild;
}
const guild = makeGuild();
const client = {
    user: { id: '400000000000000001', username: 'Mewvo' },
    isReady: () => true, ws: { ping: 42 },
    db: { getStatus: () => ({ connectionType: 'postgresql', isDegraded: false }) },
    guilds: { cache: new Map([[GUILD, guild]]) },
    users: { cache: new Map(), fetch: async (id) => ({ id, username: 'member', tag: 'member' }) },
    commands: new Map(),
};

const guildConfig = {
    logging: { enabled: true }, ticketCategoryId: CH.tickets, ticketStaffRoleId: ROLE.staff,
    verification: { enabled: true }, birthdayChannelId: null, leveling: { enabled: true },
};
const search = async (guildId, filters = {}, { page = 0, pageSize = 25 } = {}) => {
    const rows = caseRows.filter((r) => !filters.type || r.type === filters.type);
    return { rows: rows.slice(page * pageSize, (page + 1) * pageSize), total: rows.length };
};
const overview = {
    getGuildConfig: async () => structuredClone(guildConfig),
    getWelcomeConfig: async () => ({ enabled: true, channelId: CH.welcome }),
    countOpenTickets: async () => 3,
    countActiveSanctions: async () => ({ ban: 4, mute: 1 }),
    listPendingAppeals: async () => appeals,
    searchCaseRecords: search,
    getLockdownState: async () => null,
    findMutedRole: async () => guild.roles.cache.get(ROLE.muted),
    casesPerDay: async () => perDay,
};
const data = {
    overview,
    searchCaseRecords: search,
    getLatestAppealStatusesForCases: async () => new Map([['c4ner', 'denied']]),
    guildPlan: () => 'pro',
    listPendingAppeals: async () => appeals,
};
const services = {
    ...defaultServices,
    getAutomodSettings: async () => ({ enabled: true }),
    getJoinToCreateConfiguration: async () => ({ enabled: true }),
    getApplicationSettings: async () => ({ enabled: false }),
};
const inbox = {
    listPendingAppeals: async () => appeals, listOpenTickets: async () => [], listOpenModmail: async () => [],
    listOpenReports: async () => [], collectOpenReviews: async () => [],
};
const auditStore = {
    writeRows: async () => 0,
    list: async () => ({ rows: auditRows, total: auditRows.length }),
    users: async () => [],
};

// ── the preview servers (127.0.0.1 only; one per theme) ────────────────────
async function startServer(theme) {
    const env = { ...process.env, PUBLIC_URL: ORIGIN(theme) };
    const settings = dashboardSettings(env);
    if (!settings.enabled) throw new Error(`Dashboard settings refused: ${settings.problems.join('; ')}`);
    const sessions = createMemorySessionStore();
    const access = createAccessChecker(client, { guildId: GUILD, facts: async () => ({ inGuild: true, isAdmin: true, isOwnerId: false }) });
    const d = createDashboard({ client, settings, sessions, access, data, services, auditStore, env, inbox, inboxBadge: true });
    const session = await sessions.create({ userId: ADMIN, username: 'mira' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signValue(session.id, settings.sessionSecret))}; ${THEME_COOKIE}=${theme}`;
    const app = express();
    app.use((req, res, next) => {
        req.headers.cookie = cookie;
        req.headers.origin = ORIGIN(theme);
        next();
    });
    app.use('/dashboard', dashboardRouter(d));
    app.get('/site.css', (req, res) => res.type('css').send(readFileSync(path.join(ROOT, 'src/services/site/static/site.css'))));
    app.use('/img', express.static(IMG_DIR, { dotfiles: 'allow' }));
    app.get('/favicon.png', (req, res) => res.sendFile(path.join(IMG_DIR, 'logo.png'), { dotfiles: 'allow' }));
    app.get('/og', (req, res) => res.type('html').send(ogPage()));
    return new Promise((resolve, reject) => {
        const server = app.listen(PORTS[theme], HOST, () => resolve(server)).on('error', reject);
    });
}

/** The share image: the site's own look (site.css) with the home page's headline and its warn-DM mock-up. */
function ogPage() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/site.css"><style>
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: var(--bg); }
.og { box-sizing: border-box; width: 1200px; height: 630px; padding: 64px; display: grid; grid-template-columns: 500px 1fr; gap: 48px; align-items: center; }
.og .brand { font-size: 30px; gap: 14px; margin-bottom: 28px; }
.og .brand .logo { width: 44px; height: 44px; }
.og h1 { font-size: 56px; margin: 0 0 24px; max-width: none; }
.og .lead { font-size: 24px; line-height: 1.4; color: var(--text-muted); margin: 0; }
.og .mock { width: 100%; }
.og .dc { font-size: 17px; }
.og .dc .dc-stamp { white-space: nowrap; }
</style></head><body><div class="og"><div>
<p class="brand"><img class="logo" src="/img/logo.png" width="44" height="44" alt=""><span>Mewvo</span></p>
<h1>A Discord bot for moderation and appeals</h1>
<p class="lead">Case codes, a warning ladder members can follow, and appeals that reach a person.</p>
</div><div>${warnDmMock({ supportInvite: 'discord.gg/…' })}</div></div></body></html>`;
}

// ── screenshots ─────────────────────────────────────────────────────────────
const run = promisify(execFile);

function chromeBinary() {
    const at = process.argv.indexOf('--chrome');
    if (at > -1 && process.argv[at + 1]) return process.argv[at + 1];
    const base = path.join(homedir(), '.cache/ms-playwright');
    const dir = readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
    if (!dir) throw new Error('No Playwright headless shell found; pass --chrome <path>');
    return path.join(base, dir, 'chrome-headless-shell-linux64/chrome-headless-shell');
}

async function screenshot(chrome, url, outFile, width, height) {
    if (new URL(url).hostname !== HOST) throw new Error(`Screenshots are for ${HOST} only: ${url}`);
    await run(chrome, ['--no-sandbox', '--hide-scrollbars', '--virtual-time-budget=3000', `--screenshot=${outFile}`, `--window-size=${width},${height}`, url]);
}

async function toWebp(pngFile, outFile) {
    const image = await loadImage(readFileSync(pngFile));
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    writeFileSync(outFile, await canvas.encode('webp', 82));
}

async function main() {
    const servers = await Promise.all(Object.keys(PORTS).map(startServer));
    // Warm the inbox badge (it loads in the background on the first page view).
    for (const theme of Object.keys(PORTS)) await fetch(`${ORIGIN(theme)}/dashboard/overview`).then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (process.argv.includes('--serve')) {
        console.log(`Preview: ${ORIGIN('dark')}/dashboard/overview (dark), ${ORIGIN('light')}/dashboard/overview (light), ${ORIGIN('dark')}/og`);
        return;
    }
    const chrome = chromeBinary();
    const work = mkdtempSync(path.join(tmpdir(), 'mewvo-shots-'));
    try {
        for (const theme of Object.keys(PORTS)) {
            for (const page of ['overview', 'cases']) {
                const png = path.join(work, `${page}-${theme}.png`);
                await screenshot(chrome, `${ORIGIN(theme)}/dashboard/${page}`, png, 1280, 800);
                const out = path.join(IMG_DIR, `screen-${page}-${theme}.webp`);
                await toWebp(png, out);
                console.log(`${path.relative(ROOT, out)}  ${Math.round(statSync(out).size / 1024)} KB`);
            }
        }
        const og = path.join(IMG_DIR, 'og.png');
        await screenshot(chrome, `${ORIGIN('dark')}/og`, og, 1200, 630);
        console.log(`${path.relative(ROOT, og)}  ${Math.round(statSync(og).size / 1024)} KB`);
    } finally {
        rmSync(work, { recursive: true, force: true });
        for (const server of servers) server.close();
        for (const server of servers) server.closeAllConnections?.();
    }
}

await main();
if (!process.argv.includes('--serve')) process.exit(0);
