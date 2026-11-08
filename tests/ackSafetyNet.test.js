import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
    armAckSafetyNet,
    autoAckDelayMs,
    modalFallbackDelayMs,
    opensModal,
    safetyNetKey,
    resetSafetyNetLog,
    getSlowHandlerStats,
    interactionsAreWarm,
    markInteractionsWarm,
    resetInteractionsWarm,
    MODAL_TOO_LATE_MESSAGE,
    AUTO_ACK_AFTER_MS,
} from '../src/utils/ackSafetyNet.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

// A fake interaction with discord.js's acknowledgement rules (InteractionResponses.js):
// a second acknowledgement throws, editReply/followUp need one first.
function fakeInteraction({ kind = 'command', createdTimestamp = Date.now(), fromMessage = true } = {}) {
    const calls = [];
    let seq = 0;
    const alreadyAcked = () => Object.assign(new Error('already acknowledged'), { name: 'InteractionAlreadyReplied', code: 'InteractionAlreadyReplied' });
    const notReplied = () => Object.assign(new Error('not replied'), { name: 'InteractionNotReplied' });
    const i = {
        id: 'i1',
        user: { id: 'u1' },
        guildId: 'g1',
        createdTimestamp,
        commandName: 'ticket',
        customId: 'enf:act:1:2',
        deferred: false,
        replied: false,
        ephemeral: null,
        calls,
        options: { getSubcommandGroup: () => null, getSubcommand: () => 'create' },
        isChatInputCommand: () => kind === 'command',
        isContextMenuCommand: () => false,
        isMessageComponent: () => kind === 'button' || kind === 'select',
        isButton: () => kind === 'button',
        isAnySelectMenu: () => kind === 'select',
        isModalSubmit: () => kind === 'modal',
        isFromMessage: () => kind === 'modal' && fromMessage,
        async deferReply(options = {}) {
            if (this.deferred || this.replied) throw alreadyAcked();
            calls.push(['deferReply', options]);
            this.deferred = true;
            this.ephemeral = Boolean((options.flags ?? 0) & MessageFlags.Ephemeral);
        },
        async deferUpdate() {
            if (this.deferred || this.replied) throw alreadyAcked();
            calls.push(['deferUpdate']);
            this.deferred = true;
        },
        async reply(options) {
            if (this.deferred || this.replied) throw alreadyAcked();
            calls.push(['reply', options]);
            this.replied = true;
            this.ephemeral = Boolean((options?.flags ?? 0) & MessageFlags.Ephemeral);
        },
        async update(options) {
            if (this.deferred || this.replied) throw alreadyAcked();
            calls.push(['update', options]);
            this.replied = true;
        },
        async showModal(modal) {
            if (this.deferred || this.replied) throw alreadyAcked();
            calls.push(['showModal', modal]);
            this.replied = true;
        },
        async editReply(options) {
            if (!this.deferred && !this.replied) throw notReplied();
            calls.push(['editReply', options]);
            this.replied = true;
            return { id: options?.message ?? '@original' };
        },
        async followUp(options) {
            if (!this.deferred && !this.replied) throw notReplied();
            seq += 1;
            calls.push(['followUp', options]);
            this.replied = true;
            return { id: `f${seq}` };
        },
        async deleteReply(message = '@original') {
            calls.push(['deleteReply', message]);
        },
        async fetchReply(message = '@original') {
            calls.push(['fetchReply', message]);
            return { id: message };
        },
    };
    return i;
}

// A manual timer: tick() runs the pending callback, so tests don't sleep.
function manualTimer() {
    const timers = [];
    return {
        timers,
        setTimer: (fn, ms) => {
            const t = { fn, ms, cleared: false };
            timers.push(t);
            return t;
        },
        clearTimer: (t) => {
            if (t) t.cleared = true;
        },
        async fire() {
            const t = timers.find((x) => !x.cleared && !x.ran);
            if (!t) return false;
            t.ran = true;
            t.fn();
            await new Promise((r) => setImmediate(r));
            return true;
        },
    };
}

const quietLog = () => {
    const lines = [];
    return { lines, warn: (msg) => lines.push(msg), error: (msg) => lines.push(msg) };
};

