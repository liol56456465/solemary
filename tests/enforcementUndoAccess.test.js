// Merge of beginner waves A1 (undo on the result card) and A2 (Moderator role outside Mewvo's servers):
// an undo is checked as the action it performs, so the Moderator role can never lift a ban through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoAccessAction } from '../src/handlers/enforcementPanel.js';
import { MODERATOR_PANEL_ACTIONS } from '../src/services/enforcement/panelAccess.js';

const undo = (over) => ({ kind: 'undo', type: 'warn', ladderBanCode: null, isLadderBan: false, ...over });

test('undo is guarded as the action it performs', () => {
    assert.equal(undoAccessAction(undo({ type: 'ban' })), 'unban');
    assert.equal(undoAccessAction(undo({ type: 'warn', ladderBanCode: 'abc23' })), 'unban', 'a warn that triggered a ladder ban lifts that ban');
    assert.equal(undoAccessAction(undo({ type: 'ban', isLadderBan: true })), 'unban');
    assert.equal(undoAccessAction(undo({ type: 'mute' })), 'unmute');
    assert.equal(undoAccessAction(undo({ type: 'warn' })), 'removewarn');
    assert.equal(undoAccessAction(undo({ type: 'kick' })), 'kick');
    assert.equal(undoAccessAction(null), null);
    assert.equal(undoAccessAction({ kind: 'flow', type: 'ban' }), null, 'not an undo flow');
});

test('the Moderator role may undo its own kinds of action, never a ban', () => {
    for (const type of ['warn', 'mute', 'kick']) {
        assert.ok(MODERATOR_PANEL_ACTIONS.includes(undoAccessAction(undo({ type }))), type);
    }
    assert.ok(!MODERATOR_PANEL_ACTIONS.includes(undoAccessAction(undo({ type: 'ban' }))));
    assert.ok(!MODERATOR_PANEL_ACTIONS.includes(undoAccessAction(undo({ type: 'warn', ladderBanCode: 'abc23' }))));
});
