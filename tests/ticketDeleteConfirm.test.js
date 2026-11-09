// /ticket dashboard → Delete system: Confirm / Cancel buttons instead of the "Type DELETE"
// modal. Fake interactions: the click is acked at once, the clicker's permission is
// checked again on the click, other users' clicks do not count, and the buttons expire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, ComponentType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { askTicketDeleteConfirm, canDeleteTicketSystem, TICKET_DELETE_CONFIRM_MS } from '../src/commands/Ticket/modules/ticket_dashboard.js';

const ADMIN = '200000000000000002';
const OTHER = '200000000000000009';

/** A Delete system button press; `clicks` are offered to the collector filter in order. */
function pressDelete({ clicks = [] } = {}) {
    const log = [];
    let waited = null;
    const prompt = {
        async awaitMessageComponent({ filter, time, componentType }) {
            waited = { time, componentType };
            for (const make of clicks) {
                const click = make(log);
                if (filter(click)) return click;
            }
            throw new Error('Collector received no interactions before ending with reason: time');
        },
    };
    const btn = {
        user: { id: ADMIN },
        async reply(payload) { log.push(['reply', payload]); },
        async fetchReply() { return prompt; },
        async editReply(payload) { log.push(['btn.editReply', payload]); },
    };
    return { btn, log, waited: () => waited };
}

/** A click on one of the prompt's buttons (index 0 = Delete, 1 = Cancel). */
function click(log, { index, userId = ADMIN, admin = true }) {
    const reply = log.find(([kind]) => kind === 'reply')[1];
    const id = reply.components[0].components[index].data.custom_id;
    return {
        customId: id, user: { id: userId }, guild: { ownerId: '999999999999999990' },
        memberPermissions: { has: (bit) => admin && bit === PermissionFlagsBits.Administrator },
        async deferUpdate() { log.push(['deferUpdate', id]); },
        async editReply(payload) { log.push(['click.editReply', payload]); },
    };
}

const titleOf = (payload) => payload.embeds[0].data.title;

test('Delete system asks with Delete (danger) / Cancel buttons in an ephemeral reply, no modal, no mentions', async () => {
    const { btn, log, waited } = pressDelete();
    await askTicketDeleteConfirm(btn, { timeoutMs: 5 });
    const [kind, reply] = log[0];
    assert.equal(kind, 'reply');
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    const [yes, no] = reply.components[0].components.map((b) => b.data);
    assert.equal(yes.label, 'Delete ticket system');
    assert.equal(yes.style, ButtonStyle.Danger);
    assert.equal(no.label, 'Cancel');
    assert.equal(no.style, ButtonStyle.Secondary);
    assert.notEqual(yes.custom_id, no.custom_id);
    assert.ok(!yes.custom_id.includes(':'), 'collector-managed id (no global handler)');
    assert.match(reply.embeds[0].data.description, /cannot be undone/);
    assert.equal(waited().componentType, ComponentType.Button);
    assert.equal(TICKET_DELETE_CONFIRM_MS, 60_000);
});

test('Confirm by the same Administrator: acked first, then outcome confirm', async () => {
    const { btn, log } = pressDelete({ clicks: [(l) => click(l, { index: 0 })] });
    const result = await askTicketDeleteConfirm(btn);
    assert.equal(result.outcome, 'confirm');
    assert.equal(log[1][0], 'deferUpdate', 'acknowledged before anything else');
    assert.ok(result.interaction, 'the caller edits this reply with the result');
});

test('Cancel: acked, "Nothing was deleted", buttons removed', async () => {
    const { btn, log } = pressDelete({ clicks: [(l) => click(l, { index: 1 })] });
    const result = await askTicketDeleteConfirm(btn);
    assert.equal(result.outcome, 'cancel');
    const [, payload] = log.find(([kind]) => kind === 'click.editReply');
    assert.equal(titleOf(payload), 'Cancelled');
    assert.match(payload.embeds[0].data.description, /Nothing was deleted/);
    assert.deepEqual(payload.components, []);
});

test('the permission is checked again on the click: lost Administrator → denied, nothing deleted', async () => {
    const { btn, log } = pressDelete({ clicks: [(l) => click(l, { index: 0, admin: false })] });
    const result = await askTicketDeleteConfirm(btn);
    assert.equal(result.outcome, 'denied');
    assert.equal(log[1][0], 'deferUpdate');
    const [, payload] = log.find(([kind]) => kind === 'click.editReply');
    assert.match(payload.embeds[0].data.description, /Only server admins[\s\S]*Nothing was deleted/);
    assert.deepEqual(payload.components, []);
    assert.equal(canDeleteTicketSystem({ user: { id: ADMIN }, guild: { ownerId: ADMIN }, memberPermissions: { has: () => false } }), true, 'the server owner counts');
});

test('another user\'s click does not count; with no valid click the buttons expire with a clear message', async () => {
    const { btn, log, waited } = pressDelete({ clicks: [(l) => click(l, { index: 0, userId: OTHER })] });
    const result = await askTicketDeleteConfirm(btn, { timeoutMs: 1234 });
    assert.equal(result.outcome, 'expired');
    assert.equal(waited().time, 1234);
    assert.ok(!log.some(([kind]) => kind === 'deferUpdate'), 'the other user\'s click was filtered out');
    const [, payload] = log.find(([kind]) => kind === 'btn.editReply');
    assert.equal(titleOf(payload), 'Confirmation expired');
    assert.match(payload.embeds[0].data.description, /Nothing was deleted/);
    assert.deepEqual(payload.components, [], 'expired buttons are removed');
});
