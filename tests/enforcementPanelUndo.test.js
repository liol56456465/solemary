// The /enforcements panel's result card and flow steps (beginner audit 2026-11-09, items 1.2, 3.2,
// 3.3, 3.4, 3.7): "Undo (mistake)" / "Mistake? Remove the warn" on the result card, the Unban choice
// for an automatic ladder ban, the "Next warn" line and the warn DM's ban length, the explicit
// "permanent" duration and the second confirm, Confirm colours, and the plain wording.
// The ladder itself (voidCase steps it back, unban only keeps it) runs against the local database:
// tests/db/enforcementPanelUndo.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, PermissionFlagsBits } from 'discord.js';

const {
    confirmStyle, confirmationPayload, failureOutcome, failureText, handleEnforcementButton, panelSummaryLines, resultPayload,
    secondConfirmPayload, unbanChoicePayload, undoConfirmPayload, undoFlowFor, undoResultPayload,
} = await import('../src/handlers/enforcementPanel.js');
const { isPermanentWord, needsSecondConfirm, nextWarnText, parseFlowInput, warnStatusText } = await import('../src/services/enforcement/flowBuilder.js');
const { createFlow, getFlow } = await import('../src/services/enforcement/panelState.js');
const { formatPrecedent } = await import('../src/services/enforcement/precedentService.js');
const { warnDm } = await import('../src/services/enforcement/dmTemplates.js');
const { LANG_CODES, botText } = await import('../src/utils/botText.js');
const enfButtons = (await import('../src/interactions/buttons/enforcement/enforcement.js')).default;

const MOD = '500000000000000001';
const OTHER_USER = '500000000000000002';
const GUILD = '100000000000000777';
const TARGET = '300000000000000003';
const DAY = 24 * 60 * 60 * 1000;

const perms = (admin) => ({ has: (flag) => admin && (flag === PermissionFlagsBits.Administrator || Array.isArray(flag)) });

/** A fake button click by `userId` in GUILD; records every response. */
function click({ userId = MOD, admin = true, guildId = GUILD } = {}) {
    const calls = { update: [], reply: [], edit: [], modal: [], deferred: 0 };
    const interaction = {
        id: 'i1',
        user: { id: userId, username: 'mod' },
        guildId,
        guild: { id: guildId },
        inGuild: () => Boolean(guildId),
        member: { id: userId, guild: { ownerId: '1' }, permissions: perms(admin) },
        update: async (payload) => { calls.update.push(payload); interaction.replied = true; },
        reply: async (payload) => { calls.reply.push(payload); interaction.replied = true; },
        followUp: async (payload) => { calls.reply.push(payload); },
        editReply: async (payload) => { calls.edit.push(payload); },
        deferUpdate: async () => { calls.deferred += 1; interaction.deferred = true; },
        showModal: async (modal) => { calls.modal.push(modal); },
        isRepliable: () => true,
        isMessageComponent: () => true,
        deferred: false,
        replied: false,
    };
    return { interaction, calls };
}

const undoFlow = (patch = {}) => ({
    kind: 'undo', type: 'warn', moderatorId: MOD, guildId: GUILD, targetId: TARGET, targetUsername: 'kit',
    caseCode: 'wwwww', ladderBanCode: null, isLadderBan: false, ...patch,
});

// ── 3.3 / 1.2: the result card's undo button ───────────────────────────────

test('result card: every case gets "Undo (mistake)"; a warn that triggered a ladder ban gets "Mistake? Remove the warn"', () => {
    const mute = resultPayload({ type: 'mute', targetUsername: 'kit' }, { record: { case_code: 'mmmmm', name: 'kit mute 1' }, dmDelivered: true, notes: [] },
        { moderatorId: MOD, undoNonce: 'n1' });
    const [button] = mute.components[0].components;
    assert.equal(button.data.label, 'Undo (mistake)');
    assert.equal(button.data.custom_id, `enf:undo:${MOD}:n1`);
    assert.deepEqual(mute.allowedMentions, { parse: [] });

    const ladder = resultPayload({ type: 'warn', targetUsername: 'kit' }, {
        record: { case_code: 'wwwww', name: 'kit warn 3' }, banRecord: { case_code: 'bbbbb' }, dmDelivered: true, notes: [],
    }, { moderatorId: MOD, undoNonce: 'n2' });
    assert.equal(ladder.components[0].components[0].data.label, 'Mistake? Remove the warn');

    // Lift actions create no case, so there is nothing to undo; no nonce → no button (old callers).
    assert.deepEqual(resultPayload({ type: 'unban', targetUsername: 'kit' }, { record: null, dmDelivered: null, notes: [] }, { moderatorId: MOD, undoNonce: 'n3' }).components, []);
    assert.deepEqual(resultPayload({ type: 'mute', targetUsername: 'kit' }, { record: { case_code: 'x', name: 'n' }, notes: [] }).components, []);
});

