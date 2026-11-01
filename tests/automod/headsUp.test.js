// Heads-up first (services/automod/headsUp.js + automodService.actOn / runHeadsUpChecks):
// which rules get one, the DM / channel notice instead of the action, personal info
// removed without a case, resolution by edit, delete and the per-minute check, the
// counts, settings normalisation and the database-error fallback.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';

const {
    actOn, checkEditedHeadsUp, headsUpPlan, resetAutomodState, runHeadsUpChecks, setAutomodDepsForTest,
} = await import('../../src/services/automod/automodService.js');
const {
    headsUpStats, noteMessageDeleted, pendingHeadsUpRule, setHeadsUpDepsForTest,
} = await import('../../src/services/automod/headsUp.js');
const {
    HEADS_UP_NEVER, headsUpAllowedFor, headsUpApplies, headsUpDm, headsUpEnabled, headsUpNotice, privacyHeadsUpDm,
} = await import('../../src/services/automod/policy.js');
const { normalizeSettings, setHeadsUp } = await import('../../src/services/automod/automodSettings.js');

const GUILD = 'g-headsup';
const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

afterEach(() => {
    setAutomodDepsForTest();
    setHeadsUpDepsForTest();
    resetAutomodState();
});

// ── fakes ─────────────────────────────────────────────────────────────────

function fakeKv({ failGet = null } = {}) {
    const store = new Map();
    return {
        store,
        kvGet: async (key) => {
            if (failGet && failGet(key)) throw new Error('database not responding');
            return store.has(key) ? structuredClone(store.get(key)) : null;
        },
        kvSet: async (key, value) => { store.set(key, structuredClone(value)); return true; },
        kvDelete: async (key) => { store.delete(key); return true; },
        kvUpdate: async (key, mutator) => {
            const next = await mutator(store.has(key) ? structuredClone(store.get(key)) : null);
            store.set(key, structuredClone(next));
            return next;
        },
    };
}

function setup({ dm = true, failGet = null, now = T0 } = {}) {
    const kv = fakeKv({ failGet });
    const calls = [];
    const clock = { now };
    const rec = (name, value) => async (...args) => { calls.push({ name, args }); return typeof value === 'function' ? value(...args) : value; };
    setHeadsUpDepsForTest({
        ...kv,
        sendDm: rec('sendDm', dm),
        postReviewCard: rec('postReviewCard', { id: 'card1', channelId: 'review' }),
        closeCard: rec('closeCard', null),
        isRaidJoiner: async () => false,
        now: () => clock.now,
    });
    setAutomodDepsForTest({
        countOffences: rec('countOffences', 0),
        applyStep: rec('applyStep', { record: { case_code: 'abc2345' } }),
        postReviewCard: rec('actionCard', null),
        noteRepeatHit: rec('noteRepeatHit', null),
        deleteQuietly: rec('deleteQuietly', null),
        isRaidJoiner: rec('isRaidJoiner', false),
        giveSecondChance: rec('giveSecondChance', false),
        getAutomodSettings: async () => normalizeSettings({}),
        getProbation: async () => null,
    });
    return { kv, calls, clock, names: () => calls.map((c) => c.name) };
}

function fakeMessage({ id = 'm1', content = 'you are so stupid', mentioned = ['u2'] } = {}) {
    const sent = [];
    const message = {
        id, content, guildId: GUILD, channelId: 'c1', url: `https://discord.com/channels/1/c1/${id}`,
        guild: { id: GUILD, name: 'Mewvo', client: {} },
        author: { id: 'u1', username: 'amy', createdTimestamp: T0 - 400 * DAY },
        mentions: { users: new Map(mentioned.map((u) => [u, { id: u }])), roles: new Map() },
        attachments: new Map(),
        client: { user: { id: 'bot' } },
        channel: { name: 'general', send: async (payload) => { sent.push(payload); return { delete: async () => {} }; } },
        sent,
    };
    return message;
}
const member = { id: 'u1', joinedTimestamp: T0 - 100 * DAY, permissions: { has: () => false } };
const disrespect = { rule: 'disrespect', evidence: 'insulted someone', detail: 'insult "stupid" aimed at u2', mode: 'on' };

