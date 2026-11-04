// /cooldown: a member puts themselves in a Discord timeout. Fake guild/member objects;
// nothing reaches Discord, nothing touches the database.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const { checkCommandAccess } = await import('../src/utils/commandGate.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');
const { EVERYONE_COMMANDS, hasEveryoneAccess } = await import('../src/config/commands/commandAccess.js');
const { commandEntries, retireCommandJson } = await import('../src/config/commands/retirement.js');
const { EVENT_TYPES, isEventEnabled } = await import('../src/services/loggingService.js');
const { EVENT_TYPES_BY_CATEGORY } = await import('../src/utils/logging/loggingUi.js');
const { default: cooldown } = await import('../src/commands/Utility/cooldown.js');
const { default: button } = await import('../src/interactions/buttons/cooldown/selfCooldown.js');
const svc = await import('../src/services/members/selfCooldownService.js');

const GUILD_ID = enforcementConfig.mainGuildId;
const USER = '300000000000000001';
const OTHER = '300000000000000002';

beforeEach(() => svc.resetSelfCooldownState());

function perms(...bits) {
    return { has: (bit) => bits.includes(bit) };
}

function makeMember({ id = USER, position = 1, admin = false, until = null } = {}) {
    const calls = [];
    return {
        id, user: { id, tag: 'member#0001' },
        permissions: perms(...(admin ? [PermissionFlagsBits.Administrator] : [])),
        roles: { highest: { position } },
        communicationDisabledUntilTimestamp: until,
        calls,
        async timeout(ms, reason) { calls.push({ ms, reason }); return this; },
    };
}

function makeGuild({ member = makeMember(), ownerId = '999', botPosition = 5, botPerms = [PermissionFlagsBits.ModerateMembers] } = {}) {
    return {
        id: GUILD_ID, ownerId,
        members: {
            me: { id: 'bot', permissions: perms(...botPerms), roles: { highest: { position: botPosition } } },
            async fetch(id) { if (id === member.id) return member; throw new Error('Unknown Member'); },
        },
    };
}

function makeCommandInteraction({ guild = makeGuild(), member, values = { duration: '6h' }, inGuild = true } = {}) {
    const replies = [];
    const interaction = {
        id: '1', deferred: false, replied: false, createdTimestamp: Date.now(),
        user: { id: USER, tag: 'member#0001' }, guildId: inGuild ? guild.id : null, guild: inGuild ? guild : null,
        member: inGuild ? (member ?? null) : null,
        inGuild: () => inGuild,
        options: { getString: (name) => values[name] ?? null },
        async reply(payload) { replies.push(payload); interaction.replied = true; return {}; },
        async editReply(payload) { replies.push(payload); return {}; },
        async followUp(payload) { replies.push(payload); return {}; },
    };
    return { interaction, replies };
}

function makeButtonInteraction({ guild, clicker = USER }) {
    const events = [];
    const interaction = {
        user: { id: clicker }, guildId: guild.id, guild,
        async reply(payload) { events.push(['reply', payload]); },
        async deferUpdate() { events.push(['deferUpdate']); },
        async editReply(payload) { events.push(['editReply', payload]); },
    };
    return { interaction, events };
}

const text = (payload) => payload.embeds?.[0]?.data?.description || payload.content || '';

// ---- access ----

test('access: a non-admin may run /cooldown; it is in the everyone list and /help sees it', () => {
    assert.ok(EVERYONE_COMMANDS.has('cooldown'));
    assert.ok(hasEveryoneAccess('cooldown'));
    const result = checkCommandAccess({
        command: {}, accessKey: 'cooldown', guild: { id: GUILD_ID, ownerId: 'owner' }, userId: USER, permissions: perms(),
    });
    assert.equal(result.allowed, true);
});

test('access: in DMs the gate refuses before the command runs', () => {
    const result = checkCommandAccess({ command: {}, accessKey: 'cooldown', guild: null, userId: USER, permissions: null });
    assert.equal(result.allowed, false);
});

test('retired admin commands: /cooldown stays registered and is listed as an everyone-command', () => {
    const json = cooldown.data.toJSON();
    assert.deepEqual(retireCommandJson(json), json);
    const [entry] = commandEntries(new Map([['cooldown', cooldown]]));
    assert.equal(entry.key, 'cooldown');
    assert.equal(entry.access, 'everyone');
    assert.equal(entry.page, null);
});