test('undoFlowFor: the warn case is undone (its ladder ban rides along); lifts have no undo', () => {
    const flow = { type: 'warn', moderatorId: MOD, targetId: TARGET, targetUsername: 'kit' };
    const undo = undoFlowFor(flow, { record: { case_code: 'wwwww' }, banRecord: { case_code: 'bbbbb' } }, GUILD);
    assert.deepEqual({ kind: undo.kind, caseCode: undo.caseCode, ladderBanCode: undo.ladderBanCode, guildId: undo.guildId, moderatorId: undo.moderatorId },
        { kind: 'undo', caseCode: 'wwwww', ladderBanCode: 'bbbbb', guildId: GUILD, moderatorId: MOD });
    assert.equal(undoFlowFor({ ...flow, type: 'mute' }, { record: { case_code: 'm' }, banRecord: { case_code: 'b' } }, GUILD).ladderBanCode, null);
    assert.equal(undoFlowFor({ ...flow, type: 'unban' }, { record: null }, GUILD), null);
    // The warn reached the limit but the automatic ban failed: voiding would not step the stage back.
    assert.equal(undoFlowFor({ ...flow, ladder: { level: 0, warns_since_level: 2 } }, { record: { case_code: 'w' }, banRecord: null }, GUILD), null);
    assert.ok(undoFlowFor({ ...flow, ladder: { level: 0, warns_since_level: 1 } }, { record: { case_code: 'w' }, banRecord: null }, GUILD));
});

test('undo confirm step says exactly what will happen, per case type', () => {
    const text = (patch) => undoConfirmPayload(undoFlow(patch), MOD, 'n').embeds[0].data.description;
    assert.match(text({ ladderBanCode: 'bbbbb' }), /Warn `wwwww` is removed and the automatic ban `bbbbb` it caused is lifted\. The warning stage goes back one step\./);
    assert.match(text({}), /Warn `wwwww` is removed: it no longer counts/);
    assert.match(text({ type: 'ban', caseCode: 'bbbbb', isLadderBan: true }), /Automatic ban `bbbbb` is removed: they are unbanned, the warn that caused it is removed and the warning stage goes back one step\./);
    assert.match(text({ type: 'ban', caseCode: 'bbbbb' }), /Ban `bbbbb` is removed and they are unbanned\./);
    assert.match(text({ type: 'mute', caseCode: 'mmmmm' }), /Mute `mmmmm` is removed and they are unmuted\./);
    assert.match(text({ type: 'kick', caseCode: 'kkkkk' }), /A kick cannot be reversed/);
    assert.match(text({}), /They get a DM saying it was a mistake/);
    const { components } = undoConfirmPayload(undoFlow(), MOD, 'n');
    assert.deepEqual(components[0].components.map((b) => [b.data.custom_id, b.data.style]),
        [[`enf:undook:${MOD}:n`, ButtonStyle.Primary], [`enf:cancel:${MOD}:n`, ButtonStyle.Secondary]]);
});

test('undo result: removed, the warnings line as it is now, the service notes and the DM outcome', () => {
    const { embeds } = undoResultPayload(undoFlow({ ladderBanCode: 'bbbbb' }),
        { record: { case_code: 'wwwww' }, notes: ['note one'], dmDelivered: false }, { ladderAfter: { level: 0, warns_since_level: 2 } });
    assert.equal(embeds[0].data.title, 'Undone: kit');
    assert.equal(embeds[0].data.description, [
        '`wwwww` was removed (a mistake); it no longer counts.',
        '**Warnings:** 2 — the next one bans for 7 days',
        'note one',
        'DM to user: not delivered.',
    ].join('\n'));
});

// ── 1.2: Unban of an automatic ladder ban offers the choice ────────────────

