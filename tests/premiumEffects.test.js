// What a plan does in Discord (premiumEffects.js, /premium): the plan cache, limits by the
// server owner's plan, supporter-role changes, DM texts, the follow-up after a change, the
// 5-minute cron (reminder once per end date, ended DM, roles of people whose plan ended),
// and the /premium command (status, redeem, refusals, rate limit, off without the switch).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';

const {
    afterPremiumChange, guildPlan, limitMessage, notePremium, planLimit, planOf, premiumDm, roleChanges, runPremiumCron,
    setGuildOwnerResolver, setPremiumCache, syncPremiumRole,
} = await import('../src/services/billing/premiumEffects.js');
const { PremiumError, giftDetails, keyStatus } = await import('../src/services/billing/premiumService.js');
const { checkoutEffect } = await import('../src/services/site/billing.js');
const premiumCommand = (await import('../src/commands/Core/premium.js')).default;
const { allowRedeem, statusText } = await import('../src/commands/Core/premium.js');
const { enforcementConfig } = await import('../src/config/enforcement.js');

const DAY = 24 * 3600 * 1000;
const MAIN = enforcementConfig.mainGuildId;
const OWNER = '200000000000000001';
const MEMBER = '200000000000000002';
const ROLES = { normal: '300000000000000001', pro: '300000000000000002', max: '300000000000000003' };
const sub = (userId, planId, days) => ({ user_id: userId, plan_id: planId, started_at: new Date(), expires_at: new Date(Date.now() + days * DAY) });

afterEach(() => {
    setPremiumCache([]);
    setGuildOwnerResolver(null);
});

test('cache: active plans only; planOf falls back to free', () => {
    setPremiumCache([sub(OWNER, 'pro', 10), sub(MEMBER, 'max', -1)]);
    assert.equal(planOf(OWNER), 'pro');
    assert.equal(planOf(MEMBER), 'free', 'ended plans are not cached');
    assert.equal(planOf(null), 'free');
    notePremium({ ...sub(OWNER, 'pro', 10), expires_at: new Date(0) });
    assert.equal(planOf(OWNER), 'free', 'an ended row removes the user');
});

test('limits follow the server owner\'s plan; Free keeps the old numbers; the message names the next plan', () => {
    setGuildOwnerResolver((guildId) => (guildId === 'g1' ? OWNER : null));
    assert.deepEqual(['tags', 'stickies', 'feeds', 'scheduled'].map((k) => planLimit('g1', k)), [100, 10, 20, 50]);
    assert.equal(limitMessage('g1', 'tags', 'tags'), 'A server can have at most 100 tags on the Free plan. Normal raises it to 250.');
    setPremiumCache([sub(OWNER, 'pro', 10)]);
    assert.equal(guildPlan('g1'), 'pro');
    assert.deepEqual(['tags', 'stickies', 'feeds', 'scheduled'].map((k) => planLimit('g1', k)), [500, 50, 75, 200]);
    assert.equal(limitMessage('g1', 'feeds', 'YouTube feeds'), 'A server can have at most 75 YouTube feeds on the Pro plan. Max raises it to 150.');
    assert.equal(planLimit('unknown-guild', 'tags'), 100, 'no owner known: Free');
    setGuildOwnerResolver(() => { throw new Error('cache gone'); });
    assert.equal(planLimit('g1', 'tags'), 100, 'a resolver error counts as Free');
});

test('roleChanges: the plan\'s role in, the other tier roles out; no plan → all out; unset roles ignored', () => {
    assert.deepEqual(roleChanges([], 'pro', ROLES), { add: [ROLES.pro], remove: [] });
    assert.deepEqual(roleChanges([ROLES.normal, 'x'], 'pro', ROLES), { add: [ROLES.pro], remove: [ROLES.normal] });
    assert.deepEqual(roleChanges([ROLES.pro], 'pro', ROLES), { add: [], remove: [] });
    assert.deepEqual(roleChanges([ROLES.pro, ROLES.max], 'free', ROLES), { add: [], remove: [ROLES.pro, ROLES.max] });
    assert.deepEqual(roleChanges([], 'max', { normal: null, pro: null, max: null }), { add: [], remove: [] });
});

test('DM texts: active (purchase / key / owner, upgrade note), reminder, ended; Discord timestamps', () => {
    const until = new Date('2027-01-01T00:00:00Z');
    const active = premiumDm('active', { planId: 'pro', expiresAt: until, from: 'key', converted: { fromPlanId: 'normal' } });
    assert.match(active, /\*\*Mewvo Pro is active\*\* until <t:1798761600:F> \(<t:1798761600:R>\)/);
    assert.match(active, /A key was redeemed/);
    assert.match(active, /remaining Normal time was converted/);
    assert.match(premiumDm('active', { planId: 'max', expiresAt: until, from: 'owner' }), /bot owner gave you/);
    assert.match(premiumDm('reminder', { planId: 'max', expiresAt: until }), /ends soon/);
    assert.match(premiumDm('ended', { planId: 'max', expiresAt: until }), /has ended.*nothing was deleted/s);
});