test('command shape: six durations, optional reason up to 200 characters', () => {
    const json = cooldown.data.toJSON();
    assert.equal(json.name, 'cooldown');
    assert.equal(json.default_member_permissions ?? null, null, 'stays visible to everyone');
    const [duration, reason] = json.options;
    assert.equal(duration.required, true);
    assert.deepEqual(duration.choices.map((c) => c.name), ['1 hour', '6 hours', '12 hours', '1 day', '3 days', '7 days']);
    assert.equal(reason.required, false);
    assert.equal(reason.max_length, 200);
});

// ---- command: confirm prompt and refusals ----

test('/cooldown: shows a private confirm prompt with Start/Cancel carrying the invoker id', async () => {
    const member = makeMember();
    const { interaction, replies } = makeCommandInteraction({ guild: makeGuild({ member }), member });
    await cooldown.execute(interaction);
    const payload = replies[0];
    assert.equal(payload.flags, MessageFlags.Ephemeral);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.match(text(payload), /You won't be able to send messages, react, or join voice until <t:\d+:F> \(<t:\d+:R>\)/);
    assert.match(text(payload), /You can't end it early: \/cooldown has no undo and Mewvo has no command to end it/);
    const ids = payload.components[0].components.map((c) => c.data.custom_id);
    assert.match(ids[0], new RegExp(`^selfcooldown:start:${USER}:[0-9a-f]{12}$`));
    assert.match(ids[1], new RegExp(`^selfcooldown:cancel:${USER}:[0-9a-f]{12}$`));
    assert.equal(member.calls.length, 0, 'nothing applied before confirming');
});

const refusals = [
    ['server owner', () => { const m = makeMember(); return { member: m, guild: makeGuild({ member: m, ownerId: USER }) }; }, /own this server/],
    ['Administrator', () => { const m = makeMember({ admin: true }); return { member: m, guild: makeGuild({ member: m }) }; }, /Administrator permission/],
    ['role above the bot', () => { const m = makeMember({ position: 9 }); return { member: m, guild: makeGuild({ member: m }) }; }, /because your role is above mine/],
    ['role equal to the bot', () => { const m = makeMember({ position: 5 }); return { member: m, guild: makeGuild({ member: m }) }; }, /because your role is above mine/],
    ['bot lacks Moderate Members', () => { const m = makeMember(); return { member: m, guild: makeGuild({ member: m, botPerms: [] }) }; }, /Timeout Members permission/],
    ['already timed out', () => { const m = makeMember({ until: Date.now() + 3600_000 }); return { member: m, guild: makeGuild({ member: m }) }; }, /already in a timeout until <t:\d+:F>/],
];

for (const [name, setup, pattern] of refusals) {
    test(`/cooldown refuses (${name}): clear message, no prompt, no timeout`, async () => {
        const { member, guild } = setup();
        const { interaction, replies } = makeCommandInteraction({ guild, member });
        await cooldown.execute(interaction);
        assert.match(text(replies[0]), pattern);
        assert.deepEqual(replies[0].components, []);
        assert.equal(replies[0].flags, MessageFlags.Ephemeral);
        assert.equal(member.calls.length, 0);
    });
}

test('/cooldown in DMs: refused, nothing applied', async () => {
    const { interaction, replies } = makeCommandInteraction({ inGuild: false });
    await cooldown.execute(interaction);
    assert.match(text(replies[0]), /only works in a server/);
});

test('/cooldown: an expired old timeout does not block a new cooldown', async () => {
    const member = makeMember({ until: Date.now() - 1000 });
    const { interaction, replies } = makeCommandInteraction({ guild: makeGuild({ member }), member });
    await cooldown.execute(interaction);
    assert.equal(replies[0].components.length, 1);
});

// ---- button: confirm ----

function promptFor(guild, overrides = {}) {
    return svc.createPrompt({ userId: USER, guildId: guild.id, durationKey: '6h', reason: 'arguing too much', ...overrides });
}

test('Start: applies the timeout once with the right ms and reason, logs it, replaces the prompt', async () => {
    const member = makeMember();
    const guild = makeGuild({ member });
    const nonce = promptFor(guild);
    const logged = [];
    const apply = (params) => svc.applySelfCooldown({ ...params, log: async (entry) => { logged.push(entry); } });
    const { interaction, events } = makeButtonInteraction({ guild });
    await button.execute(interaction, {}, ['start', USER, nonce], { apply });
    assert.equal(events[0][0], 'deferUpdate', 'acknowledged first');
    assert.deepEqual(member.calls, [{ ms: 6 * 60 * 60 * 1000, reason: 'Self-cooldown via /cooldown: arguing too much' }]);
    const final = events.at(-1)[1];
    assert.match(text(final), /6 hours cooldown has started\. It ends on its own <t:\d+:F>/);
    assert.deepEqual(final.components, []);
    assert.deepEqual(final.allowedMentions, { parse: [] });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].eventType, 'member.selfcooldown');
    assert.equal(logged[0].guildId, GUILD_ID);
    assert.equal(logged[0].data.userId, USER);
    assert.match(logged[0].data.lines.join('\n'), /Not a moderation case/);

    // Double click: the prompt is used up.
    const again = makeButtonInteraction({ guild });
    await button.execute(again.interaction, {}, ['start', USER, nonce], { apply });
    assert.equal(text(again.events.at(-1)[1]), svc.EXPIRED_MESSAGE);
    assert.equal(member.calls.length, 1);
});

