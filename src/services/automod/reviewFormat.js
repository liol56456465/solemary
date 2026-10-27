// reviewFormat.js — how automod review cards look. Pure: builds the message payload
// from a card's state, so it can be tested without Discord or the database.
//
// A card's state ("entry", kept in reviewRegistry.js) describes one burst: the same
// rule broken by the same member, possibly several times within a few minutes.
//
//   entry = {
//     rule, kind: 'action' | 'monitor' | 'report' | 'note', userId, username, channelId,
//     ruleLabel,             // label for rules outside AUTOMOD_RULES (native AutoMod)
//     note: { emoji, title }, // kind 'note': an information-only compact line (second chance…)
//     evidence,              // plain-English verb phrase (reasons.js)
//     offence, raid, count, firstAt, lastAt,
//     latest: { content, messageUrl, deleted },
//     actions: [{ step, caseCode, failed, limitBanCode }],   // kind 'action'
//     suggested,                                             // kind 'monitor'
//     report: { reporter, messageId, removed },              // kind 'report'
//     tier: 'compact' | 'full' (once full, stays full)
//   }
//
// Tiers: a low-severity rule with a light action is one compact line with an Undo
// button; everything else (serious rules, long mutes, bans, failures, monitor mode,
// reports) is a full card. Status shows in the color and, once reviewed, the title.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { AUTOMOD_RULES, REVIEW_ACTIONS, automodConfig } from '../../config/automod.js';
import { createEmbed } from '../../utils/embeds.js';
import { formatDuration, truncate } from '../enforcement/format.js';

export const REPORT_RULE = 'report';

/** Card colors by status. */
export const STATUS_COLORS = {
    waiting: 0xF5A623, // amber: needs a look
    kept: 0x57F287,    // green: a moderator confirmed or acted
    undone: 0x99AAB5,  // grey: reversed or dismissed
    failed: 0xED4245,  // red: the action did not go through
};

/** Closing a card: status → [emoji, verb, color]. */
export const CLOSE_STATUS = {
    kept: ['✅', 'Kept', STATUS_COLORS.kept],
    applied: ['✅', 'Applied', STATUS_COLORS.kept],
    changed: ['🔁', 'Changed', STATUS_COLORS.kept],
    deleted: ['🗑️', 'Message deleted', STATUS_COLORS.kept],
    approved: ['✅', 'Approved', STATUS_COLORS.kept],
    undone: ['↩️', 'Undone', STATUS_COLORS.undone],
    dismissed: ['✖️', 'Dismissed', STATUS_COLORS.undone],
    denied: ['⛔', 'Denied', STATUS_COLORS.undone],
    failed: ['⚠️', 'Failed', STATUS_COLORS.failed],
};

// Discord allows 100 characters in a customId; "amreview:change:" leaves room for this many codes.
const MAX_BUTTON_CODES = 10;

/** "Warn", "Mute 1 hour", "Ban 7 days", "Permanent ban". */
export function describeStep(step) {
    if (step.type === 'warn') return 'Warn';
    if (step.type === 'kick') return 'Kick';
    if (step.type === 'mute') return `Mute ${formatDuration(step.durationMs)}`;
    return step.durationMs ? `Ban ${formatDuration(step.durationMs)}` : 'Permanent ban';
}

/** "warn", "mute 1 hour", "ban 7 days", "ban permanently", "kick". */
export function stepVerb(step) {
    if (!step) return 'act';
    if (step.type === 'warn') return 'warn';
    if (step.type === 'kick') return 'kick';
    if (step.type === 'mute') return `mute ${formatDuration(step.durationMs)}`;
    return step.durationMs ? `ban ${formatDuration(step.durationMs)}` : 'ban permanently';
}

