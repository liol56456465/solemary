// flowBuilder.js — builds the "flow" object executeAction runs, shared by the
// /enforcements panel (handlers/enforcementPanel.js) and the web dashboard
// (services/dashboard/enforcementPages.js), so both build exactly the same flow for
// the same inputs: same reasons, duration rules, default names, unappealable default,
// hierarchy and bot permission checks, ladder preview, evidence capture and precedent.
//
// A flow: { type, moderatorId, targetId, targetUsername, reasonKey, reasonSource,
// reason, customReason, durationInput, durationMs, name, nameIsDefault, unappealable,
// evidenceInput, evidence, ladder, precedent, memberHint, warnCode, sourceMessageUrl,
// prefetchedExcerpts }. Steps:
//   startFlow → reasonPatch (record actions) → parseFlowInput → completeFlowDetails
//   startFlow → liftReasonPatch (unban / unmute / remove warn)
// then executeAction({ guild, moderator, targetUser, flow }) and attachFlowEvidence.

import { enforcementConfig, CUSTOM_REASON_KEY, getReason } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { assertBotPermissions, assertCanTarget, getLadder, getTargetState, previewWarn } from './enforcementService.js';
import { isNameTaken, nextDefaultName } from './caseService.js';
import { addEvidence, captureLinks, MAX_LINKS_PER_FORM, parseEvidenceUrls } from './evidenceService.js';
import { formatDuration, parseDuration, truncate } from './format.js';
import { memberLadderHint, precedentHint, PRECEDENT_UNAVAILABLE } from './precedentService.js';

export const ACTION_LABELS = {
    ban: 'Ban',
    kick: 'Kick',
    mute: 'Mute',
    warn: 'Warn',
    unban: 'Unban',
    unmute: 'Unmute',
    removewarn: 'Remove warn',
};
export const ACTION_TYPES = Object.keys(ACTION_LABELS);
/** Actions that create a case (reason select, details form, evidence). */
export const RECORD_ACTIONS = new Set(['ban', 'kick', 'mute', 'warn']);
/** Actions that lift something (optional reason only). */
export const LIFT_ACTIONS = new Set(['unban', 'unmute', 'removewarn']);

/** The actions offered for a target's current state (getTargetState). */
export function availableActions(state) {
    const actions = [];
    if (!state.banned) actions.push('ban');
    if (state.member) actions.push('kick');
    if (state.member && !state.muted) actions.push('mute');
    if (state.member) actions.push('warn');
    if (state.banned) actions.push('unban');
    if (state.muted) actions.push('unmute');
    if (state.ladder.warns_since_level > 0) actions.push('removewarn');
    return actions;
}

/** A new flow for `type` against `targetUser`, started by `moderatorId`. */
export function startFlow({ type, moderatorId, targetUser }) {
    return {
        type,
        moderatorId,
        targetId: targetUser.id,
        targetUsername: targetUser.username,
        nameIsDefault: true,
    };
}

/** The patch after a reason was picked (a prebuilt key or CUSTOM_REASON_KEY). */
export function reasonPatch(flow, reasonKey) {
    const reason = getReason(reasonKey);
    return {
        reasonKey,
        reasonSource: reason ? 'prebuilt' : 'custom',
        reason: reason ? reason.label : flow.customReason,
        // Severe reasons pre-check "Unappealable"; the moderator can still untick it.
        unappealable: flow.type === 'ban' ? Boolean(reason?.severe) : false,
    };
}

/** True for a reason key the panel offers (prebuilt or custom). */
export function isKnownReasonKey(key) {
    return key === CUSTOM_REASON_KEY || Boolean(getReason(key));
}

/** The patch for an unban / unmute / remove warn: the optional reason, or the default. */
export function liftReasonPatch(flow, reason, via = '/enforcements') {
    const text = String(reason || '').trim();
    return { reason: text || `${ACTION_LABELS[flow.type]} via ${via}` };
}

/**
 * Validates the details form (the panel's modal, the dashboard's form) for a record
 * action. input: { customReason, durationInput, unappealable, evidenceInput }.
 * Returns { patch, error }: on an error, `patch` holds what was parsed so far (the
 * panel keeps it for "Try again"). Pure.
 */
