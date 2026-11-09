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
import { memberLadderHint, precedentHint, precedentUnavailable } from './precedentService.js';
import { durationIn } from './dmTemplates.js';
import { ruleHintFor } from '../rules/serverRules.js';
import { botText } from '../../utils/botText.js';

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

/**
 * An action's label ("Ban", "Remove warn") in a language (bot panel). English is ACTION_LABELS;
 * an unknown type keeps its English label (or the type itself).
 */
export function actionLabelIn(type, { lang = 'en' } = {}) {
    if (lang === 'en') return ACTION_LABELS[type] ?? type;
    const tr = botText(lang);
    switch (type) {
        case 'ban': return tr.t('staff.panel.action.ban');
        case 'kick': return tr.t('staff.panel.action.kick');
        case 'mute': return tr.t('staff.panel.action.mute');
        case 'warn': return tr.t('staff.panel.action.warn');
        case 'unban': return tr.t('staff.panel.action.unban');
        case 'unmute': return tr.t('staff.panel.action.unmute');
        case 'removewarn': return tr.t('staff.panel.action.removewarn');
        default: return ACTION_LABELS[type] ?? type;
    }
}
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
export function parseFlowInput(flow, input = {}, { lang = 'en', explicitPermanent = false } = {}) {
    const tr = botText(lang);
    const patch = {};
    if (flow.reasonKey === CUSTOM_REASON_KEY) {
        patch.customReason = String(input.customReason || '').trim();
        patch.reason = patch.customReason;
        if (!patch.reason) return { patch, error: tr.t('staff.panel.input.customReasonRequired') };
    }

    if (flow.type === 'ban' || flow.type === 'mute') {
        const raw = String(input.durationInput || '').trim();
        patch.durationInput = raw;
        if (!raw && flow.type === 'mute') return { patch, error: tr.t('staff.panel.input.muteNeedsDuration') };
        // The panel (explicitPermanent): a permanent ban is typed as "permanent", never a blank field.
        if (!raw && flow.type === 'ban' && explicitPermanent) return { patch, error: tr.t('staff.panel.input.banNeedsDuration') };
        const permanent = flow.type === 'ban' && isPermanentWord(raw, lang);
        patch.durationMs = raw && !permanent ? parseDuration(raw) : null;
        if (raw && !permanent && patch.durationMs == null) {
            return { patch, error: tr.t('staff.panel.input.badDuration', { value: truncate(raw, 20) }) };
        }
    }

    if (flow.type === 'ban') {
        patch.unappealable = Boolean(input.unappealable);
    }

    const evidenceRaw = String(input.evidenceInput || '').trim();
    patch.evidenceInput = evidenceRaw;
    const evidenceEntries = parseEvidenceUrls(evidenceRaw);
    if (evidenceRaw && evidenceEntries.length === 0) {
        return { patch, error: tr.t('staff.panel.input.evidenceLinks') };
    }
    if (evidenceEntries.length > MAX_LINKS_PER_FORM) {
        return { patch, error: tr.t('staff.panel.input.evidenceMax', { max: MAX_LINKS_PER_FORM }) };
    }
    patch.evidenceEntries = evidenceEntries;
    return { patch, error: null };
}

/**
 * True for the word that asks for a permanent ban: "permanent", "perm", "forever", or the
 * panel language's own word for it (enforcement.duration.permanent, e.g. "Dauerhaft").
 */
export function isPermanentWord(raw, lang = 'en') {
    const text = String(raw || '').trim().toLowerCase();
    if (!text) return false;
    if (/^(perm|permanent|forever)$/.test(text)) return true;
    return text === botText(lang).t('enforcement.duration.permanent').toLowerCase();
}