/** "Warned", "Muted 1 hour", "Banned 7 days", "Permanently banned", "Kicked". */
export function outcomeLabel(step) {
    if (step.type === 'warn') return 'Warned';
    if (step.type === 'kick') return 'Kicked';
    if (step.type === 'mute') return `Muted ${formatDuration(step.durationMs)}`;
    return step.durationMs ? `Banned ${formatDuration(step.durationMs)}` : 'Permanently banned';
}

export function stepEmoji(step) {
    if (step?.type === 'warn') return '🟡';
    if (step?.type === 'mute') return '🟠';
    return '🔴';
}

export function ordinal(n) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/**
 * Whether one automatic action can be a compact line: a low-severity rule and a light
 * action. Thresholds live in config/automod.js (lowSeverityMax, compactMuteSeverityMax,
 * compactMaxMuteMs).
 */
export function isLightAction(ruleKey, step, cfg = automodConfig) {
    const rule = AUTOMOD_RULES[ruleKey];
    if (!rule || !step || rule.severity > cfg.lowSeverityMax) return false;
    if (step.type === 'warn') return true;
    return step.type === 'mute' && rule.severity <= cfg.compactMuteSeverityMax
        && step.durationMs != null && step.durationMs < cfg.compactMaxMuteMs;
}

/**
 * 'compact' | 'full' for a card. Full for monitor-mode hits, member reports, raid
 * kicks, failed actions, a warn that hit the warning limit, serious rules, and any
 * action that is not light (mutes of a day or more, bans). `p.tier` forces a tier
 * (for later rule modes such as "always full").
 */
export function cardTier(p, cfg = automodConfig) {
    if (p.tier === 'full' || p.tier === 'compact') return p.tier;
    if (p.kind === 'note') return 'compact';
    if (p.kind !== 'action' || p.raid) return 'full';
    const actions = p.actions || [];
    if (!actions.length) return 'full';
    for (const action of actions) {
        if (action.failed || !action.caseCode || action.limitBanCode) return 'full';
        if (!isLightAction(p.rule, action.step, cfg)) return 'full';
    }
    return 'compact';
}

/** Message text behind a spoiler, cut to `max` characters; "(no text)" when empty. */
export function spoilerExcerpt(text, max = automodConfig.cardExcerptChars) {
    const value = String(text ?? '').trim();
    if (!value) return '(no text)';
    // Escape spoiler bars and backslashes so the text can't close the spoiler early.
    const escaped = truncate(value, max).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    return `||${escaped}||`;
}

const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})[️‍\p{Extended_Pictographic}\p{Emoji_Modifier}]*\s*/u;

export function stripLeadingEmoji(title) {
    return String(title || '').replace(LEADING_EMOJI, '');
}

/** "✅ Kept by Admin — Muted 1 hour — Harassment". `verb` overrides the status verb. */
export function closedTitle(title, status, byName, verb = null) {
    const [emoji, defaultVerb] = CLOSE_STATUS[status] || CLOSE_STATUS.kept;
    const base = stripLeadingEmoji(title);
    return truncate(`${emoji} ${verb || defaultVerb} by ${byName}${base ? ` — ${base}` : ''}`, 256);
}

function ruleLabel(entry) {
    return entry.ruleLabel || AUTOMOD_RULES[entry.rule]?.label || 'Member report';
}

function latestAction(entry) {
    const actions = entry.actions || [];
    return actions[actions.length - 1] || null;
}

/** Case codes with a working case, newest last. */
export function caseCodes(entry) {
    return (entry.actions || []).map((action) => action.caseCode).filter(Boolean);
}

/** The codes the buttons carry: the newest MAX_BUTTON_CODES, comma-separated. */
export function buttonCodes(entry) {
    return caseCodes(entry).slice(-MAX_BUTTON_CODES).join(',');
}