/** memberRoles: the roles MEMBER holds (everyone else holds none). */
function fakeClient({ memberRoles = [], roleMembers = {}, dmFails = false } = {}) {
    const added = [];
    const removed = [];
    const dms = [];
    const heldBy = new Map([[MEMBER, new Set(memberRoles)]]);
    const held = (id) => { if (!heldBy.has(id)) heldBy.set(id, new Set()); return heldBy.get(id); };
    const me = { id: 'bot', roles: { highest: { position: 100 } }, permissions: { has: () => true } };
    const role = (id) => ({ id, name: id, managed: false, position: 1, guild: { id: MAIN }, permissions: { has: () => false, any: () => false }, comparePositionTo: () => -1, editable: true, members: new Map((roleMembers[id] || []).map((m) => [m, {}])) });
    const guild = {
        id: MAIN,
        roles: { cache: new Map(Object.values(ROLES).map((id) => [id, role(id)])) },
        members: {
            me,
            fetch: async (id) => ({
                id,
                roles: {
                    cache: new Map([...held(id)].map((r) => [r, {}])),
                    add: async (r) => { added.push([id, r]); held(id).add(r); },
                    remove: async (r) => { removed.push([id, r]); held(id).delete(r); },
                },
            }),
        },
    };
    return {
        added, removed, dms,
        guilds: { cache: new Map([[MAIN, guild]]) },
        users: { fetch: async (id) => ({ send: async (payload) => { if (dmFails) throw new Error('Cannot send messages to this user'); dms.push([id, payload]); } }) },
    };
}

test('syncPremiumRole gives the plan\'s role and removes the old tier; nothing when no roles are set', async () => {
    setPremiumCache([sub(MEMBER, 'max', 10)]);
    const client = fakeClient({ memberRoles: [ROLES.normal] });
    const changes = await syncPremiumRole(client, MEMBER, { roles: ROLES });
    assert.deepEqual(changes, { add: [ROLES.max], remove: [ROLES.normal] });
    assert.deepEqual(client.added, [[MEMBER, ROLES.max]]);
    assert.deepEqual(client.removed, [[MEMBER, ROLES.normal]]);
    assert.equal(await syncPremiumRole(client, MEMBER, { roles: { normal: null, pro: null, max: null } }), null);
});

test('afterPremiumChange: cache updated, DM sent; a failed DM never throws; ended → no "active" DM', async () => {
    const client = fakeClient();
    const row = sub(MEMBER, 'pro', 30);
    await afterPremiumChange({ subscription: row, next: { converted: null } }, 'purchase', { client });
    assert.equal(planOf(MEMBER), 'pro');
    assert.equal(client.dms.length, 1);
    assert.match(client.dms[0][1].content, /Mewvo Pro is active/);
    assert.deepEqual(client.dms[0][1].allowedMentions, { parse: [] });

    await afterPremiumChange({ subscription: row }, 'key', { client: fakeClient({ dmFails: true }) }); // must not throw
    const quiet = fakeClient();
    await afterPremiumChange({ subscription: row }, 'ended', { client: quiet });
    assert.equal(planOf(MEMBER), 'free');
    assert.equal(quiet.dms.length, 0);
    await afterPremiumChange(null, 'key', { client }); // nothing to do
});