test('Start without a reason: the audit log reason says only that it was a self-cooldown', async () => {
    const member = makeMember();
    await svc.applySelfCooldown({ client: {}, guild: makeGuild({ member }), member, durationKey: '7d', reason: null, log: async () => {} });
    assert.deepEqual(member.calls, [{ ms: 7 * 24 * 60 * 60 * 1000, reason: 'Self-cooldown via /cooldown' }]);
});

test('a click by someone else is rejected and does not use up the prompt', async () => {
    const member = makeMember();
    const guild = makeGuild({ member });
    const nonce = promptFor(guild);
    const { interaction, events } = makeButtonInteraction({ guild, clicker: OTHER });
    let applied = 0;
    await button.execute(interaction, {}, ['start', USER, nonce], { apply: async () => { applied += 1; return { until: Date.now() }; } });
    assert.equal(events[0][0], 'reply');
    assert.match(events[0][1].content, /not for you/);
    assert.equal(events[0][1].flags, MessageFlags.Ephemeral);
    assert.equal(applied, 0);
    assert.ok(svc.takePrompt(nonce), 'the owner can still use it');
});

test('an expired prompt (over 5 minutes) says to run /cooldown again', async () => {
    const member = makeMember();
    const guild = makeGuild({ member });
    const nonce = svc.createPrompt({ userId: USER, guildId: guild.id, durationKey: '1h', reason: null }, Date.now() - svc.PROMPT_TTL_MS - 1);
    const { interaction, events } = makeButtonInteraction({ guild });
    await button.execute(interaction, {}, ['start', USER, nonce]);
    assert.equal(text(events.at(-1)[1]), 'This expired, run /cooldown again.');
    assert.equal(member.calls.length, 0);
});

test('Cancel: nothing applied, the prompt is gone', async () => {
    const member = makeMember();
    const guild = makeGuild({ member });
    const nonce = promptFor(guild);
    const { interaction, events } = makeButtonInteraction({ guild });
    await button.execute(interaction, {}, ['cancel', USER, nonce]);
    assert.match(text(events.at(-1)[1]), /No cooldown was started/);
    assert.equal(member.calls.length, 0);
    assert.equal(svc.takePrompt(nonce), null);
});

test('Start re-checks eligibility: timed out meanwhile → refused, nothing applied', async () => {
    const member = makeMember();
    const guild = makeGuild({ member });
    const nonce = promptFor(guild);
    member.communicationDisabledUntilTimestamp = Date.now() + 60_000;
    const { interaction, events } = makeButtonInteraction({ guild });
    await button.execute(interaction, {}, ['start', USER, nonce]);
    assert.match(text(events.at(-1)[1]), /already in a timeout[\s\S]*No cooldown was started/);
    assert.equal(member.calls.length, 0);
});

