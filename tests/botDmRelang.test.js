// Bot DM log + language-change re-edit (schema v13; services/botDm/): a logged DM renders again
// from its stored params exactly like the first time, a new language changes only our text (staff /
// member text stays), sendLoggedDm logs only what it should, and the re-editor is paced, bounded,
// debounced and drops deleted or answered DMs. No database, no Discord: everything is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { banDm, caseVoidedDm, warnDm } from '../src/services/enforcement/dmTemplates.js';
import { DM_RENDERERS, caseParams, hasDmRenderer, renderDm } from '../src/services/botDm/dmRenderers.js';
import { sendLoggedDm, guildHasLanguageRoles } from '../src/services/botDm/dmLog.js';
import {
    DEBOUNCE_MS, MAX_EDITS, PACE_MS, createDmRelang, keepEmbedTimestamps, languageRoleChanged, onMemberRolesChanged,
} from '../src/services/botDm/dmRelang.js';
import { giftDm, giftNoteText } from '../src/commands/Core/premium.js';
import { suggestionDmPayload } from '../src/services/community/suggestionService.js';

const GUILD = '123456789012345678';
const USER = '223456789012345678';

function record(over = {}) {
    return {
        id: 41, guild_id: GUILD, target_user_id: USER, target_username: 'member', moderator_id: '1',
        moderator_username: 'ModOne', reason: 'Posting my own words <here>', created_at: new Date(Date.UTC(2026, 10, 1)),
        case_code: 'abc23k', expires_at: new Date(Date.UTC(2026, 10, 8)), duration_ms: 7 * 24 * 3600 * 1000,
        type: 'ban', ladder_level_after: 1, is_auto: false, unappealable: false, notes_internal: 'staff only',
        ...over,
    };
}

// ── re-render ─────────────────────────────────────────────────────────────