function fakeClient(message, { fetchError = null } = {}) {
    const channel = {
        messages: { fetch: async () => { if (fetchError) throw fetchError; return message; } },
    };
    return {
        guilds: { cache: new Map([[GUILD, {
            id: GUILD,
            channels: { cache: new Map([['c1', channel]]), fetch: async () => channel },
            members: { fetch: async () => member },
        }]]) },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ id: 'card1' }) } }) },
    };
}

// ── which rules ───────────────────────────────────────────────────────────

test('eligible rules get a heads-up; never-eligible rules, slurs, ad bots and probation do not', () => {
    const settings = normalizeSettings({});
    for (const rule of ['disrespect', 'harassment', 'sexual', 'language', 'privacy', 'custom-abcd2345']) {
        assert.equal(headsUpApplies({ hit: { rule }, settings }), true, rule);
    }
    for (const rule of [...HEADS_UP_NEVER, 'caps', 'characters', 'english']) {
        assert.equal(headsUpApplies({ hit: { rule }, settings }), false, rule);
    }
    assert.equal(headsUpApplies({ hit: { rule: 'language', slur: true }, settings }), false, 'slur');
    assert.equal(headsUpApplies({ hit: { rule: 'disrespect', forceLastStep: true }, settings }), false);
    assert.equal(headsUpApplies({ hit: { rule: 'disrespect' }, settings, probation: true }), false);
    const off = normalizeSettings({ headsUp: { disrespect: false, custom: false } });
    assert.equal(headsUpApplies({ hit: { rule: 'disrespect' }, settings: off }), false);
    assert.equal(headsUpApplies({ hit: { rule: 'harassment' }, settings: off }), true);
    assert.equal(headsUpEnabled(off, 'custom-abcd2345'), false, 'one switch for all custom rules');
});

test('settings: heads-up values for scam etc. are dropped and the setter refuses them', async () => {
    const s = normalizeSettings({ headsUp: { scam: true, spam: true, harassment: false, custom: false, privacy: 'yes', nsfw: false } });
    assert.deepEqual(s.headsUp, { harassment: false, custom: false });
    assert.deepEqual(normalizeSettings({}).headsUp, {});
    assert.deepEqual(normalizeSettings({ headsUp: 'x' }).headsUp, {});
    for (const rule of HEADS_UP_NEVER) {
        await assert.rejects(setHeadsUp(GUILD, rule, true), /not available for this rule/, rule);
    }
    await assert.rejects(setHeadsUp(GUILD, 'nope', true), /Unknown rule/);
    await assert.rejects(setHeadsUp(GUILD, 'harassment', 'on'), /on or off/);
});

test('wording: plain, no em dashes, a jump link, custom rules by name', () => {
    const dm = headsUpDm({ ruleKey: 'disrespect', channelName: 'general', serverName: 'Mewvo', messageUrl: 'https://discord.com/channels/1/2/3' });
    assert.equal(dm, 'Your message in #general (Mewvo) looked like disrespect or drama. Edit or delete it within 2 minutes and nothing happens.\nMessage: https://discord.com/channels/1/2/3');
    assert.match(headsUpDm({ ruleKey: 'custom-abcd2345', ruleLabel: 'Ads', channelName: 'x' }), /matched the server rule "Ads"/);
    assert.equal(privacyHeadsUpDm({ channelName: 'general' }), 'Your message in #general was removed because it looked like personal information. No warning this time.');
    assert.match(headsUpNotice({ ruleKey: 'sexual', userId: '42' }), /^<@42> Your message looked like sexual harassment or references\./);
    for (const text of [dm, headsUpNotice({ ruleKey: 'language', userId: '1' })]) assert.ok(!/[—–]/.test(text));
});

// ── the heads-up instead of the action ────────────────────────────────────

