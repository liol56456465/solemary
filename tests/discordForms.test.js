// "Type it in chat" replaced: the /jointocreate config settings modal (settingsModal.js) and the
// Skip / Stop setup buttons of the DM setup wizard (configWizard.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PermissionFlagsBits } from 'discord.js';
import {
    MODAL_PREFIX, SETTING_KINDS, buildSettingsModal, handleSettingsModalSubmit, parseSettingValue, parseSettingsModalId, settingsModalId,
} from '../src/commands/JoinToCreate/modules/settingsModal.js';
import settingsModalHandler from '../src/interactions/modals/joinToCreate/settings.js';
import { STEP_BUTTON_PREFIX, askQuestion, stepButtons, stillAllowed, waitForAnswer } from '../src/commands/Core/configWizard.js';
import { isCollectorManagedComponent } from '../src/utils/collectorComponents.js';

const GUILD = '100000000000000001';
const ADMIN = '200000000000000002';
const USER = '200000000000000005';
const TRIGGER = '500000000000000004';
const NOW = Date.UTC(2026, 10, 7, 12);

// ── Join to Create: the settings modal ────────────────────────────────────

test('settings modal: one per setting, prefilled with the current value, custom ID with expiry; registered as a modal handler', () => {
    assert.deepEqual(SETTING_KINDS, { name_template: 'name', user_limit: 'limit', bitrate: 'bitrate' });
    assert.equal(settingsModalHandler.name, MODAL_PREFIX);
    assert.ok(!MODAL_PREFIX.startsWith('jtc_'), 'not swallowed by the inline-awaited jtc_ skip in interactionCreate');
    const config = { channelNameTemplate: "{username}'s room", userLimit: 0, bitrate: 64000, channelOptions: { [TRIGGER]: { userLimit: 5, bitrate: 96000 } } };
    const json = (kind) => buildSettingsModal(kind, TRIGGER, config, { now: NOW }).toJSON();
    const name = json('name');
    assert.equal(name.custom_id, settingsModalId('name', TRIGGER, NOW));
    assert.equal(name.title, 'Channel name template');
    const input = name.components[0].component;
    assert.equal(input.custom_id, 'value');
    assert.equal(input.value, "{username}'s room");
    assert.equal(input.max_length, 100);
    assert.equal(json('limit').components[0].component.value, '5');
    assert.equal(json('bitrate').components[0].component.value, '96');
    assert.deepEqual(parseSettingsModalId(name.custom_id), { kind: 'name', channelId: TRIGGER, expiresAt: NOW + 10 * 60 * 1000 });
    for (const bad of ['jtcset:other:500000000000000004:abc', 'jtcset:name:123:abc', 'jtcset:name:500000000000000004:', 'x:name:500000000000000004:abc', '']) assert.equal(parseSettingsModalId(bad), null, bad);
});

test('settings modal values: template one line up to 100; limit 0–99; bitrate 8–384 kbps (saved in bps)', () => {
    assert.deepEqual(parseSettingValue('name', '  {username} talks '), { key: 'nameTemplate', value: '{username} talks', text: 'Channel name template changed to `{username} talks`.' });
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(101)]) assert.ok(parseSettingValue('name', bad).error, JSON.stringify(bad));
    assert.deepEqual(parseSettingValue('limit', '0'), { key: 'userLimit', value: 0, text: 'User limit changed to no limit.' });
    assert.equal(parseSettingValue('limit', '99').value, 99);
    for (const bad of ['100', '-1', '1.5', 'five', '']) assert.ok(parseSettingValue('limit', bad).error, bad);
    assert.equal(parseSettingValue('bitrate', '128').value, 128000);
    for (const bad of ['7', '385', '64k', '']) assert.ok(parseSettingValue('bitrate', bad).error, bad);
});

function modalInteraction({ customId = settingsModalId('limit', TRIGGER, NOW), value = '12', admin = true, ownerId = '999999999999999990', userId = ADMIN } = {}) {
    const calls = [];
    return {
        calls,
        customId,
        user: { id: userId },
        guild: { id: GUILD, ownerId },
        memberPermissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator },
        fields: { getTextInputValue: (name) => { calls.push(['field', name]); return value; } },
        deferReply: async (options) => { calls.push(['defer', options]); },
        editReply: async (payload) => { calls.push(['edit', payload]); },
    };
}

function fakeStore(config) {
    const writes = [];
    const mutate = async (client, guildId, fn) => {
        const copy = structuredClone(config);
        const result = fn(copy);
        if (result !== false) { Object.assign(config, copy); writes.push(guildId); }
        return result === undefined ? true : result;
    };
    return { mutate, writes, config };
}

