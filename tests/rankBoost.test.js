// /rank shows the member's current XP boost where the command was run (a thread counts as
// its parent channel), only when it is above x1. Same math as messageCreate (levelBoosts.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xpBoostBreakdown } from '../src/services/leveling/levelBoosts.js';
import rank, { rankBoostLine, xpBoostLine } from '../src/commands/Leveling/rank.js';
import { updateLevelingConfig } from '../src/services/leveling/leveling.js';

const GUILD = '300000000000000001';
const CH = '400000000000000001';
const THREAD = '400000000000000002';
const ROLE_BOOSTER = '600000000000000001';
const ROLE_VIP = '600000000000000002';
const ROLE_PLAIN = '600000000000000003';
const USER = '700000000000000001';

const roleCache = (ids) => new Map(ids.map((id) => [id, { id, name: { [ROLE_BOOSTER]: 'Booster', [ROLE_VIP]: 'V*I*P', [ROLE_PLAIN]: 'Member' }[id] }]));
const member = (roleIds = []) => ({ id: USER, roles: { cache: roleCache(roleIds) } });
const textChannel = { id: CH, isThread: () => false };
const thread = { id: THREAD, parentId: CH, isThread: () => true };

test('xpBoostBreakdown: null at x1; names the counting role and the boosted channel (a thread uses its parent)', () => {
    assert.equal(xpBoostBreakdown({}, { channelId: CH, roleIds: [ROLE_PLAIN] }), null);
    const cfg = { roleMultipliers: { [ROLE_BOOSTER]: 2, [ROLE_VIP]: 1.5 }, channelMultipliers: { [CH]: 1.5 } };
    const b = xpBoostBreakdown(cfg, { channelId: THREAD, threadParentId: CH, roleIds: [ROLE_VIP, ROLE_BOOSTER] });
    assert.equal(b.multiplier, 3);
    assert.equal(b.roleId, ROLE_BOOSTER, 'the highest role wins');
    assert.equal(b.channelId, CH);
    const roleOnly = xpBoostBreakdown(cfg, { channelId: '400000000000000009', roleIds: [ROLE_VIP] });
    assert.equal(roleOnly.channelId, null);
    assert.equal(roleOnly.roleId, ROLE_VIP);
});

test('xpBoostLine: one source shows its name, several show each multiplier, the cap is mentioned', () => {
    assert.equal(xpBoostLine(null), null);
    assert.equal(xpBoostLine({ multiplier: 1, role: 1, channel: 1, global: 1 }), null);
    assert.equal(xpBoostLine({ multiplier: 2, role: 2, channel: 1, global: 1, capped: false }, { hereId: CH, roleName: 'Booster' }), `x2 (role Booster) in <#${CH}>`);
    assert.equal(xpBoostLine({ multiplier: 1.5, role: 1, channel: 1.5, global: 1, capped: false }, { hereId: CH }), `x1.5 (channel boost) in <#${CH}>`);
    assert.equal(xpBoostLine({ multiplier: 3, role: 2, channel: 1.5, global: 1, capped: false }, { hereId: CH, roleName: 'Booster' }),
        `x3 (role Booster x2, channel boost x1.5) in <#${CH}>`);
    assert.equal(xpBoostLine({ multiplier: 5, role: 4, channel: 2, global: 1, capped: true }, { hereId: CH, roleName: 'Booster' }),
        `x5 (role Booster x4, channel boost x2, capped at x5) in <#${CH}>`);
    assert.equal(xpBoostLine({ multiplier: 2, role: 1, channel: 1, global: 2, capped: false }, { hereId: CH }), `x2 (server-wide) in <#${CH}>`);
    assert.equal(xpBoostLine({ multiplier: 2, role: 2, channel: 1, global: 1, capped: false }, { roleName: 'V*I*P' }), 'x2 (role V\\*I\\*P)', 'markdown escaped, no channel');
});

test('rankBoostLine: the member\'s roles in this channel; a thread counts as its parent; nothing where no XP is given', () => {
    const cfg = { roleMultipliers: { [ROLE_BOOSTER]: 2 }, channelMultipliers: { [CH]: 1.5 } };
    assert.equal(rankBoostLine(cfg, member([ROLE_BOOSTER]), textChannel), `x3 (role Booster x2, channel boost x1.5) in <#${CH}>`);
    assert.equal(rankBoostLine(cfg, member([]), thread), `x1.5 (channel boost) in <#${THREAD}>`);
    assert.equal(rankBoostLine({}, member([ROLE_BOOSTER]), textChannel), null, 'no boosts configured');
    assert.equal(rankBoostLine(cfg, member([ROLE_PLAIN]), { id: '400000000000000009', isThread: () => false }), null, 'x1 here');
    assert.equal(rankBoostLine({ ...cfg, ignoredChannels: [CH] }, member([ROLE_BOOSTER]), textChannel), null, 'ignored channel');
    assert.equal(rankBoostLine({ ...cfg, ignoredRoles: [ROLE_PLAIN] }, member([ROLE_BOOSTER, ROLE_PLAIN]), textChannel), null, 'ignored role');
    assert.equal(rankBoostLine({ ...cfg, blacklistedUsers: [USER] }, member([ROLE_BOOSTER]), textChannel), null, 'blacklisted');
});

function fakeClient() {
    const store = new Map();
    const db = {
        async get(key, defaultValue = null) { return store.has(key) ? structuredClone(store.get(key)) : defaultValue; },
        async set(key, value) { store.set(key, structuredClone(value)); return true; },
        async update(key, mutator, defaultValue = null) {
            const next = await mutator(store.has(key) ? structuredClone(store.get(key)) : structuredClone(defaultValue));
            store.set(key, structuredClone(next));
            return next;
        },
        async list(prefix) { return [...store.keys()].filter((k) => k.startsWith(prefix)); },
        async delete(key) { store.delete(key); return true; },
    };
    return { db, guilds: { cache: new Map() } };
}

function rankInteraction(client, roleIds, channel) {
    const replies = [];
    const m = { ...member(roleIds), displayName: 'Cat', displayAvatarURL: () => 'https://cdn.example/a.png' };
    return {
        replies,
        interaction: {
            id: '1', deferred: true, replied: false, createdTimestamp: Date.now(), guildId: GUILD, client,
            user: { id: USER }, channel, memberPermissions: { has: () => false },
            guild: { id: GUILD, ownerId: 'owner', members: { fetch: async () => m } },
            options: { getUser: () => null },
            isRepliable: () => true,
            async editReply(payload) { replies.push(payload); return {}; },
        },
    };
}

test('/rank: an XP boost field when the boost here is above x1, none otherwise', async () => {
    const client = fakeClient();
    await updateLevelingConfig(client, GUILD, { enabled: true, roleMultipliers: { [ROLE_BOOSTER]: 2 } });
    const boosted = rankInteraction(client, [ROLE_BOOSTER], textChannel);
    await rank.execute(boosted.interaction, {}, client);
    const fields = boosted.replies.at(-1).embeds[0].data.fields;
    assert.deepEqual(fields.at(-1), { name: 'XP boost', value: `x2 (role Booster) in <#${CH}>` });
    assert.deepEqual(boosted.replies.at(-1).allowedMentions, { parse: [] });

    const plain = rankInteraction(client, [ROLE_PLAIN], textChannel);
    await rank.execute(plain.interaction, {}, client);
    assert.ok(!plain.replies.at(-1).embeds[0].data.fields.some((f) => f.name === 'XP boost'));
});
