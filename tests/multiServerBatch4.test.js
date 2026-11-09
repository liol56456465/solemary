// Multi-server B0b, batch 4 (docs/multi-server-b0.md): support invite / appeals home in the
// punishment DMs, the OAuth verification redirect, rules, the verification quiz rules hint and
// the server cat read the case's / verifying server. A non-home server never gets Mewvo's main
// invite, Mewvo's rules or the /rules page of the main server; the home servers are unchanged.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID = '100000000000000001';
process.env.SUPPORT_GUILD_ID = '100000000000000002';

const MAIN = process.env.MAIN_GUILD_ID;
const SUPPORT = process.env.SUPPORT_GUILD_ID;
const OTHER = '100000000000000777';
const OWN_INVITE = 'https://discord.gg/ourOwn42';
const MAIN_INVITE = 'https://discord.gg/WyceK9YENP';

const { enforcementConfig } = await import('../src/config/enforcement.js');
const {
    SettingsUnavailableError, resetSettingsCacheForTests, setSettingsCacheForTests,
} = await import('../src/services/settings/guildSettings.js');
const { validateSetting } = await import('../src/services/settings/settingsRegistry.js');
const {
    appealAcceptedDm, appealDeniedDm, appealInvite, banDm, banEndedDm, kickDm, muteDm, warnDm,
} = await import('../src/services/enforcement/dmTemplates.js');
const { successRedirectFor } = await import('../src/services/oauthVerification.js');
const { readServerRules, ruleForReason, ruleLineFor } = await import('../src/services/rules/serverRules.js');
const { rulesLocation } = await import('../src/services/verificationQuiz.js');
const { catSettings } = await import('../src/services/community/catService.js');
const { supportInviteUrl } = await import('../src/commands/Core/support.js');

