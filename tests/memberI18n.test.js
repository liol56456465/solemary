// Audit 4.3 + 4.6: the member flows in all 8 languages (appeal form, My record, My appeals, the
// appeal channel texts, modmail, "Contest this", keep-apart DMs) with customIds unchanged and
// English as before; and the personal language (/language without a role, the website): the
// resolution order, the fallback when it cannot be read, /language saving it, the DM log and
// re-edit, the data export and the privacy page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText, resolveBotLanguage, textForInteraction } from '../src/utils/botText.js';
import { logger } from '../src/utils/logger.js';
import {
    clearPersonalLanguage, loadPersonalLanguages, personalLanguageKey, personalLanguageOf, personalLanguagesLoaded,
    readPersonalLanguage, setPersonalLanguage, setPersonalLanguagesForTests,
} from '../src/services/personalLanguage.js';
import { appealModal, myAppealsText, reportModal, wrongPlaceMessage } from '../src/handlers/appealsHandler.js';
import { standingFields } from '../src/services/enforcement/standingService.js';
import { memberAppealSummary, memberDecisionEmbed } from '../src/services/enforcement/appealService.js';
import { MODMAIL_BLOCKED, NO_MODMAIL_SERVER, modmailPromptPayload, staffHeader, staffLabel } from '../src/services/modmailService.js';
import { contestModal, contestRefusal } from '../src/handlers/automodContest.js';
import { checkContestTarget } from '../src/services/automod/automodContest.js';
import { contestComponents, noContactEndedDm, noContactStartedDm } from '../src/services/enforcement/dmTemplates.js';
import { applyLanguageChoice } from '../src/handlers/languageRoles.js';
import { sendLoggedDm } from '../src/services/botDm/dmLog.js';
import { createDmRelang, schedulePersonalRelang } from '../src/services/botDm/dmRelang.js';
import { buildDataExport } from '../src/services/privacy/dataExport.js';
import { privacyPage } from '../src/services/site/pages/legal.js';

const OTHERS = LANG_CODES.filter((c) => c !== 'en');
const USER = '300000000000000001';
const GUILD = '100000000000000777';
const ZETA = { id: '100000000000000888', name: 'Zeta' };
const mod = (row) => row.toJSON ? row.toJSON() : row;

// ── 4.3: every flow in every language ───────────────────────────────────

const standing = {
    ladder: { level: 0, warns_since_level: 1 },
    warns: [{ case_code: 'k7m2qx', reason: 'spam', created_at: new Date(0) }],
    activeBan: null,
    activeMute: { case_code: 'mu7e2x', expires_at: new Date(86400000) },
    appeals: [{ case_code: 'k7m2qx', type: 'warn', status: 'pending', created_at: new Date(0), decided_at: null }],
};
const appeals = [{ case_code: 'k7m2qx', type: 'ban', name: 'Spam', status: 'denied', created_at: new Date(0), decided_at: new Date(86400000) }];
const record = { case_code: 'k7m2qx', type: 'ban', created_at: new Date(0), reason: 'Spam', expires_at: null, guild_id: ZETA.id };
const order = { guild_id: ZETA.id, until: new Date(86400000), reason: 'Arguing' };
const other = { username: 'otto' };

/** Every member-facing text of the flows, as strings, in one language. */
function flowTexts(lang) {
    const tr = botText(lang);
    const appeal = mod(appealModal(tr));
    const report = mod(reportModal(tr));
    const contest = mod(contestModal('k7m2qx', tr));
    const labels = (m) => m.components.flatMap((c) => [c.label, c.description].filter(Boolean));
    const one = modmailPromptPayload([ZETA], '400000000000000001', { lang });
    const several = modmailPromptPayload([ZETA, { id: '100000000000000999', name: 'Alpha' }], '400000000000000001', { lang });
    return {
        appealTitle: appeal.title, appealLabels: labels(appeal).join('|'),
        reportTitle: report.title, reportLabels: labels(report).join('|'),
        wrongPlace: wrongPlaceMessage(null, 'open', tr),
        myAppeals: myAppealsText(appeals, { lang }), noAppeals: myAppealsText([], { lang }),
        record: standingFields(standing, { lang }).map((f) => `${f.name}: ${f.value}`).join('\n'),
        summary: JSON.stringify(memberAppealSummary(record, { reason: 'please' }, { lang }).toJSON()),
        decision: JSON.stringify(memberDecisionEmbed({ caseCode: 'k7m2qx', decision: 'accept', dmDelivered: false, seconds: 30 }, { lang }).toJSON()),
        promptOne: one.content, promptButtons: one.components[0].toJSON().components.map((b) => b.label).join('|'),
        promptSeveral: several.content, placeholder: several.components[0].toJSON().components[0].placeholder,
        none: modmailPromptPayload([], '400000000000000001', { lang }).content,
        staff: staffHeader('Ann', lang) + staffLabel(ZETA, tr),
        contestTitle: contest.title, contestLabels: labels(contest).join('|'),
        contestButton: contestComponents('k7m2qx', { lang })[0].toJSON().components[0].label,
        contestRefusal: contestRefusal(checkContestTarget(null, USER), tr),
        keepApartStart: noContactStartedDm(order, other, { serverName: 'Zeta', lang }),
        keepApartEnd: noContactEndedDm(order, null, { early: true, serverName: 'Zeta', lang }),
    };
}