test('Unban of an automatic ladder ban: "Unban only (stage stays)" or "Remove the warn (stage goes back)"', () => {
    const payload = unbanChoicePayload({ type: 'unban', targetUsername: 'kit' }, MOD, 'u1', 'v1', 'bbbbb');
    assert.match(payload.embeds[0].data.description, /Ban `bbbbb` was automatic/);
    assert.match(payload.embeds[0].data.description, /\*\*Unban only \(stage stays\):\*\* the ban ends, but the warning stage stays/);
    assert.match(payload.embeds[0].data.description, /\*\*Remove the warn \(stage goes back\):\*\*/);
    assert.deepEqual(payload.components[0].components.map((b) => [b.data.label, b.data.custom_id]), [
        ['Unban only (stage stays)', `enf:unbanonly:${MOD}:u1`],
        ['Remove the warn (stage goes back)', `enf:undo:${MOD}:v1`],
        ['Cancel', `enf:cancel:${MOD}:u1`],
    ]);
});

test('the 3-second safety net: unban:ladder is acknowledged normally, "Unban only" is the step that opens the form', () => {
    const enf = enfButtons.find((b) => b.name === 'enf');
    assert.equal(enf.opensModal(null, ['act', MOD, TARGET, 'unban']), true);
    assert.equal(enf.opensModal(null, ['act', MOD, TARGET, 'unban', 'ladder']), false);
    assert.equal(enf.opensModal(null, ['unbanonly', MOD, 'n']), true);
    assert.equal(enf.opensModal(null, ['undo', MOD, 'n']), false);
    assert.equal(enf.opensModal(null, ['undook', MOD, 'n']), false);
});

test('"Unban only" opens the normal unban form for that flow', async () => {
    const nonce = createFlow({ type: 'unban', moderatorId: MOD, targetId: TARGET, targetUsername: 'kit', nameIsDefault: true });
    const { interaction, calls } = click();
    await handleEnforcementButton(interaction, {}, ['unbanonly', MOD, nonce]);
    assert.equal(calls.modal.length, 1);
    assert.equal(calls.modal[0].data.custom_id, `enfmodal:lift:${MOD}:${nonce}`);
});

// ── 3.3: the undo click re-checks the moderator, access and the server ────

test('undo: another user, a non-administrator or another server is refused and the undo stays unused', async () => {
    for (const step of ['undo', 'undook']) {
        const nonce = createFlow(undoFlow());
        const stranger = click({ userId: OTHER_USER });
        await handleEnforcementButton(stranger.interaction, {}, [step, MOD, nonce]);
        assert.equal(stranger.calls.update.length + stranger.calls.edit.length, 0, `${step}: nothing shown to another user`);
        assert.equal(stranger.calls.reply.length, 1, `${step}: refused`);

        const lostAdmin = click({ admin: false });
        await handleEnforcementButton(lostAdmin.interaction, {}, [step, MOD, nonce]);
        assert.equal(lostAdmin.calls.reply.length, 1, `${step}: refused without Administrator`);
        assert.equal(lostAdmin.calls.deferred, 0);
        assert.ok(getFlow(nonce), `${step}: the undo is still there`);
    }
    // Opened in another server: never voids a case there.
    const nonce = createFlow(undoFlow({ guildId: '100000000000000999' }));
    const elsewhere = click();
    await handleEnforcementButton(elsewhere.interaction, {}, ['undook', MOD, nonce]);
    assert.equal(elsewhere.calls.edit[0].embeds[0].data.title, 'Panel expired');
});

test('undo: the moderator sees the confirm step first (an immediate update, no database)', async () => {
    const nonce = createFlow(undoFlow({ ladderBanCode: 'bbbbb' }));
    const { interaction, calls } = click();
    await handleEnforcementButton(interaction, {}, ['undo', MOD, nonce]);
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].embeds[0].data.title, 'Undo (mistake): kit');
    assert.ok(getFlow(nonce), 'the confirm step keeps the undo for "Yes, remove the case"');
});

