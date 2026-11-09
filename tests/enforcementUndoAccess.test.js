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

// Review of wave 1: an older warn's undo could lift an automatic ban that a LATER warn triggered.
import { undoWouldLiftBan } from '../src/handlers/enforcementPanel.js';
import { nextWarnText } from '../src/services/enforcement/flowBuilder.js';

test('warn undo by the Moderator role: refused while an automatic ban is active, or when unsure', () => {
    const warn = undo({ type: 'warn' });
    assert.equal(undoWouldLiftBan(warn, { banned: true, activeBan: { is_auto: true } }), true);
    assert.equal(undoWouldLiftBan(warn, null), true, 'state unreadable: fail closed');
    assert.equal(undoWouldLiftBan(warn, { banned: true, activeBan: { is_auto: false } }), false, 'a manual ban is not lifted by a warn undo');
    assert.equal(undoWouldLiftBan(warn, { banned: false }), false);
    assert.equal(undoWouldLiftBan(undo({ type: 'mute' }), null), false, 'only warn undos can reach liftLadderBanForWarn');
});

test('next-warn line: none when the warn ladder is off', () => {
    assert.equal(nextWarnText({ level: 0, warns_since_level: 2, enabled: false }, { lang: 'en' }), null);
    assert.match(nextWarnText({ level: 0, warns_since_level: 2, enabled: true }, { lang: 'en' }), /automatic/i);
});