const reply = (i) => i.calls.find((c) => c[0] === 'edit')?.[1];

test('settings modal submit: acknowledged first; saved with one locked write; reply never pings', async () => {
    const store = fakeStore({ triggerChannels: [TRIGGER], channelOptions: { [TRIGGER]: { bitrate: 96000 } } });
    const i = modalInteraction();
    await handleSettingsModalSubmit(i, {}, { mutate: store.mutate, now: NOW });
    assert.equal(i.calls[0][0], 'defer', 'deferReply before anything else');
    assert.ok(i.calls[0][1].flags, 'ephemeral');
    assert.deepEqual(store.config.channelOptions[TRIGGER], { bitrate: 96000, userLimit: 12 }, 'other options kept');
    assert.deepEqual(store.writes, [GUILD]);
    assert.match(reply(i).content, /User limit changed to 12 members\. New temporary channels of <#500000000000000004> use it\./);
    assert.deepEqual(reply(i).allowedMentions, { parse: [] });
});

test('settings modal submit: expired, no longer Administrator, invalid value, trigger removed, database down → nothing saved', async () => {
    const cases = [
        [{ customId: settingsModalId('limit', TRIGGER, NOW - 11 * 60 * 1000) }, /expired/],
        [{ admin: false }, /Administrator/],
        [{ value: '150' }, /0 to 99\. Nothing was changed/],
        [{ customId: 'jtcset:bogus' }, /not valid any more/],
    ];
    for (const [options, message] of cases) {
        const store = fakeStore({ triggerChannels: [TRIGGER], channelOptions: {} });
        const i = modalInteraction(options);
        await handleSettingsModalSubmit(i, {}, { mutate: store.mutate, now: NOW });
        assert.equal(i.calls[0][0], 'defer', JSON.stringify(options));
        assert.match(reply(i).content, message, JSON.stringify(options));
        assert.deepEqual(reply(i).allowedMentions, { parse: [] });
        assert.deepEqual(store.writes, [], JSON.stringify(options));
    }
    // The server owner without the Administrator bit may (like the command gate).
    const owner = modalInteraction({ admin: false, ownerId: ADMIN });
    const ownerStore = fakeStore({ triggerChannels: [TRIGGER], channelOptions: {} });
    await handleSettingsModalSubmit(owner, {}, { mutate: ownerStore.mutate, now: NOW });
    assert.deepEqual(ownerStore.writes, [GUILD]);

    const gone = fakeStore({ triggerChannels: [], channelOptions: {} });
    const i = modalInteraction();
    await handleSettingsModalSubmit(i, {}, { mutate: gone.mutate, now: NOW });
    assert.match(reply(i).content, /no longer a Join to Create channel/);
    assert.deepEqual(gone.writes, []);

    const down = modalInteraction();
    await handleSettingsModalSubmit(down, {}, { mutate: async () => { throw new Error('db down'); }, now: NOW });
    assert.match(reply(down).content, /database is not responding, so nothing was changed/);
});

// ── DM setup wizard: Skip / Stop setup buttons ────────────────────────────

/** A DM channel whose message collectors are driven by the test; sent messages get button collectors. */
function fakeDm() {
    const sent = [];
    const collectors = { text: [], buttons: [] };
    const collector = (bucket, options) => {
        const c = new EventEmitter();
        c.options = options;
        c.stopped = null;
        c.stop = (reason) => { if (c.stopped) return; c.stopped = reason; c.emit('end', new Map(), reason); };
        bucket.push(c);
        return c;
    };
    const dm = {
        sent, collectors,
        send: async (payload) => {
            const message = { payload, edits: [], edit: async (p) => { message.edits.push(p); }, createMessageComponentCollector: (o) => collector(collectors.buttons, o) };
            sent.push(message);
            return message;
        },
        createMessageCollector: (o) => collector(collectors.text, o),
    };
    return dm;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('wizard buttons: Skip and Stop setup per question (collector-managed IDs, one nonce); greyed out once answered', () => {
    const row = stepButtons('ab12').toJSON();
    assert.deepEqual(row.components.map((b) => [b.custom_id, b.label, Boolean(b.disabled)]), [
        [`${STEP_BUTTON_PREFIX}:skip:ab12`, 'Skip (keep current)', false], [`${STEP_BUTTON_PREFIX}:cancel:ab12`, 'Stop setup', false]]);
    assert.ok(isCollectorManagedComponent(`${STEP_BUTTON_PREFIX}:skip:ab12`.split(':')[0]), 'a late press gets the "expired" answer, not an error');
    assert.ok(stepButtons('ab12', { disabled: true }).toJSON().components.every((b) => b.disabled));
});

test('wizard: Skip is acknowledged within the press and skips; Stop setup cancels; typed answers still work; only this user and this question', async () => {
    const dm = fakeDm();
    const pending = askQuestion(dm, USER, 'What prefix?', 1, 3, { nonce: 'n1', timeMs: 5000 });
    await tick();
    const [question] = dm.sent;
    assert.equal(question.payload.components[0].toJSON().components.length, 2);
    assert.deepEqual(question.payload.allowedMentions, { parse: [] });
    const filter = dm.collectors.buttons[0].options.filter;
    assert.equal(filter({ user: { id: '1' }, customId: `${STEP_BUTTON_PREFIX}:skip:n1` }), false, 'someone else');
    assert.equal(filter({ user: { id: USER }, customId: `${STEP_BUTTON_PREFIX}:skip:old` }), false, 'an older question');
    const acks = [];
    dm.collectors.buttons[0].emit('collect', { user: { id: USER }, customId: `${STEP_BUTTON_PREFIX}:skip:n1`, deferUpdate: async () => { acks.push('ack'); } });
    assert.deepEqual(await pending, { skipped: true });
    assert.deepEqual(acks, ['ack']);
    assert.equal(dm.collectors.text[0].stopped, 'answered', 'the message wait ends too');
    assert.ok(question.edits[0].components[0].toJSON().components.every((b) => b.disabled), 'buttons greyed out');

    const stop = fakeDm();
    const stopping = askQuestion(stop, USER, 'Q', 1, 3, { nonce: 'n2', timeMs: 5000 });
    await tick();
    stop.collectors.buttons[0].emit('collect', { user: { id: USER }, customId: `${STEP_BUTTON_PREFIX}:cancel:n2`, deferUpdate: async () => {} });
    assert.deepEqual(await stopping, { cancelled: true });
    assert.match(JSON.stringify(stop.sent[1].payload.embeds), /Setup cancelled/);

    const typed = fakeDm();
    const typing = askQuestion(typed, USER, 'Q', 1, 3, { nonce: 'n3', timeMs: 5000 });
    await tick();
    assert.equal(typed.collectors.text[0].options.filter({ author: { id: USER, bot: false } }), true);
    assert.equal(typed.collectors.text[0].options.filter({ author: { id: '1', bot: false } }), false);
    typed.collectors.text[0].emit('collect', { content: '  !! ' });
    assert.deepEqual(await typing, { answer: '!!' });
    for (const [word, expected] of [['skip', { skipped: true }], ['Cancel', { cancelled: true }]]) {
        const old = fakeDm();
        const p = askQuestion(old, USER, 'Q', 1, 3, { nonce: 'n4', timeMs: 5000 });
        await tick();
        old.collectors.text[0].emit('collect', { content: word });
        assert.deepEqual(await p, expected, word);
    }
});

test('wizard: no answer in time → null and a "did not answer" DM', async () => {
    const dm = fakeDm();
    const pending = askQuestion(dm, USER, 'Q', 1, 3, { nonce: 'n5', timeMs: 5000 });
    await tick();
    dm.collectors.text[0].stop('time');
    assert.equal(await pending, null);
    assert.match(JSON.stringify(dm.sent[1].payload.embeds), /did not answer in time/);
    // waitForAnswer without a message (no buttons) still answers typed text.
    const bare = fakeDm();
    const p = waitForAnswer({ dmChannel: bare, message: null, userId: USER, nonce: 'x', timeMs: 5000 });
    bare.collectors.text[0].emit('collect', { content: 'hi' });
    assert.deepEqual(await p, { text: 'hi' });
});

test('wizard: the Administrator re-check before saving (member fetched fresh; gone or demoted → not allowed)', async () => {
    const guild = (perms, present = true) => ({
        ownerId: '999999999999999990',
        members: { cache: new Map(), fetch: async () => (present ? { permissions: { has: (f) => perms.includes(f) } } : null) },
    });
    assert.equal(await stillAllowed(guild([PermissionFlagsBits.Administrator]), USER), true);
    assert.equal(await stillAllowed(guild([PermissionFlagsBits.ManageGuild]), USER), false);
    assert.equal(await stillAllowed(guild([], false), USER), false);
    assert.equal(await stillAllowed({ ...guild([]), ownerId: USER }, USER), true, 'the server owner');
});