const savedPublicUrl = process.env.PUBLIC_URL;
afterEach(() => {
    resetSettingsCacheForTests();
    if (savedPublicUrl === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = savedPublicUrl;
});

const MEWVO_SUPPORT = () => enforcementConfig.supportServerInvite;

const caseOf = (guildId, extra = {}) => ({
    guild_id: guildId, case_code: 'abc2345', moderator_username: 'mod', reason: 'Spam', reason_key: 'spam',
    prebuilt_or_custom: 'prebuilt', created_at: new Date('2026-10-28T10:00:00Z'),
    expires_at: new Date('2026-11-04T10:00:00Z'), duration_ms: 7 * 86400000, ...extra,
});

const punishmentDms = (rec) => ({
    ban: banDm(rec), kick: kickDm(rec, null), mute: muteDm(rec), warn: warnDm(rec, 1),
});

// ── Registry ──────────────────────────────────────────────────────────────

test('registry: appealsHome is mewvo | own; appealsInvite is a discord invite or null', () => {
    assert.equal(validateSetting('appealsHome', 'mewvo').ok, true);
    assert.equal(validateSetting('appealsHome', 'own').ok, true);
    assert.equal(validateSetting('appealsHome', 'elsewhere').ok, false);
    assert.equal(validateSetting('appealsInvite', OWN_INVITE).ok, true);
    assert.equal(validateSetting('appealsInvite', 'https://discord.com/invite/abc-1').ok, true);
    assert.equal(validateSetting('appealsInvite', null).ok, true);
    assert.equal(validateSetting('appealsInvite', 'https://evil.example/x').ok, false);
    assert.equal(validateSetting('appealsInvite', 'javascript:alert(1)').ok, false);
});

// ── Punishment DMs: the appeal invite ─────────────────────────────────────

test('DM invite, home servers: Mewvo\'s Support invite whatever appealsHome says (unchanged)', () => {
    setSettingsCacheForTests(MAIN, { appealsHome: 'own', appealsInvite: OWN_INVITE });
    for (const guildId of [MAIN, SUPPORT, null]) {
        assert.equal(appealInvite(guildId), MEWVO_SUPPORT(), String(guildId));
        for (const [name, dm] of Object.entries(punishmentDms(caseOf(guildId)))) {
            assert.ok(dm.includes(`**Appeal here:** ${MEWVO_SUPPORT()}`), `${guildId} ${name}`);
            assert.ok(!dm.includes(OWN_INVITE), `${guildId} ${name}`);
        }
    }
    assert.ok(appealDeniedDm().includes(MEWVO_SUPPORT()), 'no server named: as before');
});

test('DM invite, other server that explicitly chose appealsHome mewvo: Mewvo\'s Support invite (kept after D2)', () => {
    for (const row of [{ appealsHome: 'mewvo' }, { appealsHome: 'mewvo', appealsInvite: OWN_INVITE }]) {
        setSettingsCacheForTests(OTHER, row);
        assert.equal(appealInvite(OTHER), MEWVO_SUPPORT(), JSON.stringify(row));
        for (const [name, dm] of Object.entries(punishmentDms(caseOf(OTHER)))) {
            assert.ok(dm.includes(`**Appeal here:** ${MEWVO_SUPPORT()}`), name);
            assert.ok(!dm.includes(OWN_INVITE), name);
        }
        assert.ok(appealDeniedDm({ guildId: OTHER }).includes(MEWVO_SUPPORT()));
        // Mewvo's Support cannot invite anyone back into another server: no invite named for a rejoin.
        const ended = banEndedDm(caseOf(OTHER), null);
        assert.ok(!ended.includes('discord.gg') && ended.includes('Rejoin: ask a staff member for an invite'), ended);
    }
    assert.ok(banEndedDm(caseOf(MAIN), null).includes(MEWVO_SUPPORT()), 'home ban-ended DM unchanged');
});

test('DM invite, other server with appealsHome own and an invite: its own invite, never Mewvo\'s', () => {
    setSettingsCacheForTests(OTHER, { appealsHome: 'own', appealsInvite: OWN_INVITE });
    assert.equal(appealInvite(OTHER), OWN_INVITE);
    for (const [name, dm] of Object.entries(punishmentDms(caseOf(OTHER)))) {
        assert.ok(dm.includes(`**Appeal here:** ${OWN_INVITE}`), name);
        assert.ok(!dm.includes(MEWVO_SUPPORT()) && !dm.includes(MAIN_INVITE), name);
    }
    assert.ok(appealDeniedDm({ guildId: OTHER }).includes(OWN_INVITE));
    assert.ok(banEndedDm(caseOf(OTHER), null).includes(OWN_INVITE), 'ban ended without a rejoin invite');
    assert.ok(appealDeniedDm({ guildId: OTHER, lang: 'de' }).includes(OWN_INVITE), 'translated DM keeps the guild');
});

test('D2: another server that never chose (no row value) appeals in its own server: no Mewvo Support invite', () => {
    setSettingsCacheForTests(OTHER, {});
    assert.equal(appealInvite(OTHER), null);
    for (const [name, dm] of Object.entries(punishmentDms(caseOf(OTHER, { guild_name: 'Cosy Cats' })))) {
        assert.ok(!dm.includes(MEWVO_SUPPORT()) && !dm.includes('discord.gg'), name);
        assert.ok(dm.startsWith('**To appeal:** contact the staff of Cosy Cats.'), `${name}: ${dm}`);
    }
    setSettingsCacheForTests(OTHER, { appealsInvite: OWN_INVITE });
    assert.equal(appealInvite(OTHER), OWN_INVITE, 'the default is own: its invite is used');
});

test('DM invite, other server with appealsHome own but no invite: no invite line, "contact the staff" instead', () => {
    setSettingsCacheForTests(OTHER, { appealsHome: 'own' });
    assert.equal(appealInvite(OTHER), null);
    for (const [name, dm] of Object.entries(punishmentDms(caseOf(OTHER)))) {
        assert.ok(!dm.includes('Appeal here'), name);
        assert.ok(!dm.includes('discord.gg'), `${name} names no invite`);
        assert.ok(dm.includes('Case code: abc2345'), `${name} still renders`);
        assert.ok(dm.includes('**To appeal:** contact the staff of the server.'), `${name}: the honest path`);
    }
    // The member portal on: the web appeal page replaces the "contact the staff" line.
    const savedPortal = process.env.MEMBER_PORTAL_ENABLED;
    process.env.MEMBER_PORTAL_ENABLED = 'true';
    process.env.PUBLIC_URL = 'https://mewvo.example';
    try {
        const web = muteDm(caseOf(OTHER));
        assert.ok(web.includes('<https://mewvo.example/me/appeal/abc2345>') && !web.includes('To appeal:'), web);
    } finally {
        if (savedPortal === undefined) delete process.env.MEMBER_PORTAL_ENABLED; else process.env.MEMBER_PORTAL_ENABLED = savedPortal;
    }
    const unappealable = banDm(caseOf(OTHER, { unappealable: true }));
    assert.ok(unappealable.includes('This ban cannot be appealed.') && !unappealable.includes('To appeal:'));
    for (const lang of ['de', 'ru', 'pt-BR']) {
        const dm = muteDm(caseOf(OTHER), { lang });
        assert.ok(!dm.includes('{') && !dm.includes('To appeal:'), `${lang}: translated`);
    }
    assert.ok(!banDm(caseOf(MAIN)).includes('To appeal:'), 'home DMs unchanged');
    const auto = banDm(caseOf(OTHER, { is_auto: true, ladder_level_after: 3, appeal_deadline: new Date('2027-05-01T00:00:00Z') }));
    assert.ok(!auto.includes('Appealing this code') && !auto.includes('You can appeal until'), 'no appeal promise without a place to appeal');
    const autoHome = banDm(caseOf(MAIN, { is_auto: true, ladder_level_after: 3, appeal_deadline: new Date('2027-05-01T00:00:00Z') }));
    assert.ok(autoHome.includes('Appealing this code') && autoHome.includes('You can appeal until'), 'home unchanged');
    const denied = appealDeniedDm({ guildId: OTHER });
    assert.ok(denied.startsWith('**Appeal denied.**') && !denied.includes('discord.gg') && !denied.includes('undefined'), denied);
    const ended = banEndedDm(caseOf(OTHER), null);
    assert.ok(!ended.includes('discord.gg') && ended.includes('Rejoin: ask a staff member for an invite'), ended);
    for (const lang of ['de', 'ru', 'pt-BR']) {
        const dm = appealDeniedDm({ guildId: OTHER, lang });
        assert.ok(!dm.includes('discord.gg') && !dm.includes('{'), `${lang}: ${dm}`);
    }
});

test('DM invite, other server whose settings were never read (database down at boot): no line, the DM still renders', () => {
    // No row and the table never loaded: resolveSetting throws for OTHER; the DM must not.
    assert.throws(() => catSettings(OTHER), SettingsUnavailableError);
    assert.equal(appealInvite(OTHER), null);
    const dm = muteDm(caseOf(OTHER));
    assert.ok(dm.includes('Case code: abc2345') && !dm.includes('discord.gg'), dm);
});

test('appeal accepted DM: another server names itself and the case; without an invite never Mewvo Support', () => {
    const named = (extra = {}) => ({ rec: caseOf(OTHER), guildId: OTHER, serverName: 'Cat Café', ...extra });
    // appealsHome mewvo (default): no invite named at all; ask that server's staff.
    for (const row of [{}, { appealsHome: 'mewvo', appealsInvite: OWN_INVITE }]) {
        setSettingsCacheForTests(OTHER, row);
        const dm = appealAcceptedDm('Admin', null, named());
        assert.ok(dm.includes('**Appeal accepted in Cat Café**'), dm);
        assert.ok(dm.includes('Case code: abc2345'), dm);
        assert.ok(dm.includes('Rejoin: ask a staff member for an invite'), dm);
        assert.ok(!dm.includes('support server') && !dm.includes(MEWVO_SUPPORT()) && !dm.includes('discord.gg'), dm);
    }
    // Its own invite when it set one.
    setSettingsCacheForTests(OTHER, { appealsHome: 'own', appealsInvite: OWN_INVITE });
    const own = appealAcceptedDm('Admin', null, named());
    assert.ok(own.includes(OWN_INVITE) && !own.includes(MEWVO_SUPPORT()), own);
    // A fresh rejoin invite always wins.
    const fresh = appealAcceptedDm('Admin', 'https://discord.gg/fresh1', named());
    assert.ok(fresh.includes('Rejoin: https://discord.gg/fresh1') && !fresh.includes(OWN_INVITE), fresh);
    // Translated: same rule, placeholders filled.
    setSettingsCacheForTests(OTHER, {});
    for (const lang of ['de', 'es', 'fr', 'it', 'pl', 'pt-BR', 'ru']) {
        const dm = appealAcceptedDm('Admin', null, named({ lang }));
        assert.ok(dm.includes('Cat Café') && dm.includes('abc2345') && !dm.includes('{') && !dm.includes('discord.gg'), `${lang}: ${dm}`);
    }
    // Home servers (and no case named): unchanged.
    const home = appealAcceptedDm('Admin', null, { rec: caseOf(MAIN), guildId: MAIN });
    assert.equal(home, appealAcceptedDm('Admin', null));
    assert.ok(home.startsWith('**Appeal accepted**\n') && home.includes('support server'), home);
});

// ── OAuth verification redirect (the leak at oauthVerification.js:32 / :244) ─

test('OAuth redirect: home servers keep VERIFY_SUCCESS_REDIRECT / the main invite', () => {
    assert.equal(successRedirectFor(MAIN, { ...process.env, VERIFY_SUCCESS_REDIRECT: 'https://example.com/ok' }), 'https://example.com/ok');
    assert.equal(successRedirectFor(MAIN, { ...process.env, VERIFY_SUCCESS_REDIRECT: '' }), MAIN_INVITE);
    assert.equal(successRedirectFor(SUPPORT, { ...process.env, VERIFY_SUCCESS_REDIRECT: '' }), MAIN_INVITE);
});

test('OAuth redirect: another server never goes to Mewvo\'s main invite (or the env value)', () => {
    const env = { ...process.env, VERIFY_SUCCESS_REDIRECT: 'https://example.com/mewvo-only' };
    setSettingsCacheForTests(OTHER, {});
    assert.equal(successRedirectFor(OTHER, env), null, 'nothing stored: the "You are verified" page');
    setSettingsCacheForTests(OTHER, { verifySuccessRedirect: 'https://their.example/welcome' });
    assert.equal(successRedirectFor(OTHER, env), 'https://their.example/welcome');
    resetSettingsCacheForTests();
    assert.throws(() => successRedirectFor(OTHER, env), SettingsUnavailableError, 'unreadable: an error, never the main invite');
});

// ── Rules ─────────────────────────────────────────────────────────────────

const MAIN_RULES = { rules: [{ id: 'aaaa1111', title: 'Mewvo rule', text: '' }], updatedAt: null };
const OTHER_RULES = { rules: [{ id: 'bbbb2222', title: 'Be nice', text: '' }, { id: 'cccc3333', title: 'No spam here', text: '' }], updatedAt: null };

test('rules: another server reads its own rules and links; never the main server\'s; no /rules page link', () => {
    process.env.PUBLIC_URL = 'https://mewvo.example';
    setSettingsCacheForTests(MAIN, { serverRules: MAIN_RULES, reasonRuleLinks: { spam: 'aaaa1111' } });
    setSettingsCacheForTests(OTHER, { serverRules: OTHER_RULES, reasonRuleLinks: { spam: 'cccc3333' } });
    assert.equal(readServerRules(process.env, OTHER).rules.length, 2);
    assert.deepEqual(ruleForReason('spam', process.env, OTHER), { id: 'cccc3333', number: 2, title: 'No spam here', consequence: '' });
    assert.equal(ruleLineFor(caseOf(OTHER)), 'Rule 2: No spam here', 'own rule, no link to Mewvo\'s /rules page');
    assert.ok(banDm(caseOf(OTHER)).includes('\nRule 2: No spam here\n'));
    // Home: unchanged (main rules, with the page link).
    assert.equal(ruleLineFor(caseOf(MAIN)), 'Rule 1: Mewvo rule, <https://mewvo.example/rules#rule-1>');
    assert.equal(ruleLineFor(caseOf(undefined)), 'Rule 1: Mewvo rule, <https://mewvo.example/rules#rule-1>');
    // A server without rules gets no line (not the main server's).
    setSettingsCacheForTests(OTHER, {});
    assert.equal(ruleLineFor(caseOf(OTHER)), null);
    resetSettingsCacheForTests();
    assert.equal(ruleLineFor(caseOf(OTHER)), null, 'unreadable: the DM goes out without the line');
});

test('verification quiz: another server names its posted rules channel, else plain words (never Mewvo\'s /rules page)', () => {
    process.env.PUBLIC_URL = 'https://mewvo.example';
    const posted = { channelId: '300000000000000001', messageIds: ['300000000000000002'], at: '2026-11-01T00:00:00.000Z' };
    setSettingsCacheForTests(MAIN, { serverRules: MAIN_RULES });
    assert.equal(rulesLocation({ id: MAIN }), '<https://mewvo.example/rules>', 'home unchanged');
    setSettingsCacheForTests(OTHER, { serverRules: OTHER_RULES });
    assert.equal(rulesLocation({ id: OTHER }), 'the rules channel');
    setSettingsCacheForTests(OTHER, { serverRules: OTHER_RULES, rulesPost: { channelId: null, title: 'R', colour: null, intro: '', footer: '', layout: 'list', banner: null, thumbnail: null, posted } });
    assert.equal(rulesLocation({ id: OTHER }), '<#300000000000000001>');
    resetSettingsCacheForTests();
    assert.equal(rulesLocation({ id: OTHER }), 'the rules channel', 'unreadable: plain words');
});

// ── Server cat, /support ──────────────────────────────────────────────────

test('server cat: another server\'s own name and switch; unreadable settings throw', () => {
    setSettingsCacheForTests(MAIN, { catName: 'Mewvo cat', catAnnounce: false });
    setSettingsCacheForTests(OTHER, { catName: 'Mochi' });
    assert.deepEqual(catSettings(OTHER), { name: 'Mochi', announce: true });
    assert.deepEqual(catSettings(MAIN), { name: 'Mewvo cat', announce: false });
});

test('/support stays Mewvo\'s Support server (the bot\'s help server)', () => {
    assert.equal(supportInviteUrl(), MEWVO_SUPPORT());
});
