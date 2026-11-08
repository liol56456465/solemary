// Website text of Mewvo accounts and "My record" (account.json, portal.json): every key the pages
// read exists in English, no catalog key is left unused, and every page renders from the catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCatalogs } from '../src/services/site/i18n.js';
import * as pages from '../src/services/site/accountPages.js';
import { bonusText } from '../src/services/site/accountRoutes.js';
import { appealInfo, buildRecordGroups, loginPage, recordPage } from '../src/services/site/memberPortal.js';
import { appealExpiredPage, appealFormPage, appealsPage, buildAppealsView, caseItem } from '../src/services/site/portalAppeals.js';
import { enforcementConfig } from '../src/config/enforcement.js';
import { setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';

// The web appeal fixtures' server ('9'): an empty settings row, so its appeal settings are the defaults.
setSettingsCacheForTests('9', {});

const FILES = ['accountPages.js', 'accountRoutes.js', 'memberPortal.js', 'portalAppeals.js'].map((f) => readFileSync(new URL(`../src/services/site/${f}`, import.meta.url), 'utf8'));
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
    'portal.record.column.': ['case', 'type', 'reason', 'by', 'date', 'ends', 'status', 'appeal', 'filed', 'decided', 'server'],
    // accountErrorText: codes from accountCore validation and AccountError (snake_case → camelCase).
    'account.errorCodes.': ['usernameLength', 'usernameChars', 'usernameNoLetter', 'usernameReserved', 'passwordShort', 'passwordLong', 'birthMissing',
        'birthInvalid', 'tooYoung', 'usernameTaken', 'twoStepOn', 'noDiscordUser', 'missing', 'hasOther', 'linkedElsewhere', 'linkFirst', 'notEligible',
        'allClaimed', 'letterTaken'],
    // caseStatusCode (caseService.js) shown as portal.status.case.<code>.
    'portal.status.case.': ['liftedByAppeal', 'reversed', 'lifted', 'appealPending', 'expired', 'activeAppealDenied', 'active'],
    'portal.duration.': ['month', 'day', 'hour', 'minute', 'lessThanMinute'],
    // Web appeals (portalAppeals.js).
    'portal.appeals.column.': ['server', 'case', 'reason', 'type', 'date', 'until', 'action', 'status', 'filed', 'decided'],
    'portal.appealForm.facts.': ['server', 'case', 'type', 'reason', 'date', 'ends'],
    'portal.appealForm.didIt.': ['yes', 'partly', 'no'],
};
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

function usedKeys() {
    const keys = new Set([...SOURCE.matchAll(/\bt[ib]?\(\s*'((?:account|portal)\.[a-zA-Z.]+)'/g)].map((m) => m[1]));
    // t(cond ? 'a' : 'b')
    for (const m of SOURCE.matchAll(/'((?:account|portal)\.[a-zA-Z]+\.[a-zA-Z.]+)'/g)) keys.add(m[1]);
    for (const [prefix, ends] of Object.entries(DYNAMIC)) for (const end of ends) keys.add(prefix + end);
    // A plural key (tp/tpi) is stored as <key>.one / .other …: the code names the base.
    for (const key of [...keys]) {
        if (!english.has(key) && english.has(`${key}.other`)) {
            keys.delete(key);
            for (const form of PLURAL_FORMS) if (english.has(`${key}.${form}`)) keys.add(`${key}.${form}`);
        }
    }
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
            record: buildRecordGroups({
                standings: new Map([['9', { ladder: { level: 0, warns_since_level: 1 }, warns: [], activeBan: { case_code: 'b', expires_at: null }, activeMute: { case_code: 'm', expires_at: new Date(now + 1000) } }]]),
                cases: [{ case_code: 'w', guild_id: '9', type: 'warn', status: 'active', created_at: new Date(), reason: 'r' }],
                appeals: [{ case_code: 'w', status: 'pending', type: 'warn', created_at: new Date() }],
                config: enforcementConfig,
            }),
        }),
        recordPage({ ...ctx, supportInvite: null }, { session, record: buildRecordGroups({ cases: [], appeals: [], config: enforcementConfig }) }),
        // Web appeals: the list (full and empty), the form, a case that cannot be appealed now.
        appealsPage({ ...ctx, webAppeals: true }, {
            session,
            sent: { code: 'w2222', server: 'S' },
            view: buildAppealsView({
                userId: '2', appealInfo,
                cases: [{ case_code: 'w2222', guild_id: '9', target_user_id: '2', type: 'warn', status: 'active', created_at: new Date(), reason: 'r' }],
                appeals: [{ case_code: 'w2222', status: 'pending', claimed_at: new Date(), type: 'warn', created_at: new Date() }],
            }),
        }),
        appealsPage(ctx, { session, view: { appealable: [], appeals: [] } }),
        appealFormPage(ctx, { session, item: caseItem({ case_code: 'b2222', guild_id: '9', type: 'ban', status: 'active', created_at: new Date(), reason: 'r', expires_at: null }, { appealInfo }), error: 'e', field: 'reason' }),
        appealFormPage(ctx, { session, item: caseItem({ case_code: 'b3333', guild_id: '9', type: 'ban', status: 'active', created_at: new Date(), reason: 'r', expires_at: null, unappealable: true }, { appealInfo }) }),
        loginPage(ctx, { next: '/me/appeal/b2222' }),
        recordPage({ ...ctx, webAppeals: true }, { session, record: buildRecordGroups({ cases: [{ case_code: 'w', guild_id: '9', type: 'warn', status: 'active', created_at: new Date(), reason: 'r' }], appeals: [], config: enforcementConfig }) }),
        // The login ran out while typing: the answers come back with a login link (portalAppeals.js).
        appealExpiredPage(ctx, { code: 'b2222', values: { punished: 'p', reason: 'r', didIt: 'partly' } }),
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