test('an undo nonce can never run as a normal Confirm, and a normal flow is not an undo', async () => {
    const undoNonce = createFlow(undoFlow());
    const a = click();
    await handleEnforcementButton(a.interaction, {}, ['confirm', MOD, undoNonce]);
    assert.equal(a.calls.edit[0].embeds[0].data.title, 'Panel expired');
    const flowNonce = createFlow({ type: 'warn', moderatorId: MOD, targetId: TARGET, targetUsername: 'kit' });
    const b = click();
    await handleEnforcementButton(b.interaction, {}, ['undo', MOD, flowNonce]);
    assert.equal(b.calls.update[0].embeds[0].data.title, 'Panel expired');
});

// ── 3.2: what the next warn does ───────────────────────────────────────────

test('result card after a warn: the "Next warn" line from previewWarn on the ladder as the warn left it', () => {
    const card = (ladderAfter) => resultPayload({ type: 'warn', targetUsername: 'kit' }, { record: { case_code: 'w', name: 'kit warn 2' }, dmDelivered: true, notes: ['n'] },
        { ladderAfter }).embeds[0].data.description;
    assert.match(card({ level: 0, warns_since_level: 2 }), /\*\*Next warn:\*\* automatic ban for 7 days\.\nn$/);
    assert.match(card({ level: 0, warns_since_level: 1 }), /\*\*Next warn:\*\* warning 2 of 3, no ban yet\./);
    assert.match(card({ level: 1, warns_since_level: 0 }), /\*\*Next warn:\*\* automatic ban for 1 month\./);
    assert.match(card({ level: 2, warns_since_level: 0 }), /\*\*Next warn:\*\* automatic permanent ban\./);
    assert.doesNotMatch(card(null), /Next warn/);
    assert.doesNotMatch(resultPayload({ type: 'mute', targetUsername: 'kit' }, { record: null, notes: [] }, { ladderAfter: { level: 0, warns_since_level: 2 } }).embeds[0].data.description, /Next warn/);
    for (const lang of LANG_CODES) {
        for (const ladder of [{ level: 0, warns_since_level: 0 }, { level: 0, warns_since_level: 2 }, { level: 2, warns_since_level: 0 }]) {
            assert.ok(nextWarnText(ladder, { lang }).length > 10, lang);
        }
    }
});

test('the warn DM names the ban length at the limit, in every language', () => {
    const rec = { case_code: 'wwwww', guild_id: '1', reason: 'Spam', created_at: new Date(0), ladder_level_after: 0, dm_delivered: null };
    assert.match(warnDm(rec, 2), /At 3 warnings you will be banned for 7 days\./);
    for (const lang of LANG_CODES) {
        const dm = warnDm(rec, 2, { lang });
        assert.ok(dm.includes(botText(lang).tp('enforcement.duration.day', 7)), `${lang}: ${dm}`);
        assert.ok(!/\{[a-zA-Z]+\}/.test(dm), `${lang}: no placeholder left`);
    }
});

// ── 3.4: explicit permanent, second confirm, Confirm colours ───────────────

test('ban duration: blank is refused in the panel, "permanent" (or the language\'s word) is permanent; the dashboard keeps blank = permanent', () => {
    const flow = { type: 'ban', reasonKey: 'spam' };
    assert.equal(parseFlowInput(flow, { durationInput: '' }, { explicitPermanent: true }).error, 'A ban needs a duration (e.g. 7d) or the word permanent.');
    for (const word of ['permanent', 'Permanent', 'perm', 'forever']) {
        const { patch, error } = parseFlowInput(flow, { durationInput: word, unappealable: true }, { explicitPermanent: true });
        assert.equal(error, null, word);
        assert.equal(patch.durationMs, null, word);
        assert.equal(patch.unappealable, true);
    }
    assert.equal(parseFlowInput(flow, { durationInput: 'Dauerhaft' }, { lang: 'de', explicitPermanent: true }).patch.durationMs, null);
    assert.equal(parseFlowInput(flow, { durationInput: 'na stałe' }, { lang: 'pl', explicitPermanent: true }).patch.durationMs, null);
    assert.equal(parseFlowInput(flow, { durationInput: '7d' }, { explicitPermanent: true }).patch.durationMs, 7 * DAY);
    // A mute never takes "permanent".
    assert.match(parseFlowInput({ type: 'mute', reasonKey: 'spam' }, { durationInput: 'permanent' }, { explicitPermanent: true }).error, /not a valid duration/);
    // The dashboard (no explicitPermanent): unchanged.
    const dash = parseFlowInput(flow, { durationInput: '' });
    assert.equal(dash.error, null);
    assert.equal(dash.patch.durationMs, null);
    assert.equal(isPermanentWord('7d'), false);
    for (const lang of LANG_CODES) {
        assert.ok(isPermanentWord(botText(lang).t('enforcement.duration.permanent'), lang), lang);
        assert.ok(botText(lang).t('staff.panel.modal.durationBan').length <= 100, `${lang} durationBan`);
    }
});