function setup(kind, extra = {}) {
    const interaction = fakeInteraction({ kind, ...extra.interaction });
    InteractionHelper.patchInteractionResponses(interaction);
    const timer = manualTimer();
    const log = quietLog();
    const net = armAckSafetyNet(interaction, { setTimer: timer.setTimer, clearTimer: timer.clearTimer, log, ...extra.net });
    return { interaction, timer, log, net };
}

beforeEach(() => resetSafetyNetLog());

test('the auto-ack is scheduled at the threshold, not before', () => {
    const { timer } = setup('command');
    assert.equal(timer.timers.length, 1);
    assert.equal(timer.timers[0].ms, AUTO_ACK_AFTER_MS);
    // A late arrival is acked sooner, but never sooner than 250 ms after receipt.
    const now = 10_000;
    assert.equal(autoAckDelayMs({ createdTimestamp: now - 1000 }, { now: () => now }), 1500);
    assert.equal(autoAckDelayMs({ createdTimestamp: now - 2900 }, { now: () => now }), 250);
    assert.equal(autoAckDelayMs({ createdTimestamp: now + 5000 }, { now: () => now }), AUTO_ACK_AFTER_MS);
});

test('a fast handler is never auto-acked (no timer fires after disarm)', async () => {
    const { interaction, timer, net } = setup('command');
    await interaction.reply({ content: 'hi' });
    net.disarm();
    assert.equal(timer.timers[0].cleared, true);
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['reply']);
});

test('a slow command is deferred ephemerally once, and its reply becomes editReply (no double ack)', async () => {
    const { interaction, timer, net, log } = setup('command');
    await timer.fire();
    assert.deepEqual(interaction.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
    // The handler, unaware, defers and replies itself.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.reply({ content: 'done', flags: MessageFlags.Ephemeral });
    net.disarm();
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferReply', 'editReply']);
    assert.equal(interaction.calls[1][1].content, 'done');
    assert.equal(interaction.calls[1][1].flags, undefined);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /Slow handler: \/ticket create needed the 3-second safety net/);
});

test('a handler acking itself just before the timer means the net stays out', async () => {
    const { interaction, timer } = setup('button');
    const pending = interaction.deferUpdate();
    await timer.fire();
    await pending;
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferUpdate']);
});

test('a slow button: update() becomes editReply of the message', async () => {
    const { interaction, timer } = setup('button');
    await timer.fire();
    await interaction.update({ content: 'panel', components: [] });
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferUpdate', 'editReply']);
    assert.equal(interaction.calls[1][1].message, undefined);
});

test('a slow button: an ephemeral reply is a follow-up, and later edits edit that follow-up (not the panel)', async () => {
    const { interaction, timer } = setup('button');
    await timer.fire();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ content: 'step 1' });
    await interaction.editReply({ content: 'step 2' });
    const names = interaction.calls.map((c) => c[0]);
    assert.deepEqual(names, ['deferUpdate', 'followUp', 'editReply']);
    assert.equal(interaction.calls[1][1].flags, MessageFlags.Ephemeral);
    assert.equal(interaction.calls[2][1].message, 'f1');
});

test('safeReply after an auto deferUpdate sends a follow-up instead of overwriting the panel', async () => {
    const { interaction, timer } = setup('button');
    await timer.fire();
    const ok = await InteractionHelper.safeReply(interaction, { content: 'nope', flags: MessageFlags.Ephemeral });
    assert.equal(ok, true);
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferUpdate', 'followUp']);
    assert.equal(interaction.calls[1][1].flags, MessageFlags.Ephemeral);
});

test('safeReply after an auto deferReply edits the deferred reply', async () => {
    const { interaction, timer } = setup('command');
    await timer.fire();
    const ok = await InteractionHelper.safeReply(interaction, { content: 'result', flags: MessageFlags.Ephemeral });
    assert.equal(ok, true);
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferReply', 'editReply']);
});

test('safeDefer + safeEditReply after the auto-ack: no second defer, the edit lands', async () => {
    const { interaction, timer } = setup('command');
    await timer.fire();
    assert.equal(await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral }), true);
    assert.equal(await InteractionHelper.safeEditReply(interaction, { content: 'x' }), true);
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferReply', 'editReply']);
});

test('a reply racing the in-flight auto-ack waits for it and becomes an edit', async () => {
    const { interaction, timer } = setup('command');
    const t = timer.timers[0];
    t.ran = true;
    t.fn(); // auto deferReply now in flight
    await interaction.reply({ content: 'late' });
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferReply', 'editReply']);
});