export function cardTitle(entry) {
    const label = ruleLabel(entry);
    if (entry.kind === 'report') return '🚩 Member report';
    if (entry.kind === 'monitor') return `👀 Monitor: would ${stepVerb(entry.suggested)} — ${label}`;
    const action = latestAction(entry);
    if (!action) return `Automod — ${label}`;
    if (action.failed) return `❌ Failed to ${stepVerb(action.step)} — ${label}`;
    if (entry.raid) return `🔴 Kicked (raid joiner) — ${label}`;
    return `${stepEmoji(action.step)} ${outcomeLabel(action.step)} — ${label}`;
}

export function cardColor(entry) {
    const action = latestAction(entry);
    if (entry.kind === 'action' && action?.failed) return STATUS_COLORS.failed;
    return STATUS_COLORS.waiting;
}

function whereText(entry) {
    return entry.channelId ? ` in <#${entry.channelId}>` : '';
}

export function cardDescription(entry) {
    const lines = [`<@${entry.userId}> ${entry.evidence || 'broke a rule'}${whereText(entry)}.`];
    const label = ruleLabel(entry);

    if (entry.kind === 'report') {
        if (entry.report?.removed) lines.push('The message was removed by member reports.');
        lines.push('Punish the author below, or dismiss the report.');
    } else if (entry.kind === 'monitor') {
        if (entry.offence) lines.push(`${ordinal(entry.offence)} ${label} offence in 30 days.`);
        lines.push('Nothing was done (monitor mode). Pick a punishment below to apply it.');
    } else {
        if (entry.offence) lines.push(`${ordinal(entry.offence)} ${label} offence in 30 days.`);
        if (entry.raid) lines.push('They joined during a raid lockdown, so they were kicked instead of the usual punishment.');
        const action = latestAction(entry);
        if (action?.failed) lines.push(`⚠️ Not applied: ${action.failed}`);
        if (action?.limitBanCode) lines.push(`This warn reached the warning limit: automatic ban \`${action.limitBanCode}\`.`);
        const earlier = (entry.actions || []).slice(0, -1).filter((a) => a.caseCode);
        if (earlier.length) {
            lines.push(`Earlier in this burst: ${earlier.map((a) => `${outcomeLabel(a.step)} \`${a.caseCode}\``).join(' · ')}.`);
        }
        if (caseCodes(entry).length > MAX_BUTTON_CODES) {
            lines.push(`The buttons cover the newest ${MAX_BUTTON_CODES} cases; use \`/case\` for older ones.`);
        }
    }
    if ((entry.count || 1) > 1) {
        const minutes = Math.max(1, Math.round(((entry.lastAt || 0) - (entry.firstAt || 0)) / 60000));
        lines.push(`**${entry.count} messages** in ${minutes} minute${minutes === 1 ? '' : 's'}; the latest is shown below.`);
    }
    return lines.join('\n');
}

export function cardFields(entry) {
    const fields = [];
    const latest = entry.latest || {};
    fields.push({
        name: latest.deleted ? 'Message (deleted)' : 'Message',
        value: spoilerExcerpt(latest.content),
    });
    const codes = caseCodes(entry);
    if (codes.length) fields.push({ name: codes.length > 1 ? 'Cases' : 'Case', value: codes.map((c) => `\`${c}\``).join(' '), inline: true });
    if (latest.messageUrl && !latest.deleted) fields.push({ name: 'Message link', value: `[Jump to message](${latest.messageUrl})`, inline: true });
    if (entry.kind === 'report' && entry.report?.reporter) fields.push({ name: 'Reported by', value: truncate(entry.report.reporter, 1024), inline: true });
    return fields;
}