test('a permanent ban the member cannot appeal asks a second time; Confirm runs nothing yet', async () => {
    assert.equal(needsSecondConfirm({ type: 'ban', durationMs: null, unappealable: true }), true);
    assert.equal(needsSecondConfirm({ type: 'ban', durationMs: null, unappealable: false }), false);
    assert.equal(needsSecondConfirm({ type: 'ban', durationMs: 7 * DAY, unappealable: true }), false);
    assert.equal(needsSecondConfirm({ type: 'mute', durationMs: null, unappealable: true }), false);

    const nonce = createFlow({ type: 'ban', moderatorId: MOD, targetId: TARGET, targetUsername: 'kit', durationMs: null, unappealable: true, reason: 'Spam' });
    const { interaction, calls } = click();
    await handleEnforcementButton(interaction, {}, ['confirm', MOD, nonce]);
    assert.equal(calls.deferred, 1);
    const shown = calls.edit[0];
    assert.equal(shown.embeds[0].data.title, 'Permanent ban, no appeal');
    assert.match(shown.embeds[0].data.description, /\*\*kit\*\* will be banned \*\*permanently\*\* and \*\*cannot appeal\*\*/);
    assert.deepEqual(shown.components[0].components.map((b) => [b.data.custom_id, b.data.style]), [
        [`enf:final:${MOD}:${nonce}`, ButtonStyle.Danger],
        [`enf:details:${MOD}:${nonce}`, ButtonStyle.Secondary],
        [`enf:cancel:${MOD}:${nonce}`, ButtonStyle.Secondary],
    ]);
    assert.ok(getFlow(nonce), 'the ban has not run: the flow is still waiting');
    assert.deepEqual(secondConfirmPayload({ targetUsername: 'kit' }, MOD, 'n').allowedMentions, { parse: [] });
});

test('Confirm colour: red only for ban, kick and a warn that bans; blue for mute/warn; green for lifts', () => {
    assert.equal(confirmStyle({ type: 'ban' }), ButtonStyle.Danger);
    assert.equal(confirmStyle({ type: 'kick' }), ButtonStyle.Danger);
    assert.equal(confirmStyle({ type: 'mute' }), ButtonStyle.Primary);
    assert.equal(confirmStyle({ type: 'warn', ladder: { level: 0, warns_since_level: 0 } }), ButtonStyle.Primary);
    assert.equal(confirmStyle({ type: 'warn' }), ButtonStyle.Primary);
    assert.equal(confirmStyle({ type: 'warn', ladder: { level: 0, warns_since_level: 2 } }), ButtonStyle.Danger);
    for (const type of ['unban', 'unmute', 'removewarn']) assert.equal(confirmStyle({ type }), ButtonStyle.Success, type);
    const payload = confirmationPayload({ type: 'unmute', targetUsername: 'kit', targetId: '1', reason: 'r' }, MOD, 'n');
    assert.equal(payload.components[0].components[0].data.style, ButtonStyle.Success);
});

// ── 3.7: wording ───────────────────────────────────────────────────────────

test('panel wording: one warnings number in plain words, no two "of 3" side by side', () => {
    const user = { id: '1', username: 'kit', createdAt: new Date(0) };
    const lines = (ladder) => panelSummaryLines(user, { member: null, banned: false, ladder, activeBan: null, activeMute: null, muted: false });
    assert.equal(lines({ level: 0, warns_since_level: 2 })[3], '**Warnings:** 2 — the next one bans for 7 days');
    assert.equal(lines({ level: 0, warns_since_level: 0 })[3], '**Warnings:** 0 — at 3 they are banned for 7 days');
    assert.equal(lines({ level: 2, warns_since_level: 0 })[3], '**Warnings:** 0 — the next one bans permanently · **Warning bans so far:** 2');
    for (const lang of LANG_CODES) {
        for (const level of [0, 1, 2, 3]) {
            const text = warnStatusText({ level, warns_since_level: 0 }, { lang });
            assert.ok(text.length > 10 && !/\{[a-zA-Z]+\}/.test(text), `${lang} ${level}: ${text}`);
            assert.ok(!/of 3/.test(text), `${lang}: ${text}`);
        }
    }
});