test('4.3: every member flow is translated in all 7 other languages (no English left)', () => {
    const en = flowTexts('en');
    for (const lang of OTHERS) {
        const texts = flowTexts(lang);
        for (const [name, text] of Object.entries(texts)) {
            assert.ok(typeof text === 'string' && text.length, `${lang} ${name}`);
            assert.notEqual(text, en[name], `${lang}: ${name} is still English`);
        }
    }
});

test('4.3: customIds are the same in every language (posted buttons keep working); Discord limits hold', () => {
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        const appeal = mod(appealModal(tr));
        assert.equal(appeal.custom_id, 'appealmodal:submit');
        assert.deepEqual(appeal.components.map((c) => c.component.custom_id), ['reason', 'code', 'moreinfo']);
        const report = mod(reportModal(tr));
        assert.equal(report.custom_id, 'appealmodal:report');
        assert.deepEqual(report.components.map((c) => c.component.custom_id), ['staff', 'details', 'proof']);
        const contest = mod(contestModal('k7m2qx', tr));
        assert.equal(contest.custom_id, 'amcontest:submit:k7m2qx');
        for (const m of [appeal, report, contest]) {
            assert.ok(m.title.length <= 45, `${lang} modal title`);
            for (const c of m.components) {
                assert.ok(c.label.length <= 45, `${lang} label ${c.label}`);
                if (c.description) assert.ok(c.description.length <= 100, `${lang} description`);
            }
        }
        assert.equal(contestComponents('k7m2qx', { lang })[0].toJSON().components[0].custom_id, 'amcontest:open:k7m2qx');
        const one = modmailPromptPayload([ZETA], '400000000000000001', { lang });
        assert.deepEqual(one.components[0].toJSON().components.map((b) => b.custom_id), [`modmail_open:400000000000000001:${ZETA.id}`, 'modmail_cancel']);
        assert.deepEqual(one.allowedMentions, { parse: [] });
        const several = modmailPromptPayload([ZETA, { id: '100000000000000999', name: 'Alpha' }], '400000000000000001', { lang });
        assert.equal(several.components[0].toJSON().components[0].custom_id, 'modmail_pick:400000000000000001');
        for (const field of standingFields(standing, { lang })) assert.ok(field.value.length <= 1024 && field.name.length <= 256, lang);
        for (const text of [noContactStartedDm(order, other, { serverName: 'Zeta', lang })]) assert.ok(text.length <= 2000, lang);
    }
});