test('caseParams keeps only what the DM shows (no internal fields), dates as ISO strings', () => {
    const p = caseParams(record());
    assert.equal(p.notes_internal, undefined);
    assert.equal(p.target_user_id, undefined);
    assert.equal(p.moderator_id, undefined);
    assert.equal(p.created_at, '2026-11-01T00:00:00.000Z');
    assert.equal(caseParams(null), null);
    // Survives a JSON round trip (jsonb) unchanged.
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

test('a stored punishment DM renders again exactly as first sent (English and German)', async () => {
    for (const lang of ['en', 'de']) {
        const params = JSON.parse(JSON.stringify({ rec: caseParams(record()), guildId: GUILD, serverName: 'Cats' }));
        const again = await renderDm('enf.ban', params, lang);
        assert.equal(again.content, banDm(record(), { guildId: GUILD, serverName: 'Cats', lang }), lang);
        const warn = await renderDm('enf.warn', { rec: caseParams(record({ type: 'warn' })), guildId: GUILD, warnNumber: 2 }, lang);
        assert.equal(warn.content, warnDm(record({ type: 'warn' }), 2, { guildId: GUILD, lang }));
    }
});

test('a new language changes only our text: the staff-written reason stays as written', async () => {
    const params = { rec: caseParams(record()), guildId: GUILD, reason: 'Wrong person, sorry', invite: null };
    const en = (await renderDm('enf.caseVoided', params, 'en')).content;
    const fr = (await renderDm('enf.caseVoided', params, 'fr')).content;
    assert.notEqual(en, fr, 'our lines are translated');
    assert.ok(fr.includes('Wrong person, sorry'), 'the reason is kept');
    assert.equal(fr, caseVoidedDm(record(), 'Wrong person, sorry', null, { guildId: GUILD, lang: 'fr' }));
    const ban = (await renderDm('enf.ban', { rec: caseParams(record()), guildId: GUILD }, 'ru')).content;
    assert.ok(ban.includes('Posting my own words <here>'));
    assert.ok(ban.includes('abc23k'));
});

test('ticket, application, verification, suggestion and gift DMs re-render; their free text stays', async () => {
    const closed = await renderDm('ticket.closed', { channelName: 'ticket-7', reason: 'Solved by **staff**', closer: 'mod#1', time: 1700000000, ticketId: 7 }, 'de');
    const embed = closed.embeds[0].toJSON();
    assert.ok(embed.description.includes('Solved by **staff**'));
    assert.ok(embed.description.includes('<t:1700000000:F>'));
    assert.notEqual(embed.title, (await renderDm('ticket.closed', { channelName: 'ticket-7', reason: 'x', closer: 'm', time: 1, ticketId: 7 }, 'en')).embeds[0].toJSON().title);

    const survey = await renderDm('ticket.feedback', { channelName: 'ticket-7', guildId: GUILD, channelId: '323456789012345678' }, 'es');
    assert.equal(survey.components.length, 2);
    assert.equal(survey.components[0].toJSON().components[4].custom_id, `ticket_feedback:${GUILD}:323456789012345678:5`);

    const app = await renderDm('application.result', { approved: false, roleName: 'Helper', note: null, id: 'a1' }, 'pl');
    assert.ok(app.embeds[0].toJSON().description.includes('Helper'));
    const noted = await renderDm('application.result', { approved: true, roleName: 'Helper', note: 'Welcome aboard', id: 'a1' }, 'it');
    assert.ok(noted.embeds[0].toJSON().description.includes('Welcome aboard'));

    const ver = await renderDm('verification.approved', { serverName: null }, 'en');
    assert.ok(typeof ver.content === 'string' && ver.content.length > 0);

    const sugParams = { id: 5, serverName: 'Cats', status: 'approved', content: 'Add a cat channel', statusReason: 'Good idea' };
    const sug = await renderDm('suggestion.status', sugParams, 'fr');
    assert.deepEqual(sug.embeds[0].toJSON(), suggestionDmPayload(sugParams, 'fr').embeds[0].toJSON());
    assert.equal(sug.embeds[0].toJSON().description, 'Add a cat channel');

    const safeNote = giftNoteText('enjoy https://evil.example', { lang: 'en' });
    const gift = await renderDm('premium.gift', { fromId: '1', planId: 'plus', days: 30, code: 'KEY-1', safeNote, redeemUrl: null }, 'de');
    assert.ok(gift.content.includes(safeNote), 'the note as first shown, not sanitized again');
    assert.equal(gift.content, giftDm({ fromId: '1', planId: 'plus', days: 30, code: 'KEY-1', safeNote, redeemUrl: null, lang: 'de' }));
    assert.ok(!gift.content.includes('evil.example'));
});

test('every renderer key is known; an unknown key throws; a failing translation falls back to English', async () => {
    for (const key of Object.keys(DM_RENDERERS)) assert.ok(hasDmRenderer(key));
    assert.equal(hasDmRenderer('nope'), false);
    await assert.rejects(() => renderDm('nope', {}, 'en'), /unknown template/);
    const calls = [];
    const renderers = { k: { render: (p, lang) => { calls.push(lang); if (lang !== 'en') throw new Error('bad'); return { content: 'ok' }; } } };
    assert.deepEqual(await renderDm('k', {}, 'de', { renderers }), { content: 'ok' });
    assert.deepEqual(calls, ['de', 'en']);
});

// ── sendLoggedDm ─────────────────────────────────────────────────────────

function fakeUser({ fail = false } = {}) {
    const sent = [];
    return {
        id: USER, sent,
        send: async (payload) => {
            if (fail) throw new Error('Cannot send messages to this user');
            sent.push(payload);
            return { id: '923456789012345678', channelId: '823456789012345678' };
        },
    };
}

test('sendLoggedDm sends without mentions and logs key, params and language', async () => {
    const user = fakeUser();
    const inserted = [];
    const ok = await sendLoggedDm(user, { key: 'verification.denied', params: { serverName: 'Cats' }, guildId: GUILD }, {
        insert: async (row) => inserted.push(row), dbAvailable: () => true, hasLanguageRoles: () => true, resolveLanguage: () => 'fr',
    });
    assert.equal(ok, true);
    assert.deepEqual(user.sent[0].allowedMentions, { parse: [] });
    assert.equal(user.sent[0].content, (await renderDm('verification.denied', { serverName: 'Cats' }, 'fr')).content);
    assert.deepEqual(inserted, [{
        guildId: GUILD, userId: USER, channelId: '823456789012345678', messageId: '923456789012345678',
        key: 'verification.denied', params: { serverName: 'Cats' }, lang: 'fr',
    }]);
});

test('sendLoggedDm passes the member to the language step and keeps extra components', async () => {
    const user = fakeUser();
    let seen;
    const member = { id: USER, roles: [] };
    await sendLoggedDm(user, { key: 'verification.approved', params: {}, guildId: GUILD, member, components: [{ type: 1 }] }, {
        insert: async () => {}, dbAvailable: () => true, hasLanguageRoles: () => false,
        resolveLanguage: (args) => { seen = args; return 'en'; },
    });
    assert.equal(seen.member, member);
    assert.equal(seen.purpose, 'dm');
    assert.deepEqual(user.sent[0].components, [{ type: 1 }]);
});

test('sendLoggedDm does not log without language roles, without a server, or with the database down', async () => {
    for (const [over, guildId] of [[{ hasLanguageRoles: () => false }, GUILD], [{}, null], [{ dbAvailable: () => false }, GUILD]]) {
        const inserted = [];
        const ok = await sendLoggedDm(fakeUser(), { key: 'verification.approved', params: {}, guildId }, {
            insert: async (row) => inserted.push(row), dbAvailable: () => true, hasLanguageRoles: () => true, resolveLanguage: () => 'en', ...over,
        });
        assert.equal(ok, true);
        assert.equal(inserted.length, 0);
    }
});

test('sendLoggedDm: a closed DM is false and not logged; a failed log write still reports the DM as delivered', async () => {
    const inserted = [];
    const deps = { insert: async (row) => inserted.push(row), dbAvailable: () => true, hasLanguageRoles: () => true, resolveLanguage: () => 'en' };
    assert.equal(await sendLoggedDm(fakeUser({ fail: true }), { key: 'verification.approved', guildId: GUILD }, deps), false);
    assert.equal(inserted.length, 0);
    assert.equal(await sendLoggedDm(fakeUser(), { key: 'verification.approved', guildId: GUILD }, { ...deps, insert: async () => { throw new Error('db down'); } }), true);
});

test('guildHasLanguageRoles: a set role counts; none, empty or a read error do not', () => {
    assert.equal(guildHasLanguageRoles(GUILD, { resolve: () => ({ fr: '1' }) }), true);
    assert.equal(guildHasLanguageRoles(GUILD, { resolve: () => ({}) }), false);
    assert.equal(guildHasLanguageRoles(GUILD, { resolve: () => { throw new Error('down'); } }), false);
    assert.equal(guildHasLanguageRoles(null, { resolve: () => ({ fr: '1' }) }), false);
});

// ── re-edit ──────────────────────────────────────────────────────────────

function fakeClock() {
    let t = 1_000_000;
    const timers = [];
    const sleeps = [];
    return {
        now: () => t,
        sleep: async (ms) => { sleeps.push(ms); t += ms; },
        setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
        clearTimer: (timer) => { timer.cleared = true; },
        fire: () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn(); },
        timers, sleeps,
        advance: (ms) => { t += ms; },
    };
}

function fakeClient({ messages = {}, member = { id: USER } } = {}) {
    const edits = [];
    const client = {
        edits,
        guilds: { cache: new Map([[GUILD, { members: { cache: new Map(member ? [[USER, member]] : []), fetch: async () => null } }]]) },
        channels: {
            fetch: async (id) => ({
                messages: {
                    fetch: async (mid) => {
                        const m = messages[mid];
                        if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
                        return { ...m, edit: async (payload) => { edits.push({ id: mid, channel: id, payload }); } };
                    },
                },
            }),
        },
    };
    return client;
}

const row = (n, key = 'verification.approved', params = { serverName: 'Cats' }) => ({
    id: n, channel_id: '823456789012345678', message_id: `m${n}`, template_key: key, params, lang: 'en',
});

function relangWith(clock, rows, over = {}) {
    const calls = { list: [], deleted: [], langs: [] };
    const relang = createDmRelang({
        now: clock.now, sleep: clock.sleep, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        listRows: async (args) => { calls.list.push(args); return rows; },
        deleteRow: async (id) => { calls.deleted.push(id); },
        setLang: async (id, lang) => { calls.langs.push([id, lang]); },
        resolveLanguage: () => 'de',
        ...over,
    });
    return { relang, calls };
}

test('a run edits each logged DM into the new language, paced 1.5 s apart, and records the language', async () => {
    const clock = fakeClock();
    const rows = [row(1), row(2), row(3)];
    const client = fakeClient({ messages: { m1: { components: [] }, m2: { components: [] }, m3: { components: [] } } });
    const { relang, calls } = relangWith(clock, rows);
    const done = relang.schedule(client, GUILD, USER);
    assert.equal(clock.timers[0].ms, DEBOUNCE_MS);
    clock.fire();
    const out = await done;
    assert.equal(out.edited, 3);
    assert.equal(out.lang, 'de');
    assert.deepEqual(calls.list, [{ guildId: GUILD, userId: USER, lang: 'de', limit: MAX_EDITS }]);
    const expected = (await renderDm('verification.approved', { serverName: 'Cats' }, 'de')).content;
    assert.deepEqual(client.edits.map((e) => e.payload.content), [expected, expected, expected]);
    assert.deepEqual(client.edits[0].payload.allowedMentions, { parse: [] });
    assert.deepEqual(calls.langs, [[1, 'de'], [2, 'de'], [3, 'de']]);
    // The first edit goes at once; each next one waits until 1.5 s after the previous.
    assert.deepEqual(clock.sleeps, [PACE_MS, PACE_MS]);
});

test('a deleted DM (10008) loses its row and the run goes on', async () => {
    const clock = fakeClock();
    const client = fakeClient({ messages: { m2: { components: [] } } });
    const { relang, calls } = relangWith(clock, [row(1), row(2)]);
    const done = relang.schedule(client, GUILD, USER);
    clock.fire();
    const out = await done;
    assert.equal(out.removed, 1);
    assert.equal(out.edited, 1);
    assert.deepEqual(calls.deleted, [1]);
    assert.deepEqual(client.edits.map((e) => e.id), ['m2']);
});

test('an answered feedback survey (no buttons left) is not put back: row removed, no edit', async () => {
    const clock = fakeClock();
    const params = { channelName: 't', guildId: GUILD, channelId: '323456789012345678' };
    const client = fakeClient({ messages: { m1: { components: [] }, m2: { components: [{ type: 1 }], embeds: [] } } });
    const { relang, calls } = relangWith(clock, [row(1, 'ticket.feedback', params), row(2, 'ticket.feedback', params)]);
    const done = relang.schedule(client, GUILD, USER);
    clock.fire();
    const out = await done;
    assert.deepEqual(calls.deleted, [1]);
    assert.deepEqual(client.edits.map((e) => e.id), ['m2']);
    assert.equal(client.edits[0].payload.components.length, 2, 'a survey still open gets translated buttons');
    assert.equal(out.edited, 1);
});

test('only our parts: an edit carries no components or files unless the template renders them', async () => {
    const clock = fakeClock();
    const client = fakeClient({ messages: { m1: { components: [{ type: 1, contest: true }] } } });
    const { relang } = relangWith(clock, [row(1, 'enf.ban', { rec: caseParams(record()), guildId: GUILD })]);
    const done = relang.schedule(client, GUILD, USER);
    clock.fire();
    await done;
    const payload = client.edits[0].payload;
    assert.equal('components' in payload, false, 'the "Contest this" button is left as it is');
    assert.equal('files' in payload, false);
    assert.ok(payload.content.includes('Posting my own words <here>'));
});

test('debounce: two changes within a minute run once, with the language the member has at the end', async () => {
    const clock = fakeClock();
    let lang = 'fr';
    const client = fakeClient({ messages: { m1: {} } });
    const { relang, calls } = relangWith(clock, [row(1)], { resolveLanguage: () => lang });
    const first = relang.schedule(client, GUILD, USER);
    clock.advance(20_000);
    lang = 'pl';
    const second = relang.schedule(client, GUILD, USER);
    assert.equal(await first, null, 'the first change is superseded');
    assert.equal(clock.timers.filter((t) => !t.cleared).length, 1);
    clock.fire();
    const out = await second;
    assert.equal(out.lang, 'pl');
    assert.equal(calls.list.length, 1);
    assert.equal(client.edits.length, 1);
});

test('a newer change stops a run in progress at its next DM', async () => {
    const clock = fakeClock();
    const client = fakeClient({ messages: { m1: {}, m2: {}, m3: {} } });
    let relang;
    const sleep = async (ms) => {
        clock.advance(ms);
        relang.schedule(client, GUILD, USER); // a change arrives while the run waits
    };
    ({ relang } = relangWith(clock, [row(1), row(2), row(3)], { sleep }));
    const done = relang.schedule(client, GUILD, USER);
    clock.timers[0].fn();
    const out = await done;
    assert.equal(out.stopped, true);
    assert.equal(client.edits.length, 1, 'the first DM went before the change; none after it');
});

test('a member who left (not fetchable) or a database error: nothing edited, nothing thrown', async () => {
    const clock = fakeClock();
    const { relang } = relangWith(clock, [row(1)]);
    const gone = relang.schedule(fakeClient({ member: null, messages: { m1: {} } }), GUILD, USER);
    clock.fire();
    assert.equal((await gone).edited, 0);
    const failing = relangWith(clock, [], { listRows: async () => { throw new Error('database not responding'); } }).relang;
    const p = failing.schedule(fakeClient(), GUILD, USER);
    clock.fire();
    assert.equal((await p).edited, 0);
});

test('keepEmbedTimestamps keeps the original embed time', () => {
    const at = '2026-11-01T10:00:00.000Z';
    const out = keepEmbedTimestamps({ embeds: [new EmbedBuilder().setTitle('x')] }, { embeds: [{ timestamp: at }] });
    assert.equal(out.embeds[0].toJSON().timestamp, at);
    const plain = { content: 'x' };
    assert.equal(keepEmbedTimestamps(plain, { embeds: [] }), plain);
});

test('languageRoleChanged / onMemberRolesChanged: only a language role change schedules a re-edit', () => {
    const map = { en: '11', fr: '12' };
    const m = (ids, partial = false) => ({ id: USER, partial, guild: { id: GUILD }, client: {}, roles: { cache: new Map(ids.map((id) => [id, {}])) } });
    assert.equal(languageRoleChanged(m(['11']), m(['12']), map), true);
    assert.equal(languageRoleChanged(m(['11', '99']), m(['11']), map), false, 'another role');
    assert.equal(languageRoleChanged(m([], true), m(['12']), map), true, 'partial old member with a language role now');
    assert.equal(languageRoleChanged(m([], true), m(['99']), map), false);
    assert.equal(languageRoleChanged(m(['11']), m(['12']), {}), false, 'no language roles set');
    const scheduled = [];
    const schedule = (...args) => scheduled.push(args);
    assert.equal(onMemberRolesChanged(m(['11']), m([]), { resolve: () => map, schedule }), true);
    assert.equal(onMemberRolesChanged(m(['11']), m(['11']), { resolve: () => map, schedule }), false);
    assert.equal(onMemberRolesChanged(m(['11']), m([]), { resolve: () => { throw new Error('down'); }, schedule }), false);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0][1], GUILD);
    assert.equal(scheduled[0][2], USER);
});