export function parseFlowInput(flow, input = {}) {
    const patch = {};
    if (flow.reasonKey === CUSTOM_REASON_KEY) {
        patch.customReason = String(input.customReason || '').trim();
        patch.reason = patch.customReason;
        if (!patch.reason) return { patch, error: 'A custom reason is required.' };
    }

    if (flow.type === 'ban' || flow.type === 'mute') {
        const raw = String(input.durationInput || '').trim();
        patch.durationInput = raw;
        if (!raw && flow.type === 'mute') return { patch, error: 'A mute needs a duration, e.g. 30m, 24h, 7d or 1mo.' };
        patch.durationMs = raw ? parseDuration(raw) : null;
        if (raw && patch.durationMs == null) {
            return { patch, error: `"${truncate(raw, 20)}" is not a valid duration. Use formats like 30m, 24h, 7d or 1mo.` };
        }
    }

    if (flow.type === 'ban') {
        patch.unappealable = Boolean(input.unappealable);
    }

    const evidenceRaw = String(input.evidenceInput || '').trim();
    patch.evidenceInput = evidenceRaw;
    const evidenceEntries = parseEvidenceUrls(evidenceRaw);
    if (evidenceRaw && evidenceEntries.length === 0) {
        return { patch, error: 'Evidence must be links (e.g. a Discord message link: right-click a message → Copy Message Link).' };
    }
    if (evidenceEntries.length > MAX_LINKS_PER_FORM) {
        return { patch, error: `At most ${MAX_LINKS_PER_FORM} evidence links here; add more afterwards with /case evidence add.` };
    }
    patch.evidenceEntries = evidenceEntries;
    return { patch, error: null };
}

export const defaultFlowDeps = {
    isNameTaken, nextDefaultName, assertBotPermissions, assertCanTarget, getTargetState, captureLinks, precedentHint,
    getLadder,
};

/**
 * The second half of the details step (needs Discord and the database): the case name
 * (custom → must be free; blank → the next default name), an early hierarchy and bot
 * permission check (both run again on execute), the warn ladder for the preview, the
 * evidence excerpts (captured now, so they survive the message being deleted) and the
 * consistency hints (similar cases + the target's ladder). Returns { patch, error, fatal }:
 *   error — the moderator can fix it (a name already used); keep the flow
 *   fatal — the action cannot run (hierarchy, missing permissions); drop the flow
 */
export async function completeFlowDetails({ guild, moderator, targetUser, flow, patch: parsed, customName = '', deps: depsIn = defaultFlowDeps }) {
    const deps = { ...defaultFlowDeps, ...depsIn };
    const { evidenceEntries = [], ...patch } = parsed;
    const name = String(customName || '').trim();
    if (name) {
        patch.name = name;
        patch.nameIsDefault = false;
        if (await deps.isNameTaken(guild.id, name)) {
            return {
                patch: { ...patch, name: undefined, nameIsDefault: true },
                error: `A record named **${truncate(name, 100)}** already exists in this server. Pick another name.`,
                fatal: null,
            };
        }
    } else {
        patch.name = await deps.nextDefaultName(guild.id, targetUser.id, targetUser.username, flow.type);
        patch.nameIsDefault = true;
    }

    try {
        deps.assertBotPermissions(guild);
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        deps.assertCanTarget(guild, moderator, targetUser.id, targetMember, flow.type);
    } catch (error) {
        return { patch, error: null, fatal: error.userMessage || error.message };
    }

    if (flow.type === 'warn') {
        patch.ladder = (await deps.getTargetState(guild, targetUser.id)).ladder;
    }

    // The consistency hints wait briefly at most and say "unavailable right now" on any
    // problem; the .catch guards a replaced dependency that throws anyway.
    [patch.evidence, patch.precedent, patch.memberHint] = await Promise.all([
        deps.captureLinks(guild, evidenceEntries, { prefetched: flow.prefetchedExcerpts }),
        Promise.resolve().then(() => deps.precedentHint(guild.id, flow.reasonKey, getReason(flow.reasonKey)?.label || flow.reasonKey))
            .catch(() => PRECEDENT_UNAVAILABLE),
        memberLadderHint(guild.id, targetUser.id, { ladder: patch.ladder, getLadder: deps.getLadder }),
    ]);
    return { patch, error: null, fatal: null };
}

