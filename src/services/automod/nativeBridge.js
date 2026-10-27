// nativeBridge.js — Discord's own AutoMod, bridged into the bot's review flow.
//
// When a native AutoMod rule blocks a message, Discord sends one execution event per
// action of the rule; only the BlockMessage one is used (one per trigger). What
// happens next is the rule's policy (automod_native_rules, /automod native set):
//   ignore  nothing
//   log     a compact line in the review channel (default for rules without a row)
//   warn    a warning through the normal enforcement path (reason key
//           "automod:native:<ruleId>") and a full review card (keep / undo / change)
// One action per member and rule per dedupe_minutes (in memory); later blocks within
// that time are only counted on the open card.
//
// The bot never relies on native Timeout actions: mutes use the Muted role.
// Receiving these events needs the AutoModerationExecution intent and the Manage
// Server permission (checked in the startup readiness line).

import { AutoModerationActionType, AutoModerationRuleTriggerType } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from '../enforcement/db.js';
import { executeSystemAction } from '../enforcement/enforcementService.js';
import { getAutomodSettings } from './automodSettings.js';
import { getProbation } from './probationService.js';
import { noteRepeatHit, postReviewCard } from './reviewCards.js';
import { spoilerExcerpt } from './reviewFormat.js';

export const NATIVE_POLICIES = ['ignore', 'log', 'warn'];
export const DEFAULT_NATIVE_POLICY = Object.freeze({ policy: 'log', dedupeMinutes: 10 });

const CACHE_MS = 5 * 60 * 1000;
const policyCache = new Map(); // guildId → { rules: Map(ruleId → { policy, dedupeMinutes }), expiresAt }
const lastActed = new Map();   // guildId:userId:ruleId → epoch ms

/** ruleId → { policy, dedupeMinutes } for a guild. Throws on a DB error. */
export async function loadNativePolicies(guildId, now = Date.now()) {
    const cached = policyCache.get(guildId);
    if (cached && cached.expiresAt > now) return cached.rules;
    const { rows } = await query(
        `SELECT rule_id, policy, dedupe_minutes FROM ${T.nativeRules} WHERE guild_id = $1`,
        [guildId]
    );
    const rules = new Map(rows.map((row) => [row.rule_id, { policy: row.policy, dedupeMinutes: row.dedupe_minutes }]));
    policyCache.set(guildId, { rules, expiresAt: now + CACHE_MS });
    return rules;
}

/** Saves a rule's policy; `dedupeMinutes` null keeps the stored value (10 for a new row). Resolves true or throws. */
export async function setNativePolicy(guildId, ruleId, policy, dedupeMinutes, updatedBy) {
    if (!NATIVE_POLICIES.includes(policy)) throw new Error(`Unknown native AutoMod policy: ${policy}`);
    await query(
        `INSERT INTO ${T.nativeRules} (guild_id, rule_id, policy, dedupe_minutes, updated_by, updated_at)
         VALUES ($1, $2, $3, COALESCE($4::int, 10), $5, NOW())
         ON CONFLICT (guild_id, rule_id) DO UPDATE
           SET policy = EXCLUDED.policy,
               dedupe_minutes = COALESCE($4::int, ${T.nativeRules}.dedupe_minutes),
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()`,
        [guildId, ruleId, policy, dedupeMinutes ?? null, updatedBy]
    );
    policyCache.delete(guildId);
    return true;
}

/** The policy for a rule: its stored row, else log with a 10-minute dedupe. */
export function policyFor(rules, ruleId) {
    return rules?.get?.(ruleId) || DEFAULT_NATIVE_POLICY;
}

/** Whether an action for this member and rule happened within the dedupe window. */
export function isDuplicate(lastAt, dedupeMinutes, now = Date.now()) {
    if (!lastAt || !(dedupeMinutes > 0)) return false;
    return now - lastAt < dedupeMinutes * 60 * 1000;
}

/** Only one execution per trigger is used: the BlockMessage action. */
export function isBridgedAction(action) {
    return action?.type === AutoModerationActionType.BlockMessage;
}

