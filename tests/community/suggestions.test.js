import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    nextVote, buildSuggestionMessage, isVotingOpen, takeSuggestionSlot, resetSuggestionCooldownsForTests, SUGGESTION_COOLDOWN_MS,
} = await import('../../src/services/community/suggestionService.js');

const row = (fields = {}) => ({
    id: 7, guild_id: 'g', user_id: '123', content: 'More cat pictures', status: 'pending',
    status_reason: null, decided_by: null, upvotes: 3, downvotes: 1, created_at: new Date('2026-10-01T00:00:00Z'), ...fields,
});

test('votes: one per member, changeable, same button withdraws', () => {
    assert.equal(nextVote(0, 1), 1);
    assert.equal(nextVote(1, -1), -1);
    assert.equal(nextVote(-1, -1), 0);
    assert.equal(nextVote(1, 1), 0);
});

test('message: counts on the embed and buttons; voting closes on approve/deny', () => {
    const open = buildSuggestionMessage(row(), { username: 'kit', displayAvatarURL: () => 'https://cdn.example/a.png' });
    const embed = open.embeds[0].data;
    assert.equal(embed.title, 'Suggestion #7');
    assert.match(embed.fields[0].value, /👍 3 {2}· {2}👎 1/);
    assert.equal(embed.fields[1].value, 'Open for votes');
    const [up, down] = open.components[0].components.map((button) => button.data);
    assert.equal(up.custom_id, 'suggest_vote:7:up');
    assert.equal(down.custom_id, 'suggest_vote:7:down');
    assert.equal(up.label, '3');
    assert.equal(up.disabled, false);
    assert.deepEqual(open.allowedMentions, { parse: [] });

    const denied = buildSuggestionMessage(row({ status: 'denied', status_reason: 'Not feasible', decided_by: '9' }));
    assert.equal(denied.embeds[0].data.fields[2].value, 'Not feasible');
    assert.ok(denied.components[0].components.every((button) => button.data.disabled));
    const considering = buildSuggestionMessage(row({ status: 'considering' }));
    assert.ok(considering.components[0].components.every((button) => !button.data.disabled));
    assert.equal(isVotingOpen('approved'), false);
});

test('cooldown per member between suggestions', () => {
    resetSuggestionCooldownsForTests();
    assert.equal(takeSuggestionSlot('g', 'u', 1000), 0);
    assert.equal(takeSuggestionSlot('g', 'u', 2000), SUGGESTION_COOLDOWN_MS - 1000);
    assert.equal(takeSuggestionSlot('g', 'other', 2000), 0);
    assert.equal(takeSuggestionSlot('g', 'u', 1000 + SUGGESTION_COOLDOWN_MS), 0);
});