/** A permanent ban the member cannot appeal: the panel asks a second time before it runs. */
export function needsSecondConfirm(flow) {
    return flow?.type === 'ban' && flow.durationMs == null && Boolean(flow.unappealable);
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
export async function completeFlowDetails({ guild, moderator, targetUser, flow, patch: parsed, customName = '', deps: depsIn = defaultFlowDeps, lang = 'en' }) {
    const deps = { ...defaultFlowDeps, ...depsIn };
    const { evidenceEntries = [], ...patch } = parsed;
    const name = String(customName || '').trim();
    if (name) {
        patch.name = name;
        patch.nameIsDefault = false;
        if (await deps.isNameTaken(guild.id, name)) {
            return {
                patch: { ...patch, name: undefined, nameIsDefault: true },
                error: botText(lang).t('staff.panel.input.nameTaken', { name: truncate(name, 100) }),
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
        Promise.resolve().then(() => deps.precedentHint(guild.id, flow.reasonKey, getReason(flow.reasonKey)?.label || flow.reasonKey, ...(lang === 'en' ? [] : [{ lang }])))
            .catch(() => precedentUnavailable(lang)),
        memberLadderHint(guild.id, targetUser.id, { ladder: patch.ladder, getLadder: deps.getLadder, lang }),
    ]);
    return { patch, error: null, fatal: null };
}

/** What a warn does at this ladder state, as one sentence (confirm steps). */
export function warnEffectText(ladder, { lang = 'en' } = {}) {
    const step = previewWarn(ladder);
    if (lang !== 'en') {
        const tr = botText(lang);
        if (!step.escalates) return tr.t('staff.panel.effect.warn', { n: step.warnNumber, max: step.threshold });
        return step.banDurationMs
            ? tr.t('staff.panel.effect.escalates', { length: durationIn(step.banDurationMs, lang), stage: step.nextLevel })
            : tr.t('staff.panel.effect.escalatesPermanent', { stage: step.nextLevel });
    }
    return step.escalates
        ? `reaches the warning limit → automatic ${step.banDurationMs ? formatDuration(step.banDurationMs) : 'permanent'} ban (warning stage ${step.nextLevel} of 3).`
        : `warning ${step.warnNumber} of ${step.threshold}.`;
}

/**
 * The confirm step's summary of a flow, as plain data both the panel (markdown) and
 * the dashboard (HTML) render: { rows: [{ label, value, code }], evidence: [{ url,
 * excerpt, unreadable }], effect, notes: [text], precedent, memberHint }. Pure.
 */
export function flowSummary(flow, { guildId = null, lang = 'en' } = {}) {
    const tr = botText(lang);
    const duration = (ms) => (lang === 'en' ? formatDuration(ms) : durationIn(ms, lang));
    const rows = [{ label: tr.t('staff.panel.summary.user'), value: flow.targetUsername, id: flow.targetId }];
    const notes = [];
    let evidence = [];
    let effect = null;
    if (RECORD_ACTIONS.has(flow.type)) {
        rows.push({ label: tr.t('staff.panel.summary.reason'), value: flow.reason });
        if (flow.type === 'ban') {
            rows.push({ label: tr.t('staff.panel.summary.duration'), value: flow.durationMs ? duration(flow.durationMs) : tr.t('enforcement.duration.permanent') });
            rows.push({ label: tr.t('staff.panel.summary.canAppeal'), value: flow.unappealable ? tr.t('staff.panel.summary.no') : tr.t('staff.panel.summary.yes') });
        }
        if (flow.type === 'mute') rows.push({ label: tr.t('staff.panel.summary.duration'), value: duration(flow.durationMs) });
        rows.push({ label: tr.t('staff.panel.summary.name'), value: flow.nameIsDefault ? tr.t('staff.panel.summary.nameDefault', { name: flow.name }) : flow.name });
        evidence = (flow.evidence || []).map((item) => ({
            url: item.url,
            excerpt: item.excerpt || null,
            unreadable: !item.excerpt && Boolean(item.sourceMessageUrl),
        }));
        if (flow.type === 'warn' && flow.ladder) effect = warnEffectText(flow.ladder, { lang });
        if (flow.type === 'ban' || flow.type === 'kick') notes.push(tr.t('staff.panel.summary.dmFirst'));
    } else {
        if (flow.type === 'removewarn') rows.push({ label: tr.t('staff.panel.summary.warning'), value: flow.warnCode, code: true });
        rows.push({ label: tr.t('staff.panel.summary.reason'), value: flow.reason });
    }
    const record = RECORD_ACTIONS.has(flow.type);
    return {
        rows, evidence, effect, notes,
        precedent: record ? flow.precedent || null : null,
        memberHint: record ? flow.memberHint || null : null,
        // The server rule the prebuilt reason is linked to, and its listed consequence (text only).
        // guildId: the server acting (its own rules; none named / home: the main server's, as before).
        ruleHint: record && flow.reasonKey ? ruleHintFor(flow.reasonKey, process.env, guildId) : null,
    };
}

/**
 * Stores the links captured in the details form on the new case. Never throws: the
 * action already ran, so a failure only becomes a note for the moderator.
 */
export async function attachFlowEvidence(flow, record, moderatorUser, { add = addEvidence, lang = 'en' } = {}) {
    const tr = botText(lang);
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
            notes.push(tr.t('staff.panel.evidence.notSaved', { url: item.url, error: error.userMessage || error.message }));
        }
    }
    if (saved) notes.unshift(tr.tp('staff.panel.evidence.attached', saved));
    return notes;
}