/** What a warn does at this ladder state, as one sentence (confirm steps). */
export function warnEffectText(ladder) {
    const step = previewWarn(ladder);
    return step.escalates
        ? `reaches the warning limit → automatic ${step.banDurationMs ? formatDuration(step.banDurationMs) : 'permanent'} ban (ladder level ${step.nextLevel}).`
        : `warning ${step.warnNumber} of ${step.threshold}.`;
}

/**
 * The confirm step's summary of a flow, as plain data both the panel (markdown) and
 * the dashboard (HTML) render: { rows: [{ label, value, code }], evidence: [{ url,
 * excerpt, unreadable }], effect, notes: [text], precedent, memberHint }. Pure.
 */
export function flowSummary(flow) {
    const rows = [{ label: 'User', value: flow.targetUsername, id: flow.targetId }];
    const notes = [];
    let evidence = [];
    let effect = null;
    if (RECORD_ACTIONS.has(flow.type)) {
        rows.push({ label: 'Reason', value: flow.reason });
        if (flow.type === 'ban') {
            rows.push({ label: 'Duration', value: flow.durationMs ? formatDuration(flow.durationMs) : 'Permanent' });
            rows.push({ label: 'Appealable', value: flow.unappealable ? 'No' : 'Yes' });
        }
        if (flow.type === 'mute') rows.push({ label: 'Duration', value: formatDuration(flow.durationMs) });
        rows.push({ label: 'Name', value: flow.nameIsDefault ? `${flow.name} (default)` : flow.name });
        evidence = (flow.evidence || []).map((item) => ({
            url: item.url,
            excerpt: item.excerpt || null,
            unreadable: !item.excerpt && Boolean(item.sourceMessageUrl),
        }));
        if (flow.type === 'warn' && flow.ladder) effect = warnEffectText(flow.ladder);
        if (flow.type === 'ban' || flow.type === 'kick') notes.push('The user is DMed before the action runs.');
    } else {
        if (flow.type === 'removewarn') rows.push({ label: 'Warning', value: flow.warnCode, code: true });
        rows.push({ label: 'Reason', value: flow.reason });
    }
    const record = RECORD_ACTIONS.has(flow.type);
    return {
        rows, evidence, effect, notes,
        precedent: record ? flow.precedent || null : null,
        memberHint: record ? flow.memberHint || null : null,
    };
}

/**
 * Stores the links captured in the details form on the new case. Never throws: the
 * action already ran, so a failure only becomes a note for the moderator.
 */
export async function attachFlowEvidence(flow, record, moderatorUser, { add = addEvidence } = {}) {
    if (!record || !flow.evidence?.length) return [];
    const addedBy = { id: moderatorUser.id, username: moderatorUser.username };
    let saved = 0;
    const notes = [];
    for (const item of flow.evidence) {
        try {
            await add(record.case_code, { kind: 'link', url: item.url, sourceMessageUrl: item.sourceMessageUrl, excerpt: item.excerpt, addedBy });
            saved += 1;
        } catch (error) {
            if (!error?.context?.expected) logger.error('Could not attach evidence', { caseCode: record.case_code, error });
            notes.push(`⚠️ Evidence ${item.url} was not saved: ${error.userMessage || error.message}`);
        }
    }
    if (saved) notes.unshift(`Evidence attached: ${saved} link${saved === 1 ? '' : 's'}.`);
    return notes;
}

/** Counted-warns limit text for summaries: "2 of 3" or "1 (next warn bans)". */
export function countedWarnsText(ladder) {
    return `${ladder.warns_since_level}${ladder.level === 0 ? ` of ${enforcementConfig.warnsPerLevel}` : ' (next warn bans)'}`;
}
