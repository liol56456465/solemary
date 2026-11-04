// Website text in the catalog (step 0 of the translation): the commands, about, status,
// leaderboard (+ cat card), 404, rules, transparency and trust pages render in English with
// every key they read present, and every key of their catalog files (pages, rules,
// transparency, trust) is read by some state of these pages: no hardcoded leftovers, no dead keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogs, translator } from '../src/services/site/i18n.js';
import {
    aboutPage, catCard, commandsPage, everyoneCommandGroups, leaderboardPage, notFoundPage, statusPage, uptimeWords,
} from '../src/services/site/site.js';
import { rulesPage } from '../src/services/site/pages/rules.js';
import { transparencyErrorPage, transparencyPage } from '../src/services/site/pages/transparency.js';
import { ladderSentence, trustErrorPage, trustPage } from '../src/services/site/pages/trust.js';
import { aggregateReport } from '../src/services/enforcement/transparencyService.js';

const NAMESPACES = ['pages', 'rules', 'transparency', 'trust'];
const SUPPORT = 'https://discord.gg/7Ckv9Bt577';

/** A page context whose t/ti/tb record every key they are asked for. */
function recordingContext(used, extra = {}) {
    const en = translator('en');
    const wrap = (fn) => (key, params) => { used.add(key); return fn(key, params); };
    return {
        publicSite: false, dashboardEnabled: true, installUrl: null, origin: null, supportInvite: SUPPORT, commands: null,
        transparency: false, trustCard: true, ...extra, lang: 'en', t: wrap(en.t), ti: wrap(en.ti), tb: wrap(en.tb),
    };
}