test('4.3: English is the text as before', () => {
    const tr = botText('en');
    const appeal = mod(appealModal());
    assert.equal(appeal.title, 'Appeal a punishment');
    assert.deepEqual(appeal.components.map((c) => c.label), ['Why should it be lifted?', 'Case code', 'More info (optional)']);
    assert.equal(mod(reportModal()).title, 'Report a staff member');
    assert.equal(mod(contestModal('k7m2qx')).title, 'Contest this decision');
    assert.equal(contestComponents('k7m2qx')[0].toJSON().components[0].label, 'Contest this');
    assert.equal(myAppealsText(appeals), '**`k7m2qx`**: ban (Spam)\nDenied · filed <t:0:d> · decided <t:86400:d>');
    const fields = standingFields(standing);
    assert.deepEqual(fields.map((f) => f.name), ['Counted warnings', 'Warning ladder', 'Active punishments', 'Appeals']);
    assert.match(fields[0].value, /^\*\*1\*\* counted \(limit at this stage: 3\)\./);
    assert.equal(fields[2].value, 'Mute `mu7e2x` · ends <t:86400:d> (<t:86400:R>)');
    assert.equal(fields[3].value, '`k7m2qx` warn · ⏳ pending · filed <t:0:d>');
    assert.equal(memberDecisionEmbed({ caseCode: 'k7m2qx', decision: 'deny', dmDelivered: false, seconds: 30 }).toJSON().description,
        'Your appeal for `k7m2qx` was denied. You will not get the details by DM (your DMs are closed).\n\n-# This channel is deleted in 30 seconds.');
    assert.equal(memberDecisionEmbed({ caseCode: 'k7m2qx', decision: 'accept', dmDelivered: true, seconds: 30 }).toJSON().title, 'Appeal accepted');
    assert.match(modmailPromptPayload([ZETA], '1').content, /^Do you want to send this message to the staff of Zeta\? They will reply here in DMs\./);
    assert.equal(modmailPromptPayload([], '1').content, NO_MODMAIL_SERVER);
    assert.equal(modmailPromptPayload([], '1', { blockedSomewhere: true }).content, MODMAIL_BLOCKED);
    assert.equal(staffLabel(null), 'the Mewvo staff');
    assert.equal(staffHeader('Ann'), '**Ann (staff):**');
    assert.equal(wrongPlaceMessage('main', 'report'), 'Staff reports are filed from the panel in the Mewvo support server.');
    assert.equal(contestRefusal({ code: 'notYours', message: 'x' }, tr), 'Only the member this decision was about can contest it.');
    const start = noContactStartedDm(order, other, { serverName: 'Zeta' }).split('\n');
    assert.deepEqual(start.slice(0, 5), [
        '**Keep apart: an order in Zeta**',
        'Staff have asked you and **otto** not to contact each other until <t:86400:F> (<t:86400:R>).',
        'Until then, do not mention or reply to them in the server: those messages are removed.',
        'Reason: Arguing',
        'This is not a punishment and does not count as a warning.',
    ]);
    assert.equal(noContactEndedDm(order, null, { early: false, serverName: 'Zeta' }).split('\n')[1], 'It expired. You may contact the other member again.');
});

// ── 4.6: the personal language ─────────────────────────────────────────

test('4.6 order: language role > personal language > Discord locale (private answers) / server language (DMs); public never', () => {
    const roles = { languageRoles: { de: '700000000000000003' }, botLanguage: 'pl' };
    const resolve = (guildId, key) => roles[key];
    const personal = (id) => (id === USER ? 'it' : null);
    const withRole = { id: USER, roles: { cache: new Map([['700000000000000003', {}]]) } };
    const noRole = { id: USER, roles: { cache: new Map() } };
    assert.equal(resolveBotLanguage({ guildId: GUILD, member: withRole, purpose: 'dm', resolve, personal }), 'de', 'a role first');
    assert.equal(resolveBotLanguage({ guildId: GUILD, member: noRole, purpose: 'dm', resolve, personal }), 'it', 'then the personal language');
    assert.equal(resolveBotLanguage({ guildId: GUILD, userId: USER, purpose: 'dm', resolve, personal }), 'it', 'by user id without a member');
    assert.equal(resolveBotLanguage({ guildId: GUILD, userId: '399999999999999999', purpose: 'dm', resolve, personal }), 'pl', 'none: the server language');
    const interaction = { locale: 'fr', guildId: GUILD, member: noRole, user: { id: USER } };
    assert.equal(resolveBotLanguage({ interaction, purpose: 'reply', resolve, personal }), 'it', 'before the Discord locale');
    assert.equal(resolveBotLanguage({ interaction: { ...interaction, _isPrefixCommand: true }, purpose: 'reply', resolve, personal }), 'pl', 'a prefix answer is a channel post');
    assert.equal(resolveBotLanguage({ guildId: GUILD, member: noRole, purpose: 'member', resolve, personal }), 'pl', "a channel post for one member keeps the server's");
    assert.equal(resolveBotLanguage({ guildId: GUILD, member: noRole, purpose: 'public', resolve, personal }), 'pl');
    assert.equal(resolveBotLanguage({ guildId: null, userId: USER, purpose: 'dm', personal }), 'it', 'a DM without a server (modmail prompt)');
    assert.equal(resolveBotLanguage({ guildId: GUILD, userId: USER, purpose: 'dm', resolve, personal: () => { throw new Error('boom'); } }), 'pl', 'a broken lookup never stops a DM');
    assert.equal(resolveBotLanguage({ guildId: GUILD, userId: USER, purpose: 'dm', resolve, personal: () => 'xx' }), 'pl', 'an unknown code is ignored');
});

