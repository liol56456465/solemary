// Announcements (dashboard Messages page): the explicit ping and allowedMentions, link buttons
// (https only), the stored payload of a scheduled announcement, the template library (count,
// groups, home-only templates and their translations, language choice) and the changelog fill.
// Nothing reaches Discord: fake channels record every send.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import {
    LINK_BUTTON_MAX, announcementMentions, cleanLinkButtons, cleanPing, isLinkButtonUrl, pingLine, postBotMessage,
    EMBED_DESCRIPTION_MAX, EMBED_TITLE_MAX,
} from '../src/services/botMessageService.js';
import { cleanPayload, runScheduledMessageNow } from '../src/services/scheduledMessageService.js';
import {
    MESSAGE_TEMPLATES, fillTemplate, isHomeTemplate, messageTemplate, templateLanguages, templatesByGroup,
} from '../src/config/messageTemplates.js';
import { MEWVO_TEMPLATES, HOME_PLACEHOLDERS } from '../src/config/mewvoTemplates.js';
import { CHANGELOG } from '../src/config/site/changelog.js';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { changelogChoices, changelogText, chosenTemplate, pickedChangelog } from '../src/services/dashboard/modules/messages.js';
import { MODULES, getAction } from '../src/services/dashboard/modules/index.js';
import { MANAGER_ACTIONS } from './helpers/privilegedActions.js';

const ROLE = '600000000000000001';
const USER = '300000000000000004';
const USER2 = '300000000000000005';

function makeChannel() {
    const sent = [];
    return {
        id: '500000000000000001', name: 'general', type: ChannelType.GuildText, sent,
        isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
        async send(payload) { sent.push(payload); return { id: '710000000000000001', payload }; },
    };
}
const guild = { id: '100000000000000001', members: { me: { id: 'bot' } } };

// ── allowedMentions per choice ────────────────────────────────────────────

test('allowedMentions: nothing picked → no pings at all, whatever the text says', async () => {
    const channel = makeChannel();
    await postBotMessage(guild, { channel, content: `@everyone @here <@&${ROLE}> <@${USER}>`, ping: null });
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    assert.equal(channel.sent[0].content, `@everyone @here <@&${ROLE}> <@${USER}>`, 'text unchanged, no ping line');
    await postBotMessage(guild, { channel, content: 'x', ping: { everyone: false, roleIds: [], userIds: [] } });
    assert.deepEqual(channel.sent[1].allowedMentions, { parse: [] }, 'an empty ping is no ping');
});

test('allowedMentions: a picked role pings only that role; @everyone typed in the text still does not ping', async () => {
    const channel = makeChannel();
    await postBotMessage(guild, { channel, content: 'Event tonight @everyone <@&600000000000000009>', ping: { roleIds: [ROLE] } });
    const sent = channel.sent[0];
    assert.deepEqual(sent.allowedMentions, { parse: [], roles: [ROLE], users: [] });
    assert.ok(!sent.allowedMentions.parse.includes('everyone'));
    assert.equal(sent.content, `<@&${ROLE}>\nEvent tonight @everyone <@&600000000000000009>`, 'the ping goes in front');
});

test('allowedMentions: everyone only when ticked; picked users only (New moderators)', async () => {
    const channel = makeChannel();
    await postBotMessage(guild, { channel, content: 'News', ping: { everyone: true } });
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: ['everyone'], roles: [], users: [] });
    assert.equal(channel.sent[0].content, '@everyone\nNews');
    await postBotMessage(guild, { channel, embed: { description: `Welcome <@${USER}>, <@${USER2}>` }, content: 'Welcome', ping: { userIds: [USER, USER2] } });
    assert.deepEqual(channel.sent[1].allowedMentions, { parse: [], roles: [], users: [USER, USER2] });
    assert.equal(channel.sent[1].content, `<@${USER}> <@${USER2}>\nWelcome`);
});

test('cleanPing / pingLine / announcementMentions: bad ids dropped, one role at most, at most 5 users, everyone only when true', () => {
    assert.deepEqual(cleanPing({ everyone: 'yes', roleIds: ['x', ROLE, '600000000000000002'], userIds: ['1', USER, USER] }),
        { everyone: false, roleIds: [ROLE], userIds: [USER] });
    assert.equal(cleanPing({ userIds: Array.from({ length: 9 }, (_, i) => `30000000000000001${i}`) }).userIds.length, 5);
    assert.equal(pingLine({ everyone: true, roleIds: [ROLE], userIds: [USER] }), `@everyone <@&${ROLE}> <@${USER}>`);
    assert.equal(pingLine(null), '');
    assert.deepEqual(announcementMentions({ roleIds: ['@everyone'] }), { parse: [] }, 'a non-id never turns into a ping');
});