test('first hit: a DM and a waiting record instead of the action; within 30 days the next hit acts', async () => {
    const h = setup();
    const message = fakeMessage();
    assert.equal(await actOn(message, member, disrespect, normalizeSettings({})), false, 'message not removed');
    assert.deepEqual(h.names(), ['sendDm', 'postReviewCard']);
    const dm = h.calls[0].args[1];
    assert.match(dm, /^Your message in #general \(Mewvo\) looked like disrespect or drama\. Edit or delete it within 2 minutes and nothing happens\./);
    assert.match(dm, /https:\/\/discord\.com\/channels\/1\/c1\/m1/);
    const card = h.calls[1].args[0];
    assert.equal(card.note.title, 'Heads-up sent (DM), waiting 2 minutes');
    assert.equal(card.noGroup, true);
    const pending = h.kv.store.get(`automod:headsup:pending:${GUILD}:m1`);
    assert.equal(pending.rule, 'disrespect');
    assert.equal(pending.dueAt, T0 + 2 * 60 * 1000);
    assert.deepEqual(pending.card, { channelId: 'review', messageId: 'card1' });
    assert.deepEqual(h.kv.store.get('automod:headsup:index'), { [`${GUILD}:m1`]: { dueAt: T0 + 120000, rule: 'disrespect' } });
    assert.ok(h.kv.store.get(`automod:headsup:seen:${GUILD}:u1:disrespect`).until > T0 + 29 * DAY);
    assert.equal(pendingHeadsUpRule(GUILD, 'm1'), 'disrespect');

    h.calls.length = 0;
    h.clock.now = T0 + 10 * DAY;
    assert.equal(await actOn(fakeMessage({ id: 'm2' }), member, disrespect, normalizeSettings({})), true);
    assert.deepEqual(h.names(), ['deleteQuietly', 'isRaidJoiner', 'countOffences', 'giveSecondChance', 'applyStep', 'actionCard']);
    assert.equal((await headsUpStats(GUILD, { now: T0 })).sent, 1);
});

test('heads-up switched off for the rule: acts at once', async () => {
    const h = setup();
    await actOn(fakeMessage(), member, disrespect, normalizeSettings({ headsUp: { disrespect: false } }));
    assert.ok(h.names().includes('applyStep'));
    assert.ok(!h.names().includes('sendDm'));
});

test('DM fails: a notice in the channel that pings only the member', async () => {
    const h = setup({ dm: false });
    const message = fakeMessage();
    await actOn(message, member, disrespect, normalizeSettings({}));
    assert.equal(message.sent.length, 1);
    assert.match(message.sent[0].content, /^<@u1> Your message looked like disrespect or drama\. Edit or delete it within 2 minutes/);
    assert.deepEqual(message.sent[0].allowedMentions, { users: ['u1'] });
    assert.equal(h.calls.find((c) => c.name === 'postReviewCard').args[0].note.title, 'Heads-up sent (channel notice), waiting 2 minutes');
});

test('personal info: deleted at once, a DM, no case and nothing waiting', async () => {
    const h = setup();
    const hit = { rule: 'privacy', evidence: 'shared a phone number', detail: 'contains a phone number', mode: 'on' };
    assert.equal(await actOn(fakeMessage({ content: 'call +370 612 34567' }), member, hit, normalizeSettings({})), true);
    assert.deepEqual(h.names(), ['deleteQuietly', 'sendDm', 'postReviewCard']);
    assert.match(h.calls[1].args[1], /was removed because it looked like personal information\. No warning this time\./);
    assert.ok(!h.names().includes('applyStep'));
    assert.equal(h.kv.store.get(`automod:headsup:pending:${GUILD}:m1`), undefined);
    assert.equal(h.kv.store.get('automod:headsup:index'), undefined);
    assert.ok(h.kv.store.get(`automod:headsup:seen:${GUILD}:u1:privacy`));
});

test('database error reading the heads-up record: the normal action runs', async () => {
    const h = setup({ failGet: (key) => key.includes(':seen:') });
    assert.equal(await actOn(fakeMessage(), member, disrespect, normalizeSettings({})), true);
    assert.ok(h.names().includes('applyStep'));
    assert.ok(!h.names().includes('sendDm'));
});

test('a heads-up only when every hit allows one: a never-eligible hit next to an insult acts now', () => {
    const settings = normalizeSettings({});
    assert.equal(headsUpAllowedFor([{ rule: 'disrespect' }], settings), true);
    assert.equal(headsUpAllowedFor([{ rule: 'disrespect' }, { rule: 'sexual' }], settings), true);
    for (const other of [{ rule: 'mentions' }, { rule: 'scam' }, { rule: 'language', slur: true }, { rule: 'caps' }]) {
        assert.equal(headsUpAllowedFor([{ rule: 'disrespect' }, other], settings), false, JSON.stringify(other));
    }
    assert.equal(headsUpAllowedFor([{ rule: 'disrespect' }], settings, true), false, 'probation');
    assert.equal(headsUpAllowedFor([], settings), false);
});

test('personal info plus another rule: no heads-up, delete at once, act on the worst hit', () => {
    const settings = normalizeSettings({});
    const harassment = { rule: 'harassment' };
    const privacy = { rule: 'privacy' };
    // Mixed: deleted first, the worst hit acted on with no heads-up (no severity downgrade).
    const mixed = headsUpPlan([harassment, privacy], settings);
    assert.equal(mixed.deleteFirst, true);
    assert.equal(mixed.skipHeadsUp, true);
    assert.equal(mixed.hit.rule, 'harassment');
    // Personal info alone keeps its own heads-up path (deleted inside it).
    assert.deepEqual(headsUpPlan([privacy], settings), { hit: privacy, skipHeadsUp: false, deleteFirst: false });
    // No personal info: unchanged.
    assert.equal(headsUpPlan([harassment], settings).skipHeadsUp, false);
    assert.equal(headsUpPlan([harassment], settings, { hadHeadsUp: true }).skipHeadsUp, true);
    assert.equal(headsUpPlan([harassment, { rule: 'scam' }], settings).skipHeadsUp, true);
});

test('two messages at the same moment: only one heads-up, the other acts normally', async () => {
    const h = setup();
    const settings = normalizeSettings({});
    const results = await Promise.all([
        actOn(fakeMessage({ id: 'm1' }), member, disrespect, settings),
        actOn(fakeMessage({ id: 'm2' }), member, disrespect, settings),
    ]);
    assert.equal(h.names().filter((n) => n === 'sendDm').length, 1, 'one heads-up DM');
    assert.equal(h.names().filter((n) => n === 'applyStep').length, 1, 'the other message is acted on');
    assert.equal(results.length, 2);
});

// ── resolution ────────────────────────────────────────────────────────────

test('edit: still breaking the rule keeps waiting; edited clean resolves as fixed', async () => {
    const h = setup();
    const message = fakeMessage();
    await actOn(message, member, disrespect, normalizeSettings({}));
    assert.equal(await checkEditedHeadsUp(message, [{ rule: 'harassment' }]), null, 'insult still there (now counted as harassment)');
    assert.equal(pendingHeadsUpRule(GUILD, 'm1'), 'disrespect');
    // The edit still insults and also breaks another rule: every hit goes on, so the insult
    // is acted on too (even when the other rule is only monitored).
    assert.deepEqual(await checkEditedHeadsUp(message, [{ rule: 'disrespect' }, { rule: 'scam' }]), [{ rule: 'disrespect' }, { rule: 'scam' }], 'all hits go on');
    // That closed the heads-up as acted (the message is dealt with now).
    assert.equal(pendingHeadsUpRule(GUILD, 'm1'), null);

    const h2 = setup();
    const again = fakeMessage({ id: 'm9' });
    await actOn(again, member, disrespect, normalizeSettings({}));
    assert.deepEqual(await checkEditedHeadsUp(again, []), []);
    assert.equal(pendingHeadsUpRule(GUILD, 'm9'), null);
    assert.equal(h2.kv.store.get(`automod:headsup:pending:${GUILD}:m9`), undefined);
    assert.deepEqual(h2.kv.store.get('automod:headsup:index'), {});
    assert.deepEqual(await headsUpStats(GUILD, { days: 30, now: T0 }), { days: 30, sent: 1, fixed: 1, acted: 0 });
    void h;
});

test('delete (also a partial, by id): resolves as fixed', async () => {
    const h = setup();
    await actOn(fakeMessage(), member, disrespect, normalizeSettings({}));
    const client = fakeClient(null);
    assert.equal(await noteMessageDeleted(client, GUILD, 'other'), false, 'not waiting: nothing read');
    assert.equal(await noteMessageDeleted(client, GUILD, 'm1'), true);
    assert.equal(await noteMessageDeleted(client, GUILD, 'm1'), false, 'only once');
    assert.equal((await headsUpStats(GUILD, { now: T0 })).fixed, 1);
    const close = h.calls.find((c) => c.name === 'closeCard');
    assert.equal(close.args[2].verb, 'Fixed by member');
});

test('per-minute check: still bad after 2 minutes → the normal action; before that, nothing', async () => {
    const h = setup();
    const message = fakeMessage();
    await actOn(message, member, disrespect, normalizeSettings({}));
    h.calls.length = 0;
    const client = fakeClient(message);
    assert.equal(await runHeadsUpChecks(client, T0 + 60 * 1000), 0, 'not due yet');
    assert.deepEqual(h.names(), []);
    assert.equal(await runHeadsUpChecks(client, T0 + 3 * 60 * 1000), 1);
    assert.ok(!h.names().includes('sendDm'), 'no second heads-up');
    assert.deepEqual(h.names().filter((n) => n !== 'closeCard'), ['deleteQuietly', 'isRaidJoiner', 'countOffences', 'giveSecondChance', 'applyStep', 'actionCard']);
    assert.equal(h.calls.find((c) => c.name === 'closeCard').args[2].verb, 'Action taken');
    assert.deepEqual(await headsUpStats(GUILD, { now: T0 }), { days: 90, sent: 1, fixed: 0, acted: 1 });
    assert.equal(await runHeadsUpChecks(client, T0 + 4 * 60 * 1000), 0, 'done');
});

test('per-minute check: message gone → fixed; edited clean → fixed; channel unreadable → dropped', async () => {
    let h = setup();
    await actOn(fakeMessage(), member, disrespect, normalizeSettings({}));
    await runHeadsUpChecks(fakeClient(null, { fetchError: Object.assign(new Error('Unknown Message'), { code: 10008 }) }), T0 + 3 * 60 * 1000);
    assert.ok(!h.names().includes('applyStep'));
    assert.deepEqual(await headsUpStats(GUILD, { now: T0 }), { days: 90, sent: 1, fixed: 1, acted: 0 });

    h = setup();
    const message = fakeMessage();
    await actOn(message, member, disrespect, normalizeSettings({}));
    message.content = 'you are so nice';
    await runHeadsUpChecks(fakeClient(message), T0 + 3 * 60 * 1000);
    assert.ok(!h.names().includes('applyStep'));
    assert.equal((await headsUpStats(GUILD, { now: T0 })).fixed, 1);

    h = setup();
    await actOn(fakeMessage(), member, disrespect, normalizeSettings({}));
    await runHeadsUpChecks(fakeClient(null, { fetchError: Object.assign(new Error('Missing Access'), { code: 50001 }) }), T0 + 3 * 60 * 1000);
    assert.ok(!h.names().includes('applyStep'));
    assert.deepEqual(h.kv.store.get('automod:headsup:index'), {});
    assert.deepEqual(await headsUpStats(GUILD, { now: T0 }), { days: 90, sent: 1, fixed: 0, acted: 0 });
});

test('counts: per UTC day, summed over the asked window', async () => {
    const h = setup();
    h.kv.store.set(`automod:headsup:stats:${GUILD}`, { days: {
        '2026-11-01': { sent: 2, fixed: 1, acted: 1 },
        '2026-10-20': { sent: 3, fixed: 3, acted: 0 },
        '2026-08-15': { sent: 9, fixed: 0, acted: 9 },
        '2026-06-01': { sent: 50, fixed: 0, acted: 50 },
    } });
    assert.deepEqual(await headsUpStats(GUILD, { days: 30, now: T0 }), { days: 30, sent: 5, fixed: 4, acted: 1 });
    assert.deepEqual(await headsUpStats(GUILD, { days: 1, now: T0 }), { days: 1, sent: 2, fixed: 1, acted: 1 });
    assert.deepEqual(await headsUpStats(GUILD, { days: 90, now: T0 }), { days: 90, sent: 14, fixed: 4, acted: 10 });
    assert.equal((await headsUpStats(GUILD, { days: 200, now: T0 })).days, 120, 'at most the kept 120 days');
    const failing = setup({ failGet: () => true });
    await assert.rejects(headsUpStats(GUILD, { now: T0 }), /not responding/);
    void failing;
});