test('4.6 store: loaded at startup, written through; a DB error on load falls back to the server language with one warning and a later retry', async () => {
    const kv = new Map([[personalLanguageKey(USER), 'de'], ['user:300000000000000002:lang', 'xx'], ['user:300000000000000003:other', 'ru']]);
    const fake = {
        list: async (prefix) => [...kv.keys()].filter((k) => k.startsWith(prefix)),
        get: async (k) => kv.get(k) ?? null,
        set: async (k, v) => { kv.set(k, v); return true; },
        delete: async (k) => kv.delete(k),
        exists: async (k) => kv.has(k),
    };
    setPersonalLanguagesForTests({}, { loaded: false });
    assert.equal(await loadPersonalLanguages(fake), 1, 'only valid user:<id>:lang values');
    assert.equal(personalLanguagesLoaded(), true);
    assert.equal(personalLanguageOf(USER), 'de');
    assert.equal(personalLanguageOf('300000000000000002'), null);

    await setPersonalLanguage(USER, 'pt-BR', { database: fake });
    assert.equal(kv.get(personalLanguageKey(USER)), 'pt-BR');
    assert.equal(personalLanguageOf(USER), 'pt-BR');
    await assert.rejects(setPersonalLanguage(USER, 'xx', { database: fake }), /unknown language/);
    await assert.rejects(setPersonalLanguage(USER, 'fr', { database: { set: async () => { throw new Error('db down'); } } }), /db down/);
    assert.equal(personalLanguageOf(USER), 'pt-BR', 'a failed write changes nothing');
    await assert.rejects(readPersonalLanguage(USER, { database: { get: async () => { throw new Error('db down'); } } }), /db down/, 'reads throw');
    await clearPersonalLanguage(USER, { database: fake });
    assert.equal(personalLanguageOf(USER), null);
    assert.equal(kv.has(personalLanguageKey(USER)), false);

    // The database is down at startup: lookups give null (server language), warned once, retried later.
    const warnings = [];
    const real = logger.warn;
    logger.warn = (m) => warnings.push(String(m));
    let lists = 0;
    const down = { list: async () => { lists += 1; throw new Error('db down'); }, get: async () => null };
    try {
        setPersonalLanguagesForTests({}, { loaded: false });
        assert.equal(await loadPersonalLanguages(down, { now: 1000 }), null);
        assert.equal(personalLanguageOf(USER, { now: 2000 }), null);
        assert.equal(resolveBotLanguage({ guildId: null, userId: USER, purpose: 'dm' }), 'en');
        assert.equal(lists, 1, 'no retry within a minute');
        personalLanguageOf(USER, { now: 1000 + 61_000 });
        await new Promise((r) => setImmediate(r));
        assert.equal(lists, 2, 'retried after a minute');
        assert.equal(warnings.filter((w) => /Personal languages could not be loaded/.test(w)).length, 1, 'one warning per failing stretch');
    } finally {
        logger.warn = real;
        setPersonalLanguagesForTests();
    }
});

function langInteraction({ member, guild } = {}) {
    return {
        locale: 'en-US', guildId: GUILD, guild: guild ?? { id: GUILD, roles: { cache: new Map() }, members: { me: null } },
        member: member ?? { id: USER, roles: { cache: new Map() } }, user: { id: USER }, client: {},
    };
}

test('4.6 /language: a language without a role here is saved as the personal language ("Saved: …"), no dead end', async () => {
    const saved = [];
    const relang = [];
    const deps = {
        resolve: () => ({}),
        savePersonal: async (id, lang) => { saved.push([id, lang]); },
        clearPersonal: async (id) => { saved.push([id, null]); },
        schedulePersonal: async (client, id, guildId) => { relang.push([id, guildId]); },
    };
    const payload = await applyLanguageChoice(langInteraction(), 'de', deps);
    assert.deepEqual(saved, [[USER, 'de']]);
    assert.deepEqual(relang, [[USER, GUILD]], 'recent DMs are re-edited like after a role change');
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.description, botText('de').t('language.saved', { language: 'Deutsch' }), 'answered in the language just picked');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.match(botText('en').t('language.saved', { language: 'Deutsch' }), /^Saved: Mewvo will DM you in Deutsch/);

    const reset = await applyLanguageChoice(langInteraction(), 'reset', deps);
    assert.deepEqual(saved.at(-1), [USER, null]);
    assert.match(reset.embeds[0].toJSON().description, /^Cleared/);

    const fail = await applyLanguageChoice(langInteraction(), 'fr', { ...deps, savePersonal: async () => { throw new Error('db down'); } });
    assert.match(fail.embeds[0].toJSON().description, /could not be saved/);
    assert.equal(relang.length, 2, 'nothing re-edited after a failed save');

    const unknown = await applyLanguageChoice(langInteraction(), 'xx', deps);
    assert.match(unknown.embeds[0].toJSON().description, /not available/);
});