/** "🟡 **Excessive caps** · <@1> · warned · case `k3f9a` · <#2> · 3 messages" */
export function compactLine(entry) {
    if (entry.kind === 'note') {
        // "💬 Second chance · <@1> · Excessive caps · <#2>"
        return [
            `${entry.note?.emoji || 'ℹ️'} ${entry.note?.title || 'Note'}`,
            `<@${entry.userId}>`,
            ruleLabel(entry),
            entry.channelId ? `<#${entry.channelId}>` : null,
            (entry.count || 1) > 1 ? `${entry.count} messages` : null,
        ].filter(Boolean).join(' · ');
    }
    const action = latestAction(entry);
    const codes = caseCodes(entry);
    const parts = [
        `${stepEmoji(action?.step)} **${ruleLabel(entry)}**`,
        `<@${entry.userId}>`,
        action ? outcomeLabel(action.step).toLowerCase() : 'flagged',
        codes.length ? `case${codes.length > 1 ? 's' : ''} ${codes.map((c) => `\`${c}\``).join(' ')}` : null,
        entry.channelId ? `<#${entry.channelId}>` : null,
        (entry.count || 1) > 1 ? `${entry.count} messages` : null,
    ];
    return parts.filter(Boolean).join(' · ');
}

function actionSelect(customId, placeholder, suggestedKey = null) {
    return new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(Object.entries(REVIEW_ACTIONS).map(([key, action]) => ({
            label: action.label,
            value: key,
            default: false,
            description: key === suggestedKey ? 'Suggested by the rule ladder' : undefined,
        })));
}

export function actionKeyFor(step) {
    return Object.entries(REVIEW_ACTIONS).find(([, action]) =>
        action.step.type === step?.type && (action.step.durationMs ?? null) === (step?.durationMs ?? null))?.[0] || null;
}

const dismissButton = () => new ButtonBuilder().setCustomId('amreview:dismiss').setLabel('Dismiss').setStyle(ButtonStyle.Secondary);

export function cardComponents(entry, tier = cardTier(entry)) {
    const codes = buttonCodes(entry);
    if (tier === 'compact') {
        if (!codes) return [];
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`amreview:undo:${codes}`).setLabel('Undo').setStyle(ButtonStyle.Secondary),
        )];
    }
    if (entry.kind === 'report') {
        const buttons = [dismissButton()];
        if (!entry.report?.removed && entry.report?.messageId) {
            buttons.unshift(new ButtonBuilder().setCustomId(`amreview:delete:${entry.channelId}:${entry.report.messageId}`).setLabel('Delete message').setStyle(ButtonStyle.Danger));
        }
        return [
            new ActionRowBuilder().addComponents(actionSelect(`amreview:apply:${REPORT_RULE}:${entry.userId}`, 'Punish the author…')),
            new ActionRowBuilder().addComponents(buttons),
        ];
    }
    if (entry.kind === 'monitor' || !codes) {
        const suggested = entry.kind === 'monitor' ? entry.suggested : latestAction(entry)?.step;
        return [
            new ActionRowBuilder().addComponents(actionSelect(`amreview:apply:${entry.rule}:${entry.userId}`, 'Apply a punishment…', actionKeyFor(suggested))),
            new ActionRowBuilder().addComponents(dismissButton()),
        ];
    }
    const many = codes.includes(',');
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`amreview:keep:${codes}`).setLabel(many ? 'Keep all' : 'Keep').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`amreview:undo:${codes}`).setLabel(many ? 'Undo all' : 'Undo').setStyle(ButtonStyle.Danger),
        ),
        new ActionRowBuilder().addComponents(actionSelect(`amreview:change:${codes}`, many ? 'Undo all and change to…' : 'Change to…')),
    ];
}

/** The full message payload for a card: { content, embeds, components }. */
export function buildCardPayload(entry) {
    const tier = cardTier(entry);
    if (tier === 'compact') {
        return { content: truncate(compactLine(entry), 2000), embeds: [], components: cardComponents(entry, tier) };
    }
    const embed = createEmbed({
        title: truncate(cardTitle(entry), 256),
        description: cardDescription(entry),
        fields: cardFields(entry),
        color: cardColor(entry),
        footer: { text: `${entry.username || 'unknown'} · ${entry.userId}` },
        timestamp: entry.firstAt ? new Date(entry.firstAt) : true,
    });
    return { content: '', embeds: [embed], components: cardComponents(entry, tier) };
}