test('cron: reminder and ended DMs once per end date; cache refreshed; ended plan loses its role', async () => {
    const ending = sub(OWNER, 'pro', 2);
    const ended = { ...sub(MEMBER, 'normal', -1) };
    const marked = [];
    const store = {
        dueReminders: async (within) => { assert.equal(within, 3 * DAY); return [ending]; },
        dueEndings: async () => [ended],
        markNotified: async (userId, kind, at) => { marked.push([userId, kind, at]); },
        listActiveSubscriptions: async () => [ending],
    };
    const client = fakeClient({ memberRoles: [ROLES.normal], roleMembers: { [ROLES.normal]: [MEMBER] } });
    const { setSettingsCacheForTests, resetSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
    setSettingsCacheForTests(MAIN, { premiumRoleIds: ROLES });
    try {
        const out = await runPremiumCron(client, store);
        assert.equal(out.reminded, 1);
        assert.equal(out.ended, 1);
        assert.deepEqual(marked.map(([u, k]) => [u, k]), [[OWNER, 'reminder'], [MEMBER, 'ended']]);
        assert.match(client.dms.find(([id]) => id === OWNER)[1].content, /ends soon/);
        assert.match(client.dms.find(([id]) => id === MEMBER)[1].content, /has ended/);
        assert.equal(planOf(OWNER), 'pro');
        assert.ok(client.removed.some(([id, r]) => id === MEMBER && r === ROLES.normal), 'ended plan: role removed');
    } finally {
        resetSettingsCacheForTests();
    }
});

test('pure helpers: gift details limits, expired keys, checkout effect texts', () => {
    assert.deepEqual(giftDetails({ to: '  Sam ', message: ' Happy birthday! ' }), { giftTo: 'Sam', giftMessage: 'Happy birthday!' });
    assert.deepEqual(giftDetails({}), { giftTo: null, giftMessage: null });
    assert.throws(() => giftDetails({ to: 'x'.repeat(51) }), PremiumError);
    assert.throws(() => giftDetails({ message: 'x'.repeat(301) }), PremiumError);
    assert.equal(keyStatus({ expires_at: new Date(Date.now() - 1000) }), 'expired');
    assert.equal(keyStatus({ expires_at: new Date(Date.now() + DAY) }), 'unused');
    assert.equal(keyStatus({ expires_at: new Date(Date.now() - 1000), redeemed_at: new Date() }), 'redeemed');
    assert.equal(checkoutEffect(null, { planId: 'pro' }).kind, 'new');
    assert.equal(checkoutEffect(sub(MEMBER, 'pro', 5), { planId: 'pro' }).kind, 'extend');
    assert.match(checkoutEffect(sub(MEMBER, 'normal', 10), { planId: 'max' }).text, /^Upgrade: your remaining 10 days of Normal become 2 days of Max/);
    assert.equal(checkoutEffect(sub(MEMBER, 'max', 10), { planId: 'pro' }).kind, 'blocked');
});

// ── /premium ──────────────────────────────────────────────────────────────

function fakeInteraction(sub, key = null, userId = MEMBER) {
    const replies = [];
    return {
        replies,
        id: `i${Math.random()}`, createdTimestamp: Date.now(),
        user: { id: userId, username: 'member', globalName: 'Member' },
        options: { getSubcommand: () => sub, getString: () => key },
        reply: async (payload) => { replies.push(payload); },
    };
}
const description = (i) => i.replies[0].embeds[0].data.description;
const ON = { PREMIUM_TEST_CHECKOUT: 'true', PUBLIC_URL: 'https://mewvo.example/' };

test('/premium status: Free with the pricing link, or the plan with its end and server limits; ephemeral', async () => {
    const free = fakeInteraction('status');
    await premiumCommand.execute(free, null, null, { env: ON, store: { accountOf: async () => ({ subscription: null }) } });
    assert.match(description(free), /You are on \*\*Free\*\*\. Plans: https:\/\/mewvo\.example\/pricing/);
    assert.equal(free.replies[0].flags, 64, 'ephemeral');
    const paid = fakeInteraction('status');
    await premiumCommand.execute(paid, null, null, { env: ON, store: { accountOf: async () => ({ subscription: sub(MEMBER, 'max', 3) }) } });
    assert.match(description(paid), /\*\*Mewvo Max\*\* until <t:\d+:F>/);
    assert.match(description(paid), /1000 tags, 100 sticky messages, 150 YouTube feeds, 500 scheduled messages/);
    assert.match(statusText(null, ''), /^You are on \*\*Free\*\*\.\n/);
});

test('/premium redeem: success runs the follow-up; refusals and DB errors are friendly; off without the switch', async () => {
    const calls = [];
    const row = sub(MEMBER, 'pro', 30);
    const store = {
        redeem: async ({ code, userId }) => {
            calls.push([code, userId]);
            if (code === 'used') throw new PremiumError('That key has already been used.', 409);
            if (code === 'boom') throw new Error('connection refused');
            return { key: { code: 'MEWVO-AAAA-BBBB-CCCC', plan_id: 'pro', duration_days: 30 }, subscription: row, next: { converted: null } };
        },
    };
    const followed = [];
    const after = async (result, from) => { followed.push(from); };
    const ok = fakeInteraction('redeem', 'MEWVO-AAAA-BBBB-CCCC', '200000000000000071');
    await premiumCommand.execute(ok, null, null, { env: ON, store, after });
    assert.match(description(ok), /Key redeemed: \*\*Mewvo Pro\*\*, 30 days added/);
    assert.deepEqual(followed, ['key']);
    const used = fakeInteraction('redeem', 'used', '200000000000000072');
    await premiumCommand.execute(used, null, null, { env: ON, store, after });
    assert.equal(description(used), 'That key has already been used.');
    const boom = fakeInteraction('redeem', 'boom', '200000000000000073');
    await premiumCommand.execute(boom, null, null, { env: ON, store, after });
    assert.match(description(boom), /database is not responding\. Nothing was changed/);
    const off = fakeInteraction('redeem', 'x', '200000000000000074');
    await premiumCommand.execute(off, null, null, { env: {}, store, after });
    assert.equal(description(off), 'Plans are not available yet.');
    assert.equal(calls.length, 3, 'off: the store is never called');
});

test('/premium redeem: at most 5 tries a minute per user', () => {
    const store = new Map();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) assert.equal(allowRedeem('u', now + i, store), true);
    assert.equal(allowRedeem('u', now + 10, store), false);
    assert.equal(allowRedeem('other', now + 10, store), true);
    assert.equal(allowRedeem('u', now + 61_000, store), true, 'window passed');
});