test('a ping alone is not a message; the ping counts toward the 2000 characters', async () => {
    const channel = makeChannel();
    await assert.rejects(postBotMessage(guild, { channel, ping: { everyone: true } }), /nothing to post/);
    await assert.rejects(postBotMessage(guild, { channel, content: 'x'.repeat(1995), ping: { everyone: true } }), /limited to 2000/);
    assert.equal(channel.sent.length, 0);
});

// ── link buttons ──────────────────────────────────────────────────────────

test('link buttons: https only, a real host, no user:password; at most 3; posted as Link-style buttons', async () => {
    for (const url of ['http://example.com', 'javascript:alert(1)', 'https://localhost/x', 'https://user:pw@example.com', 'https://exa mple.com', '', `https://e.com/${'a'.repeat(600)}`]) {
        assert.equal(isLinkButtonUrl(url), false, url);
    }
    assert.equal(isLinkButtonUrl('https://example.com/rules?x=1'), true);
    assert.throws(() => cleanLinkButtons([{ label: 'A', url: 'http://example.com' }]), /full https:\/\/ link/);
    assert.throws(() => cleanLinkButtons([{ label: '', url: 'https://example.com' }]), /label needs/);
    assert.throws(() => cleanLinkButtons(Array.from({ length: LINK_BUTTON_MAX + 1 }, () => ({ label: 'A', url: 'https://a.example' }))), /At most 3/);

    const channel = makeChannel();
    await postBotMessage(guild, { channel, content: 'Read these', buttons: [{ label: 'Rules', url: 'https://example.com/rules' }, { label: 'Site', url: 'https://example.com' }] });
    const [row] = channel.sent[0].components.map((c) => c.toJSON());
    assert.equal(row.components.length, 2);
    assert.deepEqual(row.components.map((b) => [b.style, b.label, b.url]), [[ButtonStyle.Link, 'Rules', 'https://example.com/rules'], [ButtonStyle.Link, 'Site', 'https://example.com']]);
    await assert.rejects(postBotMessage(guild, { channel, content: 'x', buttons: [{ label: 'Bad', url: 'http://example.com' }] }), /https/);
    assert.equal(channel.sent.length, 1, 'the bad one was not sent');
    await postBotMessage(guild, { channel, content: 'plain' });
    assert.equal(channel.sent[1].components, undefined, 'no buttons → no components');
});

// ── scheduled announcements keep ping and buttons ─────────────────────────

test('scheduled payload: ping and buttons kept (cleaned), plain payloads unchanged; the scheduled post sends them', async () => {
    assert.deepEqual(cleanPayload({ content: 'a', embed: null }), { content: 'a', embed: null });
    assert.deepEqual(cleanPayload({ content: 'a', ping: { everyone: false, roleIds: [], userIds: [] }, buttons: [] }), { content: 'a', embed: null }, 'empty extras dropped');
    const payload = cleanPayload({ content: 'a', ping: { roleIds: [ROLE, 'x'] }, buttons: [{ label: 'R', url: 'https://example.com', extra: 1 }] });
    assert.deepEqual(payload, { content: 'a', embed: null, ping: { everyone: false, roleIds: [ROLE], userIds: [] }, buttons: [{ label: 'R', url: 'https://example.com' }] });
    assert.throws(() => cleanPayload({ content: 'a', buttons: [{ label: 'R', url: 'http://example.com' }] }), /https/);

    const channel = makeChannel();
    const g = { id: '100000000000000001', channels: { cache: new Map([[channel.id, channel]]), fetch: async () => channel } };
    const calls = [];
    const store = {
        get: async () => ({ id: 1, guildId: g.id, channelId: channel.id, payload, schedule: { kind: 'weekly', time: '10:00', days: [1] }, timezone: 'UTC' }),
        recordSuccess: async () => {}, recordNote: async () => {}, setPaused: async () => {},
    };
    await runScheduledMessageNow(g, 1, { store, post: async (guildArg, args) => { calls.push(args); return { message: { id: '1' } }; } });
    assert.deepEqual(calls[0].ping, payload.ping);
    assert.deepEqual(calls[0].buttons, payload.buttons);
});

// ── templates ─────────────────────────────────────────────────────────────