test('4.6 /language: a personal pick removes the member\'s language roles here (else the role keeps winning); a refusal is said, the choice stays saved', async () => {
    const enRole = { id: '700000000000000001', name: 'English', managed: false, position: 1, permissions: { has: () => false, toArray: () => [] } };
    const removed = [];
    const member = { id: USER, roles: { cache: new Map([[enRole.id, enRole]]), remove: async (ids) => { removed.push(ids); } } };
    const me = { permissions: { has: () => true }, roles: { highest: { position: 10 } } };
    const guild = { id: GUILD, roles: { cache: new Map([[enRole.id, enRole]]) }, members: { me } };
    const deps = { resolve: () => ({ en: enRole.id }), savePersonal: async () => {}, schedulePersonal: async () => {} };
    const ok = await applyLanguageChoice(langInteraction({ member, guild }), 'pl', deps);
    assert.deepEqual(removed, [[enRole.id]]);
    assert.equal(ok.embeds[0].toJSON().description, botText('pl').t('language.saved', { language: 'Polski' }));

    const lowBot = { ...guild, members: { me: { ...me, roles: { highest: { position: 0 } } } } };
    const kept = await applyLanguageChoice(langInteraction({ member, guild: lowBot }), 'pl', deps);
    assert.match(kept.embeds[0].toJSON().description, /\n-# /, 'a second line says the role still applies here');
});

test('4.6 DM log + re-edit: DMs to a member with a personal language are logged; the "Contest this" button follows the DM language', async () => {
    const sent = [];
    const user = { id: USER, send: async (p) => { sent.push(p); return { id: '923456789012345678', channelId: '823456789012345678' }; } };
    const inserted = [];
    const ok = await sendLoggedDm(user, {
        key: 'verification.denied', params: { serverName: 'Cats' }, guildId: GUILD,
        components: (lang) => contestComponents('k7m2qx', { lang }),
    }, {
        insert: async (row) => inserted.push(row), dbAvailable: () => true, hasLanguageRoles: () => false,
        hasPersonal: () => true, resolveLanguage: () => 'ru',
    });
    assert.equal(ok, true);
    assert.equal(inserted.length, 1, 'logged without language roles: the member has a personal language');
    assert.equal(inserted[0].lang, 'ru');
    assert.equal(sent[0].components.at(-1).toJSON().components[0].label, botText('ru').t('member.contest.button'));
    assert.equal(sent[0].components.at(-1).toJSON().components[0].custom_id, 'amcontest:open:k7m2qx');

    const none = [];
    await sendLoggedDm(user, { key: 'verification.denied', params: { serverName: 'Cats' }, guildId: GUILD }, {
        insert: async (row) => none.push(row), dbAvailable: () => true, hasLanguageRoles: () => false, hasPersonal: () => false, resolveLanguage: () => 'en',
    });
    assert.equal(none.length, 0, 'no roles, no personal language: nothing stored (as before)');
});

test('4.6 re-edit: every server with logged DMs plus the current one; a failed log read still re-edits the current one', async () => {
    const scheduled = [];
    const schedule = (client, guildId, userId) => scheduled.push([guildId, userId]);
    assert.equal(await schedulePersonalRelang({}, USER, GUILD, { listGuilds: async () => [GUILD, '100000000000000999'], schedule }), 2);
    assert.deepEqual(scheduled, [[GUILD, USER], ['100000000000000999', USER]]);
    scheduled.length = 0;
    const real = logger.warn;
    logger.warn = () => {};
    try {
        assert.equal(await schedulePersonalRelang({}, USER, GUILD, { listGuilds: async () => { throw new Error('db down'); }, schedule }), 1);
    } finally {
        logger.warn = real;
    }
    assert.deepEqual(scheduled, [[GUILD, USER]]);

    // A member no longer in that server (e.g. banned) with a personal language: their DMs about it still follow.
    const listed = [];
    const relang = createDmRelang({
        listRows: async (args) => { listed.push(args); return []; },
        resolveLanguage: (guildId, member, userId) => (member ? 'de' : userId === USER ? 'it' : 'en'),
        hasPersonal: (id) => id === USER,
    });
    const client = { guilds: { cache: new Map() } };
    const out = await relang.run(client, GUILD, USER, undefined);
    assert.equal(out.lang, 'it');
    assert.equal(listed.length, 1);
    const nobody = await relang.run(client, GUILD, '399999999999999999', undefined);
    assert.equal(nobody.lang, null, 'no member and no personal language: nothing to go by (as before)');
});

test('4.6 privacy: the data export has the personal language; the privacy page names it', async () => {
    const query = async () => ({ rows: [] });
    const file = await buildDataExport(USER, { query, readKey: async (key) => (key === personalLanguageKey(USER) ? 'de' : null) });
    assert.equal(file.personalLanguage, 'de');
    assert.equal((await buildDataExport(USER, { query, readKey: async () => null })).personalLanguage, null);
    await assert.rejects(buildDataExport(USER, { query, readKey: async () => { throw new Error('db down'); } }), /db down/, 'never a half export');
    const html = String(privacyPage({}));
    assert.match(html, /Your language for Mewvo: the language you picked with \/language/);
});

test('4.6 the reply language of a member with a personal language (textForInteraction)', () => {
    setPersonalLanguagesForTests({ [USER]: 'fr' });
    try {
        assert.equal(textForInteraction({ locale: 'en-US', guildId: null, user: { id: USER } }).lang, 'fr');
        assert.equal(textForInteraction({ locale: 'de', guildId: null, user: { id: '399999999999999999' } }).lang, 'de');
    } finally {
        setPersonalLanguagesForTests();
    }
});

test('4.6 review fixes: a change during the startup load wins; clearing re-edits a non-member\'s DMs; an unfetchable member is told a role may still apply', async () => {
    // 1. A clear (or a new value) written while the load runs is not undone by the older snapshot.
    let release;
    const gate = new Promise((r) => { release = r; });
    const kv = new Map([[personalLanguageKey(USER), 'de'], ['user:300000000000000002:lang', 'ru']]);
    const fake = {
        list: async () => [...kv.keys()],
        get: async (k) => { await gate; return kv.get(k) ?? null; },
        set: async (k, v) => { kv.set(k, v); return true; },
        delete: async (k) => kv.delete(k),
        exists: async (k) => kv.has(k),
    };
    setPersonalLanguagesForTests({}, { loaded: false });
    const loading = loadPersonalLanguages(fake);
    await new Promise((r) => setImmediate(r));
    await clearPersonalLanguage(USER, { database: { delete: async () => true } });
    await setPersonalLanguage('300000000000000002', 'es', { database: { set: async () => true } });
    release();
    await loading;
    assert.equal(personalLanguageOf(USER), null, 'the clear made during the load stays');
    assert.equal(personalLanguageOf('300000000000000002'), 'es', 'the newer value stays');
    setPersonalLanguagesForTests();

    // 2. Cleared (nobody has a personal language now): a member who left still gets their DMs re-edited.
    const timers = [];
    const listed = [];
    const relang = createDmRelang({
        setTimer: (fn) => { timers.push(fn); return fn; }, clearTimer: () => {},
        listRows: async (args) => { listed.push(args); return []; },
        resolveLanguage: () => 'pl', hasPersonal: () => false,
    });
    const done = relang.schedule({ guilds: { cache: new Map() } }, GUILD, USER, { personal: true });
    timers[0]();
    assert.equal((await done).lang, 'pl');
    assert.equal(listed.length, 1);

    // 3. The member could not be fetched: saved, plus a line that a language role may still apply here.
    const interaction = {
        locale: 'en-US', guildId: GUILD, member: null, user: { id: USER }, client: {},
        guild: { id: GUILD, roles: { cache: new Map() }, members: { me: null, fetch: async () => { throw new Error('gone'); } } },
    };
    const payload = await applyLanguageChoice(interaction, 'de', { resolve: () => ({}), savePersonal: async () => {}, schedulePersonal: async () => {} });
    assert.match(payload.embeds[0].toJSON().description, /\n-# /);
});
