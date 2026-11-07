import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeaderboardReply } from '../src/commands/Leveling/leaderboard.js';

// An empty page is not a database error: it must be a normal reply, never a "Database Error" embed.
test('leaderboard reply: nobody with XP yet → a plain notice, not an error', () => {
    const reply = buildLeaderboardReply([], { page: 1, offset: 0 });
    const embed = reply.embeds[0].toJSON();
    assert.doesNotMatch(JSON.stringify(embed), /Database|error/i);
    assert.match(embed.description, /Nobody has any XP yet/);
});

test('leaderboard reply: a page past the end says so', () => {
    const embed = buildLeaderboardReply([], { page: 3, offset: 20 }).embeds[0].toJSON();
    assert.match(embed.description, /no members on page 3/);
});

test('leaderboard reply: rows are listed with rank and level', () => {
    const embed = buildLeaderboardReply([{ userId: '123456789012345678', level: 2, xp: 10, rank: 1 }], { page: 1, offset: 0 }).embeds[0].toJSON();
    assert.equal(embed.title, 'Level Leaderboard');
    assert.match(embed.fields[0].value, /\*\*1\.\*\* <@123456789012345678> - Level 2/);
});
