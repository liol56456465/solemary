// /profile (commands/Leveling/profile.js): the card shows only what exists, the progress bar
// is bounded, someone else's profile is admin-only, everyone may see their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextReward, profileFields, progressLine, rankMemberIds, rankQuery } from '../src/commands/Leveling/profile.js';
import { getXpForLevel } from '../src/services/leveling/leveling.js';
import { EVERYONE_COMMANDS } from '../src/config/commands/commandAccess.js';

test('progress line: bounded, 10 blocks', () => {
    assert.equal(progressLine(0, 100), '▱▱▱▱▱▱▱▱▱▱ 0%');
    assert.equal(progressLine(30, 100), '▰▰▰▱▱▱▱▱▱▱ 30%');
    assert.equal(progressLine(500, 100), '▰▰▰▰▰▰▰▰▰▰ 100%');
    assert.equal(progressLine(5, 0), '▱▱▱▱▱▱▱▱▱▱ 0%');
});

test('profile fields: level, rank, birthday, plan and dates; missing parts are left out', () => {
    const full = profileFields({ level: { level: 4, xp: 30, totalXp: 900 }, rank: 3, birthday: { month: 3, day: 14 }, planId: 'pro', joinedAt: new Date(0), createdAt: new Date(0) });
    assert.deepEqual(full.map((f) => f.name), ['Level', 'Total XP', 'Rank', 'Birthday', 'Mewvo plan', 'Joined', 'Account created']);
    assert.equal(full.find((f) => f.name === 'Rank').value, '#3');
    assert.equal(full.find((f) => f.name === 'Birthday').value, '14 March');
    assert.equal(full.find((f) => f.name === 'Mewvo plan').value, 'Pro');
    const bare = profileFields({ level: null, rank: null, birthday: null, planId: 'free', joinedAt: null, createdAt: new Date(0) });
    assert.deepEqual(bare.map((f) => f.name), ['Account created']);
    assert.ok(EVERYONE_COMMANDS.has('profile'));
});

test('next reward: the first role reward above the current level and the XP left', () => {
    const rewards = { 2: 'r2', 5: 'r5', 10: 'r10' };
    const level = { level: 3, xp: 40, totalXp: 999 };
    const r = nextReward(level, rewards);
    assert.equal(r.level, 5);
    assert.equal(r.roleId, 'r5');
    assert.equal(r.xp, getXpForLevel(3) - 40 + getXpForLevel(4));
    assert.equal(nextReward({ level: 10, xp: 0 }, rewards), null, 'nothing above');
    assert.equal(nextReward(level, {}), null);
    const fields = profileFields({ level, rank: 1, reward: r, planId: 'free' });
    assert.match(fields.find((f) => f.name === 'Next reward').value, /^<@&r5> at level 5, \d+ XP to go$/);
});

test('profile rank: members only when the member cache is complete, else labelled all-time', () => {
    const guild = (ids, memberCount) => ({ id: 'g', memberCount, members: { cache: new Map(ids.map((id) => [id, {}])) } });
    assert.deepEqual(rankMemberIds(guild(['a', 'b'], 2)), ['a', 'b']);
    assert.equal(rankMemberIds(guild(['a'], 2)), null, 'incomplete cache');
    assert.equal(rankMemberIds(guild(['a'])), null, 'unknown member count');

    const filtered = rankQuery('user_levels', 'g', 'u', ['a', 'b']);
    assert.deepEqual(filtered.values, ['g', 'u', ['a', 'b']]);
    assert.match(filtered.text, /o\.user_id = ANY\(\$3::text\[\]\)/);
    const all = rankQuery('user_levels', 'g', 'u', null);
    assert.deepEqual(all.values, ['g', 'u']);
    assert.ok(!all.text.includes('$3'));

    const level = { level: 4, xp: 30, totalXp: 900 };
    assert.ok(profileFields({ level, rank: 3, planId: 'free' }).some((f) => f.name === 'Rank'));
    const allTime = profileFields({ level, rank: 3, rankAllTime: true, planId: 'free' });
    assert.equal(allTime.find((f) => f.name === 'All-time rank').value, '#3');
    assert.ok(!allTime.some((f) => f.name === 'Rank'));
});
