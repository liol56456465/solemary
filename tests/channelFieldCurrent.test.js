// Bug (owner, 2026-11-14): a saved channel that was deleted showed as "missing" in its picker, and
// saving the form then failed on that field, so nothing else on the form could be saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { channelField } from '../src/services/dashboard/forms.js';

const LIVE = '940000000000000001';
const GONE = '940000000000000002';
const guild = { channels: { cache: new Map([[LIVE, { id: LIVE, type: ChannelType.GuildText }]]) } };

test('channelField: the stored channel sent back unchanged is kept even when it was deleted', () => {
    assert.equal(channelField(guild, { c: GONE }, 'c', { current: GONE }), GONE);
    assert.equal(channelField(guild, { c: LIVE }, 'c', { current: GONE }), LIVE, 'picking a new one still works');
    assert.equal(channelField(guild, { c: '' }, 'c', { current: GONE }), null, 'clearing still works');
});

test('channelField: a deleted channel that is not the stored one is still refused', () => {
    assert.throws(() => channelField(guild, { c: GONE }, 'c'), /not in the server/);
    assert.throws(() => channelField(guild, { c: GONE }, 'c', { current: LIVE }), /not in the server/);
});