test('Discord refusing the timeout: error shown, the use is not counted', async () => {
    const member = makeMember();
    member.timeout = async () => { throw new Error('Missing Permissions'); };
    const guild = makeGuild({ member });
    const nonce = promptFor(guild);
    const { interaction, events } = makeButtonInteraction({ guild });
    await button.execute(interaction, {}, ['start', USER, nonce], { apply: (p) => svc.applySelfCooldown({ ...p, log: async () => {} }) });
    assert.match(text(events.at(-1)[1]), /Discord refused the timeout/);
    assert.equal(svc.checkLimit(GUILD_ID, USER), null);
});

test('two Start clicks at once (two prompts): only one timeout is applied', async () => {
    const member = makeMember();
    const guild = makeGuild({ member });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let applied = 0;
    const apply = async () => { applied += 1; await gate; return { until: Date.now() + 3600_000 }; };
    const first = makeButtonInteraction({ guild });
    const second = makeButtonInteraction({ guild });
    const running = button.execute(first.interaction, {}, ['start', USER, promptFor(guild)], { apply });
    await new Promise((resolve) => setImmediate(resolve));
    await button.execute(second.interaction, {}, ['start', USER, promptFor(guild)], { apply });
    assert.match(text(second.events.at(-1)[1]), /already being started/);
    release();
    await running;
    assert.equal(applied, 1);
    assert.match(text(first.events.at(-1)[1]), /cooldown has started/);
});

// ---- abuse guard ----

test('limit: 3 cooldowns per member per 24 h, then refused until the oldest falls out', async () => {
    const t0 = Date.now() - 1000;
    for (let i = 0; i < 3; i += 1) svc.recordUse(GUILD_ID, USER, t0 + i);
    const limited = svc.checkLimit(GUILD_ID, USER, t0 + 10);
    assert.equal(limited.nextAt, t0 + svc.LIMIT_WINDOW_MS);
    assert.equal(svc.checkLimit(GUILD_ID, OTHER, t0 + 10), null, 'per member');

    const member = makeMember();
    const guild = makeGuild({ member });
    const cmd = makeCommandInteraction({ guild, member });
    await cooldown.execute(cmd.interaction);
    assert.match(text(cmd.replies[0]), /started 3 cooldowns in the last 24 hours/);
    assert.deepEqual(cmd.replies[0].components, []);

    const nonce = promptFor(guild);
    const { interaction, events } = makeButtonInteraction({ guild });
    await button.execute(interaction, {}, ['start', USER, nonce]);
    assert.match(text(events.at(-1)[1]), /started 3 cooldowns/);
    assert.equal(member.calls.length, 0);

    // A day after the oldest one, a new cooldown is allowed again.
    assert.equal(svc.checkLimit(GUILD_ID, USER, t0 + svc.LIMIT_WINDOW_MS + 1), null);
});

test('limit: each successful Start counts', async () => {
    const member = makeMember();
    const guild = makeGuild({ member });
    const apply = (p) => svc.applySelfCooldown({ ...p, log: async () => {} });
    for (let i = 0; i < 3; i += 1) {
        member.communicationDisabledUntilTimestamp = null;
        const { interaction } = makeButtonInteraction({ guild });
        await button.execute(interaction, {}, ['start', USER, promptFor(guild)], { apply });
    }
    assert.equal(member.calls.length, 3);
    assert.ok(svc.checkLimit(GUILD_ID, USER));
});

// ---- logging and "not a case" ----

test('logging: member.selfcooldown is a declared event type in the Members category, on by default', () => {
    assert.equal(EVENT_TYPES.MEMBER_SELF_COOLDOWN, 'member.selfcooldown');
    assert.ok(EVENT_TYPES_BY_CATEGORY.member.includes('member.selfcooldown'));
    assert.equal(isEventEnabled({ logging: { enabled: true, enabledEvents: {} } }, 'member.selfcooldown'), true);
    assert.equal(isEventEnabled({ logging: { enabled: true, enabledEvents: { 'member.*': false } } }, 'member.selfcooldown'), false);
});

test('not a case: the cooldown code does not touch enforcement (cases, ladder, DMs, mass-action guard)', () => {
    for (const file of ['../src/services/members/selfCooldownService.js', '../src/commands/Utility/cooldown.js', '../src/interactions/buttons/cooldown/selfCooldown.js']) {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.ok(!/services\/enforcement|enforcement\//.test(source), `${file} imports enforcement`);
        assert.ok(!/mod_cases|logModerationAction|massAction|\.send\(/.test(source), file);
    }
});
