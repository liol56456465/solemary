import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    canGiveSecondOpinion, fitCodes, secondOpinionPayload, shouldAskSecondOpinion,
} from '../../src/services/automod/secondOpinion.js';

test('second opinion: about 5% of keeps, never at rate 0', () => {
    assert.equal(shouldAskSecondOpinion(0.05, 0.01), true);
    assert.equal(shouldAskSecondOpinion(0.05, 0.05), false);
    assert.equal(shouldAskSecondOpinion(0.05, 0.9), false);
    assert.equal(shouldAskSecondOpinion(0, 0), false);
});

test('second opinion: refuses the admin who kept it', () => {
    assert.equal(canGiveSecondOpinion('a', 'a'), false);
    assert.equal(canGiveSecondOpinion('b', 'a'), true);
    assert.equal(canGiveSecondOpinion(null, 'a'), false);
});

test('second opinion: codes fit the 100-character custom id, newest kept', () => {
    const prefix = 'amreview:2nd:confirm:12345678901234567890:';
    const codes = Array.from({ length: 12 }, (_, i) => `c${String(i).padStart(6, '0')}`);
    const fitted = fitCodes(codes, prefix);
    assert.ok((prefix + fitted).length <= 100);
    assert.equal(fitted.split(',').at(-1), 'c000011');
    assert.equal(fitCodes(['abc1234'], prefix), 'abc1234');
});

test('second opinion button: the keeper is refused before anything happens', async () => {
    const { handleReviewAction } = await import('../../src/services/automod/reviewCards.js');
    const interaction = { client: {}, guild: {}, user: { id: '111', username: 'amy' }, message: {} };
    await assert.rejects(handleReviewAction(interaction, ['2nd', 'confirm', '111', 'abc1234']), /different administrator/);
});

test('second opinion payload: no ping text, Confirm and Undo carry the keeper', () => {
    const payload = secondOpinionPayload('111', ['abc1234', 'def5678'], 'https://discord.com/channels/1/2/3');
    const embed = payload.embeds[0].data;
    assert.equal(payload.content, undefined);
    assert.match(embed.description, /^Kept by <@111> — a second admin can confirm or undo\./);
    assert.match(embed.description, /`abc1234` `def5678`/);
    const [confirm, undo] = payload.components[0].toJSON().components;
    assert.equal(confirm.custom_id, 'amreview:2nd:confirm:111:abc1234,def5678');
    assert.equal(undo.custom_id, 'amreview:2nd:undo:111:abc1234,def5678');
});
