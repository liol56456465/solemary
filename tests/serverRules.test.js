// Server rules (services/rules/serverRules.js): the rule line in punishment DMs, the /test
// reason match, the public /rules page, and the stored value's schema. No database: the
// settings cache is filled with setSettingsCacheForTests.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
    addRule, deleteRule, editRule, moveRule, pruneLinks, readPublicRules, ruleForReason, ruleLineFor, rulesPageUrl, setRuleLookupForTests,
} from '../src/services/rules/serverRules.js';
import { banDm, kickDm, muteDm, warnDm } from '../src/services/enforcement/dmTemplates.js';
import { sendDm } from '../src/services/enforcement/enforcementService.js';
import { prebuiltReasonFields } from '../src/commands/Owner/test.js';
import { resetSettingsCacheForTests, setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';
import { validateSetting } from '../src/services/settings/settingsRegistry.js';
import { SITEMAP_PATHS, createSite, sitemapXml } from '../src/services/site/site.js';

const MAIN = '100000000000000001';
const RULE_A = 'aaaa1111';
const RULE_B = 'bbbb2222';
const RULES = {
    rules: [{ id: RULE_A, title: 'Be kind', text: 'No insults.' }, { id: RULE_B, title: 'No spam', text: 'Line one\nLine <b>two</b>' }],
    updatedAt: '2026-10-20T12:00:00.000Z',
};

const saved = { MAIN_GUILD_ID: process.env.MAIN_GUILD_ID, PUBLIC_URL: process.env.PUBLIC_URL };
function useRules({ rules = RULES, links = { spam: RULE_B }, publicUrl = 'https://mewvo.example' } = {}) {
    process.env.MAIN_GUILD_ID = MAIN;
    if (publicUrl === null) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = publicUrl;
    setSettingsCacheForTests(MAIN, { serverRules: rules, reasonRuleLinks: links });
}

afterEach(() => {
    resetSettingsCacheForTests();
    setRuleLookupForTests(null);
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});

const record = (extra = {}) => ({
    case_code: 'abc2345', moderator_username: 'mod', reason: 'Spam', reason_key: 'spam', prebuilt_or_custom: 'prebuilt',
    created_at: new Date('2026-10-28T10:00:00Z'), expires_at: new Date('2026-11-04T10:00:00Z'), duration_ms: 7 * 86400000, ...extra,
});

// ── DMs ───────────────────────────────────────────────────────────────────

test('DM: a linked reason adds "Rule N: title" with the /rules#rule-N link, right after the reason, in every punishment DM', () => {
    useRules();
    const line = 'Rule 2: No spam — <https://mewvo.example/rules#rule-2>';
    for (const dm of [banDm(record()), kickDm(record(), 'https://discord.gg/x'), muteDm(record()), warnDm(record(), 1)]) {
        const lines = dm.split('\n');
        assert.equal(lines[lines.indexOf('Reason: Spam') + 1], line, dm);
    }
});

test('DM: no rule line for an unmapped reason, a custom reason, a link to a deleted rule, or an empty rule list', () => {
    useRules();
    assert.ok(!banDm(record({ reason_key: 'harassment' })).includes('Rule '), 'unmapped');
    assert.ok(!banDm(record({ reason_key: null, prebuilt_or_custom: 'custom', reason: 'Being weird' })).includes('Rule '), 'custom');
    useRules({ links: { spam: 'cccc3333' } });
    assert.ok(!banDm(record()).includes('Rule '), 'dangling link');
    useRules({ rules: { rules: [], updatedAt: null } });
    assert.ok(!banDm(record()).includes('Rule '), 'no rules');
});

test('DM: without PUBLIC_URL the line names the rule without a link; rule numbers follow the order', () => {
    useRules({ publicUrl: null });
    assert.ok(banDm(record()).includes('\nRule 2: No spam\n'));
    assert.equal(rulesPageUrl(2, {}), null);
    useRules({ rules: moveRule(RULES, RULE_B, -1) });
    assert.ok(banDm(record()).includes('Rule 1: No spam — <https://mewvo.example/rules#rule-1>'));
});

test('DM: a failing rule lookup never blocks the DM — it is sent without the line', async () => {
    useRules();
    setRuleLookupForTests(() => { throw new Error('cache exploded'); });
    const content = banDm(record());
    assert.ok(content.includes('Reason: Spam') && !content.includes('Rule '));
    assert.equal(ruleLineFor(record()), null);
    const sent = [];
    const user = { id: '1', send: async (payload) => { sent.push(payload); } };
    assert.equal(await sendDm(user, warnDm(record(), 1)), true, 'the DM is still delivered');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('DM: stays within Discord\'s 2000 characters — the rule line is dropped before the DM would be too long', () => {
    useRules();
    const long = record({ reason: 'x'.repeat(1790) });
    const content = banDm(long);
    assert.ok(content.length <= 2000, String(content.length));
    assert.ok(!content.includes('Rule 2'));
    assert.ok(banDm(record({ reason: 'x'.repeat(500) })).includes('Rule 2'), 'a normal long reason keeps it');
});

test('/test: a reason typed as a prebuilt label or key is saved as that prebuilt reason (so the preview shows its rule)', () => {
    assert.deepEqual(prebuiltReasonFields('spam'), { reason: 'Spam', reasonSource: 'prebuilt', reasonKey: 'spam' });
    assert.deepEqual(prebuiltReasonFields('  harassment '), { reason: 'Harassment', reasonSource: 'prebuilt', reasonKey: 'harassment' });
    assert.deepEqual(prebuiltReasonFields('NSFW content'), { reason: 'NSFW content', reasonSource: 'prebuilt', reasonKey: 'nsfw' });
    assert.deepEqual(prebuiltReasonFields('spamming a lot'), {});
    assert.deepEqual(prebuiltReasonFields('No reason given'), {});
    useRules();
    const preview = muteDm(record({ reason: 'Spam', reason_key: prebuiltReasonFields('spam').reasonKey }));
    assert.ok(preview.includes('Rule 2: No spam'));
});

test('ruleForReason reads the settings cache: number, title and id', () => {
    useRules();
    assert.deepEqual(ruleForReason('spam'), { id: RULE_B, number: 2, title: 'No spam' });
    assert.equal(ruleForReason('slurs'), null);
    assert.equal(ruleForReason(null), null);
});

// ── Stored value ──────────────────────────────────────────────────────────

test('schema: rules and links are validated (limits, one-line titles, unique ids, known shape)', () => {
    assert.equal(validateSetting('serverRules', RULES).ok, true);
    assert.equal(validateSetting('serverRules', { rules: [], updatedAt: null }).ok, true);
    const many = { rules: Array.from({ length: 31 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, title: 't', text: '' })), updatedAt: null };
    assert.equal(validateSetting('serverRules', many).ok, false, '31 rules');
    const rule = (extra) => ({ rules: [{ id: RULE_A, title: 'ok', text: '', ...extra }], updatedAt: null });
    assert.equal(validateSetting('serverRules', rule({ title: 'x'.repeat(81) })).ok, false);
    assert.equal(validateSetting('serverRules', rule({ title: 'a\nb' })).ok, false);
    assert.equal(validateSetting('serverRules', rule({ title: '  ' })).ok, false);
    assert.equal(validateSetting('serverRules', rule({ text: 'y'.repeat(1001) })).ok, false);
    assert.equal(validateSetting('serverRules', rule({ id: 'BAD ID' })).ok, false);
    assert.equal(validateSetting('serverRules', rule({ extra: 1 })).ok, false, 'no unknown fields');
    assert.equal(validateSetting('serverRules', { rules: [{ id: RULE_A, title: 'a', text: '' }, { id: RULE_A, title: 'b', text: '' }], updatedAt: null }).ok, false, 'unique ids');
    assert.equal(validateSetting('serverRules', { rules: [], updatedAt: 'yesterday' }).ok, false);
    assert.equal(validateSetting('reasonRuleLinks', { spam: RULE_A }).ok, true);
    assert.equal(validateSetting('reasonRuleLinks', { spam: 3 }).ok, false);
    assert.equal(validateSetting('reasonRuleLinks', { 'Bad Key': RULE_A }).ok, false);
});

test('list operations return new values and never change the old one', () => {
    const frozen = structuredClone(RULES);
    const added = addRule(RULES, { title: 'New', text: '' }, Date.parse('2026-10-29T00:00:00Z'));
    assert.equal(added.rules.length, 3);
    assert.equal(added.updatedAt, '2026-10-29T00:00:00.000Z');
    assert.notEqual(added.rules[2].id, RULE_A);
    assert.deepEqual(editRule(RULES, RULE_A, { title: 'Kind', text: '' }).rules[0], { id: RULE_A, title: 'Kind', text: '' });
    assert.equal(editRule(RULES, 'zzzz9999', { title: 'x', text: '' }), null);
    assert.deepEqual(deleteRule(RULES, RULE_A).rules.map((r) => r.id), [RULE_B]);
    assert.equal(moveRule(RULES, RULE_A, -1), null, 'first cannot move up');
    assert.equal(moveRule(RULES, RULE_B, 1), null, 'last cannot move down');
    assert.deepEqual(pruneLinks({ spam: RULE_B, slurs: RULE_A }, deleteRule(RULES, RULE_A)), { spam: RULE_B });
    const full = { rules: Array.from({ length: 30 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, title: 't', text: '' })), updatedAt: null };
    assert.equal(addRule(full, { title: 'x', text: '' }), null);
    assert.deepEqual(RULES, frozen);
});

// ── Public page ───────────────────────────────────────────────────────────

async function serve(rules) {
    const app = express();
    app.use(createSite({ client: { commands: new Map() }, env: { CLIENT_ID: '123456789012345678' }, rules, leaderboard: async () => ({ enabled: true, rows: [] }), status: () => ({ state: 'online', uptimeMs: 1 }) }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        get: async (path) => { const res = await fetch(base + path); return { status: res.status, body: await res.text(), headers: res.headers }; },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

test('/rules: numbered rules with #rule-N anchors, escaped text, last-updated date and the appeals line; no inline style or script', async () => {
    const hostile = { rules: [...RULES.rules, { id: 'cccc3333', title: '<script>alert(1)</script>', text: '"><img src=x onerror=alert(1)>' }], updatedAt: RULES.updatedAt };
    const site = await serve(() => ({ rules: hostile.rules.map((r, i) => ({ ...r, number: i + 1 })), updatedAt: hostile.updatedAt }));
    try {
        const res = await site.get('/rules');
        assert.equal(res.status, 200);
        assert.ok(res.body.includes('<h1>Server rules</h1>'));
        assert.ok(res.body.includes('<li class="rule" id="rule-1"><a class="rule-num" href="#rule-1" aria-label="Link to rule 1">01</a>'));
        assert.ok(res.body.includes('id="rule-2"') && res.body.includes('id="rule-3"'));
        assert.ok(res.body.includes('<h2 class="rule-title">No spam</h2><p class="rule-text">Line one\nLine &lt;b&gt;two&lt;/b&gt;</p>'));
        assert.ok(res.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !res.body.includes('<script>alert'));
        assert.ok(!res.body.includes('<img src=x'));
        assert.ok(res.body.includes('Last updated <time datetime="2026-10-20">20 October 2026</time>.'));
        assert.ok(res.body.includes('<a href="/docs/appeals">How appeals work</a>'));
        assert.ok(!/<script/i.test(res.body.replace('&lt;script&gt;', '')), 'no scripts');
        assert.ok(!/\sstyle=|<style/i.test(res.body), 'no inline styles');
        assert.ok(res.headers.get('content-security-policy').includes("script-src 'none'"));
        assert.ok(res.body.includes('<li><a href="/rules" aria-current="page">Rules</a></li>'), 'footer link, current');
    } finally { await site.close(); }
});

test('/rules: no rules → "has not published its rules yet" (no date); a read error → 503, never an empty list', async () => {
    const empty = await serve(() => ({ rules: [], updatedAt: '2026-10-20T12:00:00.000Z' }));
    try {
        const res = await empty.get('/rules');
        assert.equal(res.status, 200);
        assert.ok(res.body.includes('This server has not published its rules yet.'));
        assert.ok(!res.body.includes('Last updated') && !res.body.includes('class="rules-list"'));
    } finally { await empty.close(); }
    const noDate = await serve(() => ({ rules: [{ id: RULE_A, number: 1, title: 'Be kind', text: '' }], updatedAt: null }));
    try {
        const res = await noDate.get('/rules');
        assert.ok(!res.body.includes('Last updated'), 'no date → omitted');
        assert.ok(!res.body.includes('class="rule-text"'), 'no empty text paragraph');
    } finally { await noDate.close(); }
    const broken = await serve(() => { throw new Error('db down'); });
    try {
        const res = await broken.get('/rules');
        assert.equal(res.status, 503);
        assert.ok(res.body.includes('could not be loaded'));
        assert.ok(!res.body.includes('has not published'));
    } finally { await broken.close(); }
});

test('/rules: the real reader refuses (503) while the settings were never loaded from the database', async () => {
    useRules();
    resetSettingsCacheForTests();
    assert.throws(() => readPublicRules(), /not been loaded/);
    const site = await serve(undefined);
    try {
        assert.equal((await site.get('/rules')).status, 503);
    } finally { await site.close(); }
});

test('sitemap and footer include /rules', async () => {
    assert.ok(SITEMAP_PATHS.includes('/rules'));
    assert.ok(sitemapXml('https://mewvo.example').includes('<loc>https://mewvo.example/rules</loc>'));
    const site = await serve(() => ({ rules: [], updatedAt: null }));
    try {
        const footer = (await site.get('/faq')).body.split('<footer')[1];
        const resources = footer.slice(footer.indexOf('>Resources<'), footer.indexOf('>Legal<'));
        assert.ok(resources.includes('<li><a href="/rules">Rules</a></li>'));
    } finally { await site.close(); }
});