/** Counted-warns limit text for summaries: "2 of 3" or "1 (next warn bans)". */
export function countedWarnsText(ladder, { lang = 'en' } = {}) {
    if (lang !== 'en') {
        const tr = botText(lang);
        return ladder.level === 0
            ? tr.t('staff.panel.warns.of', { n: ladder.warns_since_level, max: enforcementConfig.warnsPerLevel })
            : tr.t('staff.panel.warns.nextBans', { n: ladder.warns_since_level });
    }
    return `${ladder.warns_since_level}${ladder.level === 0 ? ` of ${enforcementConfig.warnsPerLevel}` : ' (next warn bans)'}`;
}

/**
 * The panel's warnings line in plain words, one number only (audit 3.7):
 * "**Warnings:** 2 — the next one bans for 7 days", "**Warnings:** 1 — at 3 they are banned for
 * 7 days", plus "**Warning bans so far:** 2" once a warning ban happened.
 */
export function warnStatusText(ladder, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const level = Number(ladder?.level) || 0;
    const n = Number(ladder?.warns_since_level) || 0;
    const step = previewWarn({ level, warns_since_level: n });
    let text;
    if (step.escalates) {
        text = step.banDurationMs != null
            ? tr.t('staff.panel.info.warnsNext', { n, length: durationIn(step.banDurationMs, lang) })
            : tr.t('staff.panel.info.warnsNextPermanent', { n });
    } else {
        // Not escalating yet: the ban that comes at the limit is the next level's.
        const atLimit = previewWarn({ level, warns_since_level: Math.max(0, step.threshold - 1) });
        text = atLimit.banDurationMs != null
            ? tr.t('staff.panel.info.warnsAt', { n, max: step.threshold, length: durationIn(atLimit.banDurationMs, lang) })
            : tr.t('staff.panel.info.warnsAtPermanent', { n, max: step.threshold });
    }
    return level > 0 ? `${text} · ${tr.t('staff.panel.info.warnBans', { level })}` : text;
}

/**
 * What the member's next warning does, for the result card after a warn (audit 3.2):
 * previewWarn on the ladder as it is now. "**Next warn:** automatic 7-day ban".
 */
export function nextWarnText(ladder, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const step = previewWarn({ level: Number(ladder?.level) || 0, warns_since_level: Number(ladder?.warns_since_level) || 0 });
    if (!step.escalates) return tr.t('staff.panel.result.nextWarn', { n: step.warnNumber, max: step.threshold });
    return step.banDurationMs != null
        ? tr.t('staff.panel.result.nextWarnBans', { length: durationIn(step.banDurationMs, lang) })
        : tr.t('staff.panel.result.nextWarnBansPermanent');
}