test('templates: 25+ new general ones (76+ in all), grouped, each group fits a Discord select', () => {
    assert.ok(MESSAGE_TEMPLATES.length >= 76, `${MESSAGE_TEMPLATES.length} general templates`);
    const keys = templatesByGroup().map((g) => g.key);
    for (const key of ['reminders', 'events', 'voice', 'downtime', 'milestones', 'staff', 'partners', 'polls', 'holidays']) assert.ok(keys.includes(key), key);
    for (const id of ['game-night', 'movie-night', 'giveaway-start', 'rule-added', 'emergency-maintenance', 'server-anniversary', 'staff-apps-deadline', 'partner-requirements', 'feedback-wanted', 'new-year']) {
        assert.ok(messageTemplate(id), id);
    }
    for (const g of templatesByGroup({ home: true })) assert.ok(g.templates.length <= 25, g.key);
});

test('home-only templates: 10, never in the default list or lookups; listed first and found with { home: true }', () => {
    assert.equal(MEWVO_TEMPLATES.length, 11);
    const ids = MEWVO_TEMPLATES.map((t) => t.id);
    for (const id of ['mewvo-new-mods', 'mewvo-changelog', 'mewvo-new-feature', 'mewvo-maintenance', 'mewvo-downtime-resolved', 'mewvo-premium', 'mewvo-staff-changes', 'mewvo-server-count', 'mewvo-translation-help', 'mewvo-server-event']) {
        assert.ok(ids.includes(id), id);
        assert.equal(isHomeTemplate(id), true);
        assert.equal(messageTemplate(id), null, `${id}: unknown without home`);
        assert.equal(messageTemplate(id, { home: true })?.id, id);
    }
    assert.ok(!templatesByGroup().some((g) => g.templates.some((t) => t.home)), 'default list (also /embedbuilder) has none');
    assert.equal(templatesByGroup({ home: true })[0].key, 'mewvo');
    assert.equal(new Set([...ids, ...MESSAGE_TEMPLATES.map((t) => t.id)]).size, ids.length + MESSAGE_TEMPLATES.length, 'ids unique across both');
    assert.equal(isHomeTemplate('game-night'), false);
});

test('home templates: all 8 languages, the same placeholders as English, within embed limits, plain voice ("!" never)', () => {
    const placeholders = (s) => [...s.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]).sort();
    for (const t of MEWVO_TEMPLATES) {
        assert.deepEqual(templateLanguages(t).sort(), [...LANG_CODES].sort(), `${t.id}: languages`);
        for (const p of placeholders(t.title + t.text)) assert.ok(HOME_PLACEHOLDERS.includes(p), `${t.id}: {${p}}`);
        assert.ok(!/[A-Za-z.)\]]!(?=\s|$)/.test(t.title + t.text) && !/—|feel free|let'?s\b|excited|thrilled/i.test(t.title + t.text), `${t.id}: plain English voice`);
        for (const [lang, tr] of Object.entries(t.translations)) {
            assert.deepEqual(placeholders(tr.title + tr.text), placeholders(t.title + t.text), `${t.id}/${lang}: placeholders`);
            const filled = fillTemplate(t, { server: 'S'.repeat(100), lang, count: '1,234', changes: 'x'.repeat(2000) });
            assert.equal(filled.lang, lang);
            assert.ok(filled.title.length <= EMBED_TITLE_MAX && filled.text.length <= EMBED_DESCRIPTION_MAX, `${t.id}/${lang}: limits`);
            assert.ok(!/[A-Za-zÀ-ÿА-я.)\]]!(?=\s|$)/.test(tr.title + tr.text), `${t.id}/${lang}: no exclamation mark`);
            assert.ok(!/—/.test(tr.title + tr.text), `${t.id}/${lang}: no em dash`);
        }
    }
    assert.equal(messageTemplate('mewvo-new-mods', { home: true }).members, true);
    assert.equal(messageTemplate('mewvo-changelog', { home: true }).changelog, true);
    assert.equal(messageTemplate('mewvo-server-count', { home: true }).serverCount, true);
});

test('fillTemplate: language choice (English fallback), {count} and {changes} filled, {mods} left for posting', () => {
    const count = messageTemplate('mewvo-server-count', { home: true });
    assert.deepEqual(fillTemplate(count, { lang: 'de', count: '1.234' }).title, 'Mewvo ist jetzt auf 1.234 Servern');
    assert.equal(fillTemplate(count, { lang: 'xx' }).lang, 'en');
    assert.match(fillTemplate(count, {}).title, /\[number\]/, 'no count → a bracket to fill');
    const general = messageTemplate('game-night');
    assert.equal(fillTemplate(general, { lang: 'de', server: 'Cats' }).lang, 'de', 'general templates come in 8 languages too (2026-11-10)');
    assert.match(fillTemplate(messageTemplate('mewvo-new-mods', { home: true }), { lang: 'ru' }).text, /\{mods\}/);
});