/** Plain-English reason for the card; the matched keyword stays behind a spoiler. */
export function nativeEvidence(ruleName, matchedKeyword) {
    const keyword = matchedKeyword ? ` (matched ${spoilerExcerpt(matchedKeyword, 60)})` : '';
    return `triggered the Discord AutoMod rule "${ruleName}"${keyword}`;
}

const TRIGGER_LABELS = {
    [AutoModerationRuleTriggerType.Keyword]: 'keyword',
    [AutoModerationRuleTriggerType.Spam]: 'spam',
    [AutoModerationRuleTriggerType.KeywordPreset]: 'keyword preset',
    [AutoModerationRuleTriggerType.MentionSpam]: 'mention spam',
    [AutoModerationRuleTriggerType.MemberProfile]: 'member profile',
};

export function triggerLabel(triggerType) {
    return TRIGGER_LABELS[triggerType] || `trigger ${triggerType}`;
}

async function ruleName(execution) {
    const rule = execution.autoModerationRule
        || await execution.guild.autoModerationRules.fetch(execution.ruleId).catch(() => null);
    return rule?.name || `rule ${execution.ruleId}`;
}

function pruneLastActed(now) {
    if (lastActed.size < 2000) return;
    for (const [key, at] of lastActed) if (now - at > 24 * 60 * 60 * 1000) lastActed.delete(key);
}

/** autoModerationActionExecution in the main server. */
export async function handleNativeExecution(execution) {
    const { guild } = execution;
    if (!guild || guild.id !== enforcementConfig.mainGuildId || !isBridgedAction(execution.action)) return;
    if (!isEnforcementDbAvailable()) return;
    const settings = await getAutomodSettings(guild.id);
    if (!settings.enabled) return;

    const rules = await loadNativePolicies(guild.id).catch((error) => {
        logger.warn(`Native AutoMod policies unavailable (${error.message}); logging only`);
        return null;
    });
    const { policy, dedupeMinutes } = policyFor(rules, execution.ruleId);
    if (policy === 'ignore') return;

    const targetUser = execution.user || await guild.client.users.fetch(execution.userId).catch(() => null);
    if (!targetUser || targetUser.bot) return;
    const name = await ruleName(execution);
    const probation = await getProbation(guild.id, targetUser.id).catch(() => null);
    const card = {
        guild,
        rule: `native:${execution.ruleId}`,
        ruleLabel: `Discord AutoMod: ${name}`,
        evidence: nativeEvidence(name, execution.matchedKeyword || execution.matchedContent),
        detail: `native rule ${execution.ruleId} (${triggerLabel(execution.ruleTriggerType)}), keyword "${execution.matchedKeyword || ''}"`,
        targetUser,
        channelId: execution.channelId || null,
        messageUrl: null,
        content: execution.content || '',
        deleted: true,
        probation,
    };

    const logLine = policy === 'log' ? { note: { emoji: '🛡️', title: 'Discord AutoMod blocked a message' } } : {};
    const now = Date.now();
    const key = `${guild.id}:${targetUser.id}:${execution.ruleId}`;
    if (isDuplicate(lastActed.get(key), dedupeMinutes, now)) {
        // Counted on the open card or line of this member and rule, if there is one.
        await noteRepeatHit({ ...card, ...logLine });
        return;
    }
    lastActed.set(key, now);
    pruneLastActed(now);

    if (policy === 'log') {
        await postReviewCard({ ...card, ...logLine });
        return;
    }

    const step = { type: 'warn' };
    const result = await executeSystemAction({
        guild,
        targetUser,
        flow: {
            type: 'warn',
            reason: `Automod: Discord AutoMod rule "${name}"`.slice(0, 500),
            reasonSource: 'prebuilt',
            reasonKey: `automod:native:${execution.ruleId}`,
            durationMs: null,
            unappealable: false,
            name: `${targetUser.username} warn`,
            nameIsDefault: true,
        },
    }).catch((error) => ({ error }));
    if (result.error) logger.warn(`Native AutoMod warn on ${targetUser.id}: ${result.error.userMessage || result.error.message}`);
    await postReviewCard({ ...card, step, result, tier: 'full' });
}

/** Test hook. */
export function resetNativeBridge() {
    policyCache.clear();
    lastActed.clear();
}
