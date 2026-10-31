// /profile (commands/Leveling/profile.js): the card shows only what exists, the progress bar
// is bounded, someone else's profile is admin-only, everyone may see their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileFields, progressLine } from '../src/commands/Leveling/profile.js';
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