// ── changelog fill ────────────────────────────────────────────────────────

test('changelog: newest entries offered; default = the newest day; ticked ones kept in order; unknown ones ignored', () => {
    const choices = changelogChoices();
    assert.ok(choices.length > 0 && choices.length <= 20);
    assert.equal(choices[0].date, CHANGELOG[0].date);
    assert.deepEqual(pickedChangelog({}, choices).map((c) => c.item), CHANGELOG[0].items);
    const second = CHANGELOG[1];
    const picked = pickedChangelog({ entry: [`${second.date}:${second.items[0]}`, 'nope:x', `${CHANGELOG[0].date}:${CHANGELOG[0].items[0]}`] }, choices);
    assert.deepEqual(picked.map((c) => c.key), [`${CHANGELOG[0].date}:${CHANGELOG[0].items[0]}`, `${second.date}:${second.items[0]}`], 'newest first');
    assert.deepEqual(pickedChangelog({ entry: 'nope:x' }, choices).map((c) => c.date), CHANGELOG[0].items.map(() => CHANGELOG[0].date));
});

test('changelog: the text is the website changelog in the chosen language, bold date per day', () => {
    const picked = pickedChangelog({ entry: '2026-11-08:public' });
    const en = changelogText(picked, 'en');
    assert.match(en, /^\*\*8 November 2026\*\*\n- Mewvo is public: any server can add it/);
    const de = changelogText(picked, 'de');
    assert.ok(de.startsWith('**') && !de.includes('Mewvo is public'), 'German text from de/changelog.json');

    const home = chosenTemplate({ template: 'mewvo-changelog', entry: '2026-11-08:public', lang: 'en' }, 'Main', { home: true });
    assert.match(home.payload.embed.description, /What changed in Mewvo:\n\n\*\*8 November 2026\*\*\n- Mewvo is public/);
    assert.equal(home.lang, 'en');
    assert.deepEqual(home.changelog.picked.map((c) => c.key), ['2026-11-08:public']);
    const count = chosenTemplate({ template: 'mewvo-server-count' }, 'Main', { home: true, serverCount: 1234, lang: 'en' });
    assert.equal(count.payload.embed.title, 'Mewvo is now in 1,234 servers');
});

test('chosenTemplate: home-only ids refused outside Mewvo\'s servers, language from ?lang= or the default', () => {
    for (const t of MEWVO_TEMPLATES) assert.deepEqual(chosenTemplate({ template: t.id }, 'Other', { home: false }), { homeOnly: true }, t.id);
    assert.equal(chosenTemplate({ template: 'mewvo-maintenance' }, 'Main', { home: true, lang: 'pl' }).lang, 'pl');
    assert.equal(chosenTemplate({ template: 'mewvo-maintenance', lang: 'fr' }, 'Main', { home: true, lang: 'pl' }).lang, 'fr');
    const general = chosenTemplate({ template: 'game-night', lang: 'de' }, 'Cats', { home: false });
    assert.equal(general.lang, 'de', 'general templates are translated too');
    assert.equal(chosenTemplate({ template: 'game-night', lang: 'xx' }, 'Cats', { home: false }).lang, 'en', 'unknown language → English');
});

// ── the send/schedule actions refuse home-only ids in another server ──────

test('send / schedule in another server: a home-only template id is refused (403) before anything else', async () => {
    const module = MODULES.find((m) => m.key === 'messages');
    const ctx = { guildId: '990000000000000099', guild: { id: '990000000000000099', channels: { cache: new Map() }, roles: { cache: new Map() } }, env: {} };
    for (const id of MEWVO_TEMPLATES.map((t) => t.id)) {
        await assert.rejects(module.actions.send.confirm(ctx, { template: id, content: 'x' }), (e) => e.status === 403 && /only for Mewvo/.test(e.message), id);
        await assert.rejects(module.actions.send.run(ctx, { template: id, content: 'x' }), (e) => e.status === 403, id);
        await assert.rejects(module.actions.schedule.run(ctx, { template: id, content: 'x' }), (e) => e.status === 403, id);
    }
});

test('posting is Administrator-only: every Messages action is admin, none is a manager action', () => {
    const module = MODULES.find((m) => m.key === 'messages');
    for (const name of Object.keys(module.actions)) {
        assert.equal(getAction(module, name).admin, true, name);
        assert.ok(!getAction(module, name).manager, name);
        assert.ok(!MANAGER_ACTIONS.has(`messages/${name}`), name);
    }
    assert.equal(typeof getAction(module, 'send').confirm, 'function', 'Send shows a preview first');
});