test('/premium gift: test-mode gift key DMed to them; closed DMs show the key to the buyer; no bots, not yourself, 3 an hour', async () => {
    const { allowGift, giftDm } = await import('../src/commands/Core/premium.js');
    const purchases = [];
    const store = { purchase: async (p) => { purchases.push(p); return { key: { code: 'MEWVO-2222-3333-4444', duration_days: 30, plan_id: p.planId } }; } };
    const make = (target, buyerId = MEMBER, opts = { plan: 'pro', period: null, message: 'enjoy' }) => {
        const i = fakeInteraction('gift', null, buyerId);
        i.options.getUser = () => target;
        i.options.getString = (name) => opts[name] ?? null;
        return i;
    };
    const dms = [];
    const friend = { id: '300000000000000099', username: 'friend', globalName: 'Friend', bot: false, send: async (p) => dms.push(p) };
    const ok = make(friend);
    await premiumCommand.execute(ok, null, null, { env: ON, store });
    assert.equal(purchases[0].kind, 'gift');
    assert.equal(purchases[0].period, 'monthly', 'a month by default');
    assert.equal(purchases[0].giftTo, 'Friend');
    assert.match(dms[0].content, new RegExp(`^<@${MEMBER}> gave you \\*\\*Mewvo Pro\\*\\* for 30 days\\.\\nTheir note: enjoy\\nYour key: \`MEWVO-2222-3333-4444\``));
    assert.match(dms[0].content, /https:\/\/mewvo\.example\/me\/redeem\?code=MEWVO-2222-3333-4444/);
    assert.deepEqual(dms[0].allowedMentions, { parse: [] });
    assert.match(description(ok), /^Sent\. friend got a DM/);

    const closed = make({ ...friend, send: async () => { throw new Error('Cannot send messages to this user'); } }, '200000000000000077');
    await premiumCommand.execute(closed, null, null, { env: ON, store });
    assert.match(description(closed), /Their DMs are closed, so give them this key yourself: `MEWVO-2222-3333-4444`/);

    const before = purchases.length;
    const bot = make({ ...friend, bot: true }, '200000000000000078');
    await premiumCommand.execute(bot, null, null, { env: ON, store });
    assert.match(description(bot), /Bots can't have a plan/);
    const self = make({ ...friend, id: '200000000000000079' }, '200000000000000079');
    await premiumCommand.execute(self, null, null, { env: ON, store });
    assert.match(description(self), /That's you/);
    assert.equal(purchases.length, before, 'nothing bought for refused gifts');

    const t0 = 1000;
    const limits = new Map();
    assert.ok(allowGift('u', t0, limits) && allowGift('u', t0 + 1, limits) && allowGift('u', t0 + 2, limits));
    assert.equal(allowGift('u', t0 + 3, limits), false);
    assert.equal(allowGift('u', t0 + 3600001, limits), true, 'an hour later');
    assert.ok(!giftDm({ fromId: '1', planId: 'max', days: 365, code: 'K', message: '' }).includes('Their note'));
    // Phishing-proof: no masked links, no URLs, no markdown, no mass mentions from member text.
    const evil = giftDm({ fromId: '1', planId: 'pro', days: 30, code: 'K', message: '# Official\n[Claim Nitro](https://evil.example/x) www.evil.example discord.gg/abc @everyone **bold**' });
    assert.ok(!/https?:\/\/evil|www\.evil|discord\.gg\/abc/.test(evil), evil);
    assert.ok(!/(^|[^\\])\]\(/.test(evil) && !evil.includes('\n#') && !evil.includes('@everyone'), evil);
    assert.match(evil, /\(link removed\)/);
});