test('confirm step: "No similar cases yet" is hidden, a real comparison stays', () => {
    const flow = { type: 'warn', targetUsername: 'kit', targetId: '1', reason: 'Spam', reasonKey: 'spam', name: 'kit warn 1', nameIsDefault: true };
    const none = formatPrecedent('Spam', []);
    assert.match(none, /No similar cases yet/);
    const quiet = confirmationPayload({ ...flow, precedent: none, memberHint: 'M' }, MOD, 'n').embeds[0].data.description;
    assert.doesNotMatch(quiet, /Similar cases/);
    assert.match(quiet, /-# M/);
    const real = formatPrecedent('Spam', [{ type: 'warn', duration_ms: null, count: 4, overturned: 0 }]);
    assert.match(confirmationPayload({ ...flow, precedent: real }, MOD, 'n').embeds[0].data.description, /Similar cases/);
    for (const lang of LANG_CODES) {
        const text = confirmationPayload({ ...flow, precedent: formatPrecedent('Spam', [], { lang }) }, MOD, 'n', { lang }).embeds[0].data.description;
        assert.ok(!text.includes(formatPrecedent('Spam', [], { lang })), lang);
    }
});

test('a failed action says whether anything happened (checked again), never "nothing changed" on a guess', async () => {
    const guild = { id: GUILD };
    const startedAt = Date.now();
    const cases = (rows) => ({ listCasesForUser: async () => ({ rows }) });
    const warn = { type: 'warn', targetId: TARGET };
    assert.deepEqual(await failureOutcome({ guild, flow: warn, moderatorId: MOD, startedAt,
        deps: cases([{ type: 'warn', moderator_id: MOD, created_at: new Date(), case_code: 'wwwww' }]) }), { outcome: 'happened', code: 'wwwww' });
    assert.deepEqual(await failureOutcome({ guild, flow: warn, moderatorId: MOD, startedAt,
        deps: cases([{ type: 'warn', moderator_id: OTHER_USER, created_at: new Date(), case_code: 'x' }, { type: 'warn', moderator_id: MOD, created_at: new Date(0), case_code: 'old' }]) }),
    { outcome: 'notHappened' });
    assert.deepEqual(await failureOutcome({ guild, flow: warn, moderatorId: MOD, startedAt, deps: { listCasesForUser: async () => { throw new Error('db down'); } } }), { outcome: 'unknown' });
    const state = (s) => ({ getTargetState: async () => s });
    assert.deepEqual(await failureOutcome({ guild, flow: { type: 'unban', targetId: TARGET }, moderatorId: MOD, startedAt, deps: state({ banned: true }) }), { outcome: 'notHappened' });
    assert.deepEqual(await failureOutcome({ guild, flow: { type: 'unban', targetId: TARGET }, moderatorId: MOD, startedAt, deps: state({ banned: false }) }), { outcome: 'happened', code: null });
    assert.deepEqual(await failureOutcome({ guild, flow: { type: 'unmute', targetId: TARGET }, moderatorId: MOD, startedAt, deps: state({ muted: true }) }), { outcome: 'notHappened' });
    const byCode = (row) => ({ getCaseByCode: async () => row });
    assert.deepEqual(await failureOutcome({ guild, flow: { type: 'removewarn', warnCode: 'w' }, moderatorId: MOD, startedAt, deps: byCode({ status: 'revoked' }) }), { outcome: 'happened', code: null });
    assert.deepEqual(await failureOutcome({ guild, flow: { type: 'removewarn', warnCode: 'w' }, moderatorId: MOD, startedAt, deps: byCode({ status: 'active' }) }), { outcome: 'notHappened' });
    // Undo: voidCase lifts first and marks last, so an open case that is no longer in effect is "unknown".
    assert.deepEqual(await failureOutcome({ guild, flow: undoFlow(), moderatorId: MOD, startedAt, deps: byCode({ voided_at: new Date() }) }), { outcome: 'happened', code: 'wwwww' });
    assert.deepEqual(await failureOutcome({ guild, flow: undoFlow(), moderatorId: MOD, startedAt, deps: byCode({ status: 'active' }) }), { outcome: 'notHappened' });
    assert.deepEqual(await failureOutcome({ guild, flow: undoFlow({ type: 'ban' }), moderatorId: MOD, startedAt, deps: { ...byCode({ status: 'active' }), ...state({ banned: false }) } }), { outcome: 'unknown' });
    assert.deepEqual(await failureOutcome({ guild, flow: undoFlow({ type: 'ban' }), moderatorId: MOD, startedAt, deps: { ...byCode({ status: 'active' }), ...state({ banned: true }) } }), { outcome: 'notHappened' });
    assert.deepEqual(await failureOutcome({ guild, flow: undoFlow(), moderatorId: MOD, startedAt, deps: byCode({ status: 'revoked' }) }), { outcome: 'unknown' });

    // Review fixes: a case from before the click is never credited; "not banned" alone is not proof.
    assert.deepEqual(await failureOutcome({ guild, flow: warn, moderatorId: MOD, startedAt, lastIdBefore: 41,
        deps: cases([{ id: 41, type: 'warn', moderator_id: MOD, created_at: new Date(), case_code: 'older' }]) }), { outcome: 'notHappened' });
    assert.deepEqual(await failureOutcome({ guild, flow: warn, moderatorId: MOD, startedAt, lastIdBefore: 41,
        deps: cases([{ id: '42', type: 'warn', moderator_id: MOD, created_at: new Date(0), case_code: 'newer' }]) }), { outcome: 'happened', code: 'newer' });
    assert.deepEqual(await failureOutcome({ guild, flow: { type: 'unban', targetId: TARGET }, moderatorId: MOD, startedAt,
        deps: state({ banned: false, activeBan: { case_code: 'b' } }) }), { outcome: 'unknown' });

    assert.equal(failureText({ outcome: 'happened', code: 'wwwww' }), 'The action went through (case `wwwww`), but a later step failed. Check /background and do not run it again.');
    assert.equal(failureText({ outcome: 'notHappened' }), 'Nothing was changed. You can try again with /enforcements.');
    assert.match(failureText({ outcome: 'unknown' }), /not clear whether anything changed/);
});

// ── Every language: new texts present and within Discord's limits ───────────

test('every language: the new buttons fit (80) and the new embeds fit with long input', () => {
    const buttons = ['undo', 'removeWarnMistake', 'confirmUndo', 'unbanOnly', 'removeWarnStage', 'confirmPermanent'];
    const long = 'w'.repeat(32);
    for (const lang of LANG_CODES) {
        const tr = botText(lang);
        for (const key of buttons) {
            const label = tr.t(`staff.panel.button.${key}`);
            assert.ok(label && label.length <= 80, `${lang} ${key}`);
            if (lang !== 'en') assert.notEqual(label, botText('en').t(`staff.panel.button.${key}`), `${lang} ${key} is translated`);
        }
        const embeds = [
            undoConfirmPayload(undoFlow({ targetUsername: long, ladderBanCode: 'bbbbbbb' }), MOD, 'n', { lang }).embeds[0],
            undoResultPayload(undoFlow({ targetUsername: long }), { record: { case_code: 'wwwwwww' }, notes: Array.from({ length: 8 }, () => 'z'.repeat(800)), dmDelivered: true },
                { lang, ladderAfter: { level: 2, warns_since_level: 0 } }).embeds[0],
            unbanChoicePayload({ type: 'unban', targetUsername: long }, MOD, 'u', 'v', 'bbbbbbb', { lang }).embeds[0],
            secondConfirmPayload({ targetUsername: long }, MOD, 'n', { lang }).embeds[0],
        ];
        for (const embed of embeds) {
            const d = embed.data;
            assert.ok((d.title || '').length <= 256 && (d.description || '').length <= 4096, `${lang}: ${d.title}`);
            assert.ok(!/\{[a-zA-Z]+\}/.test(d.description || ''), `${lang}: placeholder left in ${d.title}`);
        }
        for (const outcome of [{ outcome: 'happened', code: 'abcde' }, { outcome: 'happened', code: null }, { outcome: 'notHappened' }, { outcome: 'unknown' }]) {
            assert.ok(failureText(outcome, { lang }).length > 10, lang);
        }
    }
});