function renderEverything(used) {
    const ctx = (extra) => recordingContext(used, extra);
    const out = [];
    const SUB = (name, description) => ({ type: 1, name, description });
    const cmd = (json, category) => ({ category, data: { toJSON: () => json } });
    // One everyone-command per labelled category ([category, name, subcommand]).
    const everyone = [['Core', 'ping'], ['Community', 'suggest', 'new'], ['Leveling', 'rank'], ['Fun', 'fun', 'flip'], ['Birthday', 'birthday', 'set'],
        ['Utility', 'todo', 'add'], ['Tools', 'tools', 'time'], ['Search', 'search', 'define'], ['Verification', 'verify'], ['Ticket', 'claim'], ['Ticket', 'close']];
    const commands = new Map([
        ...everyone.map(([category, name, sub]) => [name, cmd({ name, description: 'd', options: sub ? [SUB(sub, 's')] : undefined }, category)]),
        ['Report message', cmd({ name: 'Report message', type: 3 }, undefined)],
    ]);
    // No everyone member menu exists today; the member wording is still in the catalog for one.
    const memberMenu = new Map([['Report message', cmd({ name: 'Report message', type: 2 }, undefined)]]);
    out.push(commandsPage(ctx({ commands })), commandsPage(ctx({ commands: memberMenu })), commandsPage(ctx({ commands: new Map() })));
    assert.equal(everyoneCommandGroups(commands, ctx()).length, 11, 'every labelled category + menus');
    for (const publicSite of [false, true]) for (const supportInvite of [SUPPORT, null]) out.push(aboutPage(ctx({ publicSite, supportInvite })));
    for (const state of ['online', 'starting', 'degraded']) for (const supportInvite of [SUPPORT, null]) out.push(statusPage(ctx({ supportInvite }), { state, uptimeMs: 90_060_000 }));
    for (const ms of [0, 60_000, 120_000, 3_600_000, 7_200_000, 86_400_000, 2 * 86_400_000 + 60_000]) out.push(uptimeWords(ms, ctx()));
    out.push(notFoundPage(ctx()));
    const row = (rank, name) => ({ rank, name, level: 3, totalXp: 1200 });
    const CAT = { name: 'Mochi', image: 'young-happy.png', stage: { name: 'Young cat' }, mood: 'happy', sentence: 'Mochi is happy.', total: 10, progress: { fraction: 0.5, toNext: 5, next: { name: 'Cat' } } };
    out.push(
        leaderboardPage(ctx(), { page: 1, board: null }),
        leaderboardPage(ctx(), { page: 1, board: { enabled: false, rows: [] } }),
        leaderboardPage(ctx(), { page: 1, board: { enabled: true, rows: [] } }),
        leaderboardPage(ctx(), { page: 3, board: { enabled: true, rows: [] } }),
        leaderboardPage(ctx(), { page: 2, board: { enabled: true, rows: [row(51, 'Ann'), row(52, null), ...Array.from({ length: 50 }, (_, i) => row(53 + i, 'x'))] }, cat: CAT }),
        catCard({ ...CAT, progress: { fraction: 1, toNext: 0, next: null } }, ctx()),
    );
    out.push(
        rulesPage(ctx(), null),
        rulesPage(ctx(), { rules: [], updatedAt: null }),
        rulesPage(ctx(), { rules: [{ number: 1, title: 'Be kind', text: 'No insults.', consequence: 'Warn' }], updatedAt: '2026-10-20T12:00:00Z' }),
    );
    const report = aggregateReport({
        caseRows: [{ month: '2026-05', warns: 12, mutes: 4, kicks: 2, bans: 5, ladder_bans: 2, automod: 6, voided: 1 }],
        appealRows: [
            { month: '2026-10', is_total: false, received: 2, accepted: 1, denied: 0, open: 1, decided: 1, median_hours: 0.5 },
            { month: null, is_total: true, received: 2, accepted: 1, denied: 0, open: 1, decided: 1, median_hours: 0.5 },
        ],
    }, new Date('2026-10-29T13:00:00Z'));
    out.push(transparencyPage(ctx({ transparency: true }), report), transparencyErrorPage(ctx()));
    const card = {
        days: 90, since: new Date('2026-08-03T12:00:00Z'), generatedAt: new Date('2026-11-01T12:00:00Z'), serverName: 'Mewvo', memberCount: 200,
        appeals: { received: 9, accepted: 4, denied: 2, answered: 7, decided: 6, medianFirstHours: 5.2, medianDecisionHours: 30.4 }, cases: 14, flagged: 6, headsUp: { fixed: 8, acted: 2 },
    };
    const small = { ...card, appeals: { received: 2, accepted: 1, denied: 1, answered: 2, decided: 2, medianFirstHours: 3, medianDecisionHours: 4 }, cases: 1, headsUp: { fixed: 1, acted: 1 } };
    const cat = { name: 'Biscuit', stage: { name: 'Young cat' }, mood: 'happy', image: 'young-happy.png' };
    out.push(
        trustPage(ctx(), card, { cat, rules: { rules: [{ number: 1, title: 'No spam' }] } }),
        trustPage(ctx({ transparency: true }), small, { cat: null, rules: { rules: [] } }),
        trustErrorPage(ctx()),
    );
    for (let warns = 0; warns <= 11; warns += 1) out.push(ladderSentence({ warnsPerLevel: warns, ladderBans: { 1: 86_400_000 } }, ctx()));
    out.push(ladderSentence({ warnsPerLevel: 3, ladderBans: { 1: 86_400_000, 2: 2 * 86_400_000, 3: null } }, ctx()));
    return out.map(String);
}

test('core site pages: every key they read exists in English, and every key of their catalogs is read', () => {
    const used = new Set();
    const pages = renderEverything(used); // a missing key or param throws here
    const en = loadCatalogs().get('en');
    for (const key of used) assert.ok(en.has(key), `${key} is in the English catalog`);
    const own = [...en.keys()].filter((key) => NAMESPACES.includes(key.split('.')[0]));
    assert.ok(own.length > 100, `catalog keys: ${own.length}`);
    const unused = own.filter((key) => !used.has(key));
    assert.deepEqual(unused, [], 'every catalog key is read by a page');
    for (const page of pages) assert.ok(!/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(page), 'no unfilled {param}');
});

test('core site pages: bare contexts (tests, other callers) read English through textOf', () => {
    assert.match(String(notFoundPage({})), /<h1>Page not found<\/h1>/);
    assert.equal(uptimeWords(3_720_000), '1 hour, 2 minutes');
    assert.equal(ladderSentence({ warnsPerLevel: 3, ladderBans: { 1: 7 * 86_400_000, 2: null } }),
        'Warnings add up: the third warning brings a 7-day ban, and each warning after that ban brings a longer one (a permanent ban).');
    const groups = everyoneCommandGroups(new Map([['Report message', { data: { toJSON: () => ({ name: 'Report message', type: 3 }) } }]]));
    assert.deepEqual(groups.map((g) => [g.label, g.items[0].description]), [['Right-click menus', 'Right-click a message → Apps → Report message']]);
});
