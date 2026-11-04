// Website text of Mewvo accounts and "My record" (account.json, portal.json): every key the pages
// read exists in English, no catalog key is left unused, and every page renders from the catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCatalogs } from '../src/services/site/i18n.js';
import * as pages from '../src/services/site/accountPages.js';
import { bonusText } from '../src/services/site/accountRoutes.js';
import { buildRecordView, loginPage, recordPage } from '../src/services/site/memberPortal.js';

const FILES = ['accountPages.js', 'accountRoutes.js', 'memberPortal.js'].map((f) => readFileSync(new URL(`../src/services/site/${f}`, import.meta.url), 'utf8'));
const SOURCE = FILES.join('\n');
const english = loadCatalogs().get('en');
const ours = [...english.keys()].filter((k) => k.startsWith('account.') || k.startsWith('portal.'));

// Keys built at run time: prefix → the endings the code can produce.
const failNames = [...SOURCE.matchAll(/fail\(res, \d{3}, '([a-zA-Z]+)'/g)].map((m) => m[1]);
const DYNAMIC = {
    'portal.errors.': failNames.flatMap((n) => [`${n}.title`, `${n}.message`]),
    'portal.caseType.': ['ban', 'kick', 'mute', 'warn'],
    'portal.appealStatus.': ['pending', 'accepted', 'denied', 'closed'],
    'account.plan.source.': ['bonus', 'purchase', 'key', 'owner'],
    'portal.record.column.': ['case', 'type', 'reason', 'by', 'date', 'ends', 'status', 'appeal', 'filed', 'decided'],
};

function usedKeys() {
    const keys = new Set([...SOURCE.matchAll(/\bt[ib]?\(\s*'((?:account|portal)\.[a-zA-Z.]+)'/g)].map((m) => m[1]));
    // t(cond ? 'a' : 'b')
    for (const m of SOURCE.matchAll(/'((?:account|portal)\.[a-zA-Z]+\.[a-zA-Z.]+)'/g)) keys.add(m[1]);
    for (const [prefix, ends] of Object.entries(DYNAMIC)) for (const end of ends) keys.add(prefix + end);
    return keys;
}

test('every key the account and portal pages read exists in English', () => {
    assert.ok(failNames.length >= 10, 'the fail(...) calls were found');
    const missing = [...usedKeys()].filter((k) => !english.has(k));
    assert.deepEqual(missing, []);
});

test('no unused keys in account.json and portal.json', () => {
    const used = usedKeys();
    assert.deepEqual(ours.filter((k) => !used.has(k)), []);
});

test('no English text left in the page templates', () => {
    // A heading, label, button or paragraph with a literal English word is a missed key.
    for (const [i, file] of FILES.entries()) {
        const hits = [...file.matchAll(/<(h1|h2|dt|label|legend|button|th|li|p)( [^>]*)?>[A-Za-z]{3,}/g)].map((m) => m[0]);
        assert.deepEqual(hits, [], `file ${i}`);
    }
});

test('every account and portal page renders from the catalog', () => {
    const ctx = { memberPortal: true, billing: true, accounts: true, supportInvite: 'https://discord.gg/abc' };
    const session = { csrf: 'c', username: 'ana', accountId: '1', userId: '2' };
    const account = { username: 'ana', discord_user_id: '2', created_at: new Date(), totp_enabled_at: new Date() };
    const now = Date.now();
    const out = [
        pages.signupPage(ctx, { csrf: 'c', error: 'e' }),
        pages.passwordLoginPage(ctx, { csrf: 'c', flash: 'f' }),
        pages.twoStepPage(ctx, { csrf: 'c' }),
        pages.forgotPage(ctx, { csrf: 'c' }),
        pages.resetPage(ctx, { csrf: 'c', username: 'ana', twoStep: true }),
        pages.doneLoginPage(ctx, 'T', 'M'),
        pages.linkDiscordPage(ctx, { session, account }),
        pages.linkedPage(ctx, { session, account, flash: 'f', offer: { letters: ['a'] } }),
        pages.linkedPage(ctx, { session, account, flash: null, offer: { letters: [] } }),
        pages.recoveryCodesPage(ctx, { codes: ['x'] }),
        pages.totpSetupPage(ctx, { session, pending: 'p', secretText: 'K', uri: 'otpauth://x' }),
        pages.accountSettingsPage(ctx, { session, account, plan: { plan_id: 'pro', expires_at: now + 86400000 * 3, source: 'key' }, bonus: { link_number: 3, pro_granted_at: now }, now }),
        pages.accountSettingsPage({ ...ctx, billing: false }, { session, account: { ...account, totp_enabled_at: null }, bonus: { link_number: 300 }, now }),
        pages.deletedPage(ctx),
        pages.accountMessagePage(ctx, 'T', 'M'),
        loginPage(ctx),
        recordPage(ctx, {
            session,
            view: buildRecordView({
                standing: { ladder: { level: 0, warns_since_level: 1 }, warns: [], activeBan: { case_code: 'b', expires_at: null }, activeMute: { case_code: 'm', expires_at: new Date(now + 1000) } },
                cases: [{ case_code: 'w', type: 'warn', status: 'active', created_at: new Date(), reason: 'r' }],
                appeals: [{ case_code: 'w', status: 'pending', type: 'warn', created_at: new Date() }],
            }),
        }),
        recordPage({ ...ctx, supportInvite: null }, { session, view: buildRecordView({ standing: { warns: [] }, cases: [], appeals: [] }) }),
    ].map(String);
    for (const page of out) {
        assert.ok(!/\{[a-zA-Z]+\}/.test(page), 'no unfilled {param}');
        assert.ok(!page.includes('i18n:'), 'no i18n error text');
    }
    assert.match(out[0], /<h1>Create a Mewvo account<\/h1>/);
    assert.match(out[11], /Link #3: 6 months of Pro, added <time/);
    assert.match(out[16], /Ban <code>b<\/code>: permanent/);
    assert.match(out[16], /<a href="https:\/\/discord\.gg\/abc" rel="noopener">join the support server<\/a>/);
    assert.equal(pages.daysLeftText(now + 86400000 * 1.5, now), '1 day left');
    assert.equal(pages.daysLeftText(now + 86400000 * 3.5, now), '3 days left');
    assert.match(bonusText({ kind: 'new', linkNumber: 7, proNote: 'No store.' }), /^You are number 7 .*could not be added: No store\.$/);
});