test('modal paths are exempt: the normal timer is not armed, only the last-moment fallback', async () => {
    const { interaction, timer } = setup('button', { net: { exempt: true } });
    assert.equal(timer.timers.length, 1);
    assert.equal(timer.timers[0].ms, 2600);
    await interaction.showModal({ title: 'form' });
    await timer.fire();
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['showModal']);
    const now = 10_000;
    assert.equal(modalFallbackDelayMs({ createdTimestamp: now - 1000 }, { now: () => now }), 1700);
});

test('a modal path that is far too slow gets "try again" instead of "did not respond"', async () => {
    const { interaction, timer, log } = setup('button', { net: { exempt: true } });
    await timer.fire();
    await interaction.showModal({ title: 'form' });
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferUpdate', 'followUp']);
    assert.equal(interaction.calls[1][1].content, MODAL_TOO_LATE_MESSAGE);
    assert.ok(log.lines.some((l) => /opened a form after the auto-acknowledgement/.test(l)));
});

test('opensModal reads true, a predicate, or nothing', () => {
    assert.equal(opensModal({ opensModal: true }, {}), true);
    assert.equal(opensModal({ opensModal: (i, [step]) => step === 'open' }, {}, ['open']), true);
    assert.equal(opensModal({ opensModal: (i, [step]) => step === 'open' }, {}, ['status']), false);
    assert.equal(opensModal({}, {}), false);
    assert.equal(opensModal(null, {}), false);
});

test('slow handlers are logged once per key per hour, and counted every time', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const log = quietLog();
    for (let n = 0; n < 3; n += 1) {
        const interaction = fakeInteraction({ kind: 'command', createdTimestamp: clock });
        InteractionHelper.patchInteractionResponses(interaction);
        const timer = manualTimer();
        const net = armAckSafetyNet(interaction, { setTimer: timer.setTimer, clearTimer: timer.clearTimer, log, now });
        clock += 2000;
        await timer.fire();
        clock += 1500;
        net.disarm();
    }
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /auto-acknowledged after 2000 ms, finished after 3500 ms/);
    assert.equal(getSlowHandlerStats()[0].count, 3);
    clock += 60 * 60 * 1000;
    const interaction = fakeInteraction({ kind: 'command', createdTimestamp: clock });
    InteractionHelper.patchInteractionResponses(interaction);
    const timer = manualTimer();
    const net = armAckSafetyNet(interaction, { setTimer: timer.setTimer, clearTimer: timer.clearTimer, log, now });
    await timer.fire();
    net.disarm();
    assert.equal(log.lines.length, 2);
});

test('an expired interaction (10062) is not retried and the handler still sees it unacked', async () => {
    const interaction = fakeInteraction({ kind: 'command' });
    interaction.deferReply = async () => {
        throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
    };
    InteractionHelper.patchInteractionResponses(interaction);
    const timer = manualTimer();
    const net = armAckSafetyNet(interaction, { setTimer: timer.setTimer, clearTimer: timer.clearTimer, log: quietLog() });
    await timer.fire();
    assert.equal(net.expired, true);
    assert.equal(net.autoAcked, false);
});

test('startup: fireNow acks at once', async () => {
    const { interaction, net } = setup('select');
    await net.fireNow('startup');
    assert.deepEqual(interaction.calls.map((c) => c[0]), ['deferUpdate']);
});

test('warm only after ready + startup caches, and while the database is not known down', () => {
    resetInteractionsWarm();
    const client = { isReady: () => true, db: { isAvailable: () => true } };
    assert.equal(interactionsAreWarm(client), false);
    markInteractionsWarm();
    assert.equal(interactionsAreWarm(client), true);
    assert.equal(interactionsAreWarm({ ...client, isReady: () => false }), false);
    assert.equal(interactionsAreWarm({ ...client, db: { isAvailable: () => false } }), false);
});

test('handler keys name the command and subcommand, or the component prefix and step', () => {
    assert.equal(safetyNetKey(fakeInteraction({ kind: 'command' })), '/ticket create');
    assert.equal(safetyNetKey(fakeInteraction({ kind: 'button' })), 'button enf:act');
    const numeric = fakeInteraction({ kind: 'button' });
    numeric.customId = 'appeal:123456789012345678';
    assert.equal(safetyNetKey(numeric), 'button appeal');
});
