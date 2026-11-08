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
//     probationUntil,        // epoch ms: the member is on probation (probationService.js)
//     contest: { caseCode, reason, at },  // the member pressed "Contest this" (automodContest.js)
//   }
//
// Tiers: a low-severity rule with a light action is one compact line with an Undo
// button; everything else (serious rules, long mutes, bans, failures, monitor mode,
// reports) is a full card. Status shows in the color and, once reviewed, the title.
//
// Language (docs/bot-i18n.md): a card is a staff-channel post, so it is in the server's language
// (buildCardPayload reads it from entry.guildId). Every other builder takes `{ lang }` (default
// English). The evidence phrase (reasons.js) and custom/native rule names stay as given.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { AUTOMOD_RULES, REVIEW_ACTIONS, automodConfig } from '../../config/automod.js';
import { createEmbed } from '../../utils/embeds.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { formatDuration, truncate } from '../enforcement/format.js';
import { durationIn } from '../enforcement/dmTemplates.js';

export const REPORT_RULE = 'report';

/** Card colors by status. */
export const STATUS_COLORS = {
    waiting: 0xF5A623, // amber: needs a look
    kept: 0x57F287,    // green: a moderator confirmed or acted
    undone: 0x99AAB5,  // grey: reversed or dismissed
    failed: 0xED4245,  // red: the action did not go through
};

/** Closing a card: status → [verb, color]. (English verbs; statusVerb() gives them in a language.) */
export const CLOSE_STATUS = {
    kept: ['Kept', STATUS_COLORS.kept],
    applied: ['Applied', STATUS_COLORS.kept],
    changed: ['Changed', STATUS_COLORS.kept],
    deleted: ['Message deleted', STATUS_COLORS.kept],
    approved: ['Approved', STATUS_COLORS.kept],
    undone: ['Undone', STATUS_COLORS.undone],
    dismissed: ['Dismissed', STATUS_COLORS.undone],
    denied: ['Denied', STATUS_COLORS.undone],
    failed: ['Failed', STATUS_COLORS.failed],
};

/** The status verb of CLOSE_STATUS in a language; unknown status → "Reviewed". */
export function statusVerb(status, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const verbs = {
        kept: () => tr.t('automod.review.status.kept'),
        applied: () => tr.t('automod.review.status.applied'),
        changed: () => tr.t('automod.review.status.changed'),
        deleted: () => tr.t('automod.review.status.deleted'),
        approved: () => tr.t('automod.review.status.approved'),
        undone: () => tr.t('automod.review.status.undone'),
        dismissed: () => tr.t('automod.review.status.dismissed'),
        denied: () => tr.t('automod.review.status.denied'),
        failed: () => tr.t('automod.review.status.failed'),
    };
    return (verbs[status] || (() => tr.t('automod.review.status.reviewed')))();
}

/** A REVIEW_ACTIONS label ("Mute 1 hour") in a language; unknown key → its English label. */
export function reviewActionLabel(key, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const labels = {
        warn: () => tr.t('automod.review.action.warn'),
        mute1h: () => tr.t('automod.review.action.mute1h'),
        mute1d: () => tr.t('automod.review.action.mute1d'),
        ban7d: () => tr.t('automod.review.action.ban7d'),
        ban30d: () => tr.t('automod.review.action.ban30d'),
        permban: () => tr.t('automod.review.action.permban'),
    };
    return labels[key] ? labels[key]() : (REVIEW_ACTIONS[key]?.label || String(key));
}

/** A built-in rule's label (AUTOMOD_RULES) in a language; null for any other rule. */
export function builtInRuleLabel(rule, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const labels = {
        scam: () => tr.t('automod.review.rule.scam'),
        nsfw: () => tr.t('automod.review.rule.nsfw'),
        sexual: () => tr.t('automod.review.rule.sexual'),
        harassment: () => tr.t('automod.review.rule.harassment'),
        privacy: () => tr.t('automod.review.rule.privacy'),
        advertising: () => tr.t('automod.review.rule.advertising'),
        impersonation: () => tr.t('automod.review.rule.impersonation'),
        language: () => tr.t('automod.review.rule.language'),
        disrespect: () => tr.t('automod.review.rule.disrespect'),
        mentions: () => tr.t('automod.review.rule.mentions'),
        spam: () => tr.t('automod.review.rule.spam'),
        caps: () => tr.t('automod.review.rule.caps'),
        characters: () => tr.t('automod.review.rule.characters'),
        english: () => tr.t('automod.review.rule.english'),
    };
    if (!Object.hasOwn(labels, rule) || !Object.hasOwn(AUTOMOD_RULES, rule)) return null;
    return labels[rule]();
}

// Discord allows 100 characters in a customId; "amreview:change:" leaves room for this many codes.
const MAX_BUTTON_CODES = 10;

// English durations stay format.js formatDuration (byte for byte); other languages use durationIn.
const durationText = (ms, lang) => (lang === 'en' ? formatDuration(ms) : durationIn(ms, lang));

/** "Warn", "Mute 1 hour", "Ban 7 days", "Permanent ban". */
export function describeStep(step, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (step.type === 'warn') return tr.t('automod.review.step.warn');
    if (step.type === 'kick') return tr.t('automod.review.step.kick');
    if (step.type === 'mute') return tr.t('automod.review.step.mute', { duration: durationText(step.durationMs, lang) });
    return step.durationMs
        ? tr.t('automod.review.step.ban', { duration: durationText(step.durationMs, lang) })
        : tr.t('automod.review.step.permanentBan');
}

/** "warn", "mute 1 hour", "ban 7 days", "ban permanently", "kick". */
export function stepVerb(step, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!step) return tr.t('automod.review.verb.act');
    if (step.type === 'warn') return tr.t('automod.review.verb.warn');
    if (step.type === 'kick') return tr.t('automod.review.verb.kick');
    if (step.type === 'mute') return tr.t('automod.review.verb.mute', { duration: durationText(step.durationMs, lang) });
    return step.durationMs
        ? tr.t('automod.review.verb.ban', { duration: durationText(step.durationMs, lang) })
        : tr.t('automod.review.verb.permanentBan');
}

/** "Warned", "Muted 1 hour", "Banned 7 days", "Permanently banned", "Kicked". */
export function outcomeLabel(step, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (step.type === 'warn') return tr.t('automod.review.outcome.warn');
    if (step.type === 'kick') return tr.t('automod.review.outcome.kick');
    if (step.type === 'mute') return tr.t('automod.review.outcome.mute', { duration: durationText(step.durationMs, lang) });
    return step.durationMs
        ? tr.t('automod.review.outcome.ban', { duration: durationText(step.durationMs, lang) })
        : tr.t('automod.review.outcome.permanentBan');
}

/** The same, as written inside a compact line: "warned", "muted 1 hour" … */
function outcomeShort(step, lang) {
    const tr = botText(lang);
    if (step.type === 'warn') return tr.t('automod.review.outcomeShort.warn');
    if (step.type === 'kick') return tr.t('automod.review.outcomeShort.kick');
    if (step.type === 'mute') return tr.t('automod.review.outcomeShort.mute', { duration: durationText(step.durationMs, lang) });
    return step.durationMs
        ? tr.t('automod.review.outcomeShort.ban', { duration: durationText(step.durationMs, lang) })
        : tr.t('automod.review.outcomeShort.permanentBan');
}

export function ordinal(n) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/** An ordinal number written the language's way: 1st, 1., 1er, 1°, 1.º, 1º, 1-е. */
export function ordinalIn(n, lang = 'en') {
    switch (lang) {
        case 'de': case 'pl': return `${n}.`;
        case 'fr': return n === 1 ? '1er' : `${n}e`;
        case 'it': return `${n}°`;
        case 'es': return `${n}.º`;
        case 'pt-BR': return `${n}º`;
        case 'ru': return `${n}-е`;
        default: return ordinal(n);
    }
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
    if (p.contest) return 'full'; // a disputed decision always gets the full card
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
export function spoilerExcerpt(text, max = automodConfig.cardExcerptChars, { lang = 'en' } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return botText(lang).t('automod.review.field.noText');
    // Escape spoiler bars and backslashes so the text can't close the spoiler early.
    const escaped = truncate(value, max).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    return `||${escaped}||`;
}

const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})[️‍\p{Extended_Pictographic}\p{Emoji_Modifier}]*\s*/u;

export function stripLeadingEmoji(title) {
    return String(title || '').replace(LEADING_EMOJI, '');
}

/** "Kept by Admin · Muted 1 hour · Harassment". `verb` overrides the status verb. */
export function closedTitle(title, status, byName, verb = null, { lang = 'en' } = {}) {
    const defaultVerb = statusVerb(CLOSE_STATUS[status] ? status : 'kept', { lang });
    // Older cards still start with an emoji; drop it so the closed title stays plain.
    const base = stripLeadingEmoji(title);
    const head = botText(lang).t('automod.review.close.by', { verb: verb || defaultVerb, name: byName });
    return truncate(`${head}${base ? ` · ${base}` : ''}`, 256);
}

function ruleLabel(entry, lang = 'en') {
    return entry.ruleLabel || builtInRuleLabel(entry.rule, { lang }) || botText(lang).t('automod.review.memberReport');
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

export function cardTitle(entry, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const label = ruleLabel(entry, lang);
    if (entry.kind === 'report') return tr.t('automod.review.memberReport');
    if (entry.kind === 'monitor') {
        const action = entry.suggested ? stepVerb(entry.suggested, { lang }) : tr.t('automod.review.title.deleteTheMessage');
        return tr.t('automod.review.title.monitor', { action, rule: label });
    }
    const action = latestAction(entry);
    if (!action) return tr.t('automod.review.title.automod', { rule: label });
    if (action.failed) return tr.t('automod.review.title.failed', { action: stepVerb(action.step, { lang }), rule: label });
    if (entry.raid) return tr.t('automod.review.title.raid', { rule: label });
    return `${outcomeLabel(action.step, { lang })} · ${label}`;
}

export function cardColor(entry) {
    const action = latestAction(entry);
    if (entry.kind === 'action' && action?.failed) return STATUS_COLORS.failed;
    return STATUS_COLORS.waiting;
}

function whereText(entry, lang) {
    return entry.channelId ? botText(lang).t('automod.review.card.inChannel', { channel: `<#${entry.channelId}>` }) : '';
}

const probationDate = (entry) => `<t:${Math.floor(entry.probationUntil / 1000)}:D>`;

/** "in an extra-watch period after a ban (rejoined, until <t:…:D>)" or null. */
export function probationText(entry, { lang = 'en' } = {}) {
    return entry.probationUntil
        ? botText(lang).t('automod.review.card.probation', { date: probationDate(entry) })
        : null;
}

export function cardDescription(entry, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const lines = [`<@${entry.userId}> ${entry.evidence || tr.t('automod.review.card.brokeRule')}${whereText(entry, lang)}.`];
    if (entry.probationUntil) lines.push(tr.t('automod.review.card.probationLadder', { date: probationDate(entry) }));
    const label = ruleLabel(entry, lang);
    const offence = () => tr.t('automod.review.card.offence', { ordinal: ordinalIn(entry.offence, lang), rule: label });

    if (entry.kind === 'report') {
        if (entry.report?.removed) lines.push(tr.t('automod.review.card.reportRemoved'));
        lines.push(tr.t('automod.review.card.reportPunish'));
    } else if (entry.kind === 'monitor') {
        if (entry.offence) lines.push(offence());
        lines.push(tr.t('automod.review.card.monitorNothing'));
    } else {
        if (entry.offence) lines.push(offence());
        if (entry.raid) lines.push(tr.t('automod.review.card.raidKicked'));
        const action = latestAction(entry);
        if (action?.failed) lines.push(tr.t('automod.review.card.notApplied', { error: action.failed }));
        if (action?.limitBanCode) lines.push(tr.t('automod.review.card.limitBan', { code: action.limitBanCode }));
        const earlier = (entry.actions || []).slice(0, -1).filter((a) => a.caseCode);
        if (earlier.length) {
            const list = earlier.map((a) => `${outcomeLabel(a.step, { lang })} \`${a.caseCode}\``).join(' · ');
            lines.push(tr.t('automod.review.card.earlier', { list }));
        }
        if (caseCodes(entry).length > MAX_BUTTON_CODES) {
            lines.push(tr.t('automod.review.card.olderCases', { max: MAX_BUTTON_CODES }));
        }
    }
    if ((entry.count || 1) > 1) {
        const minutes = Math.max(1, Math.round(((entry.lastAt || 0) - (entry.firstAt || 0)) / 60000));
        lines.push(tr.t('automod.review.card.burst', {
            messages: tr.tp('automod.review.card.burstMessages', entry.count),
            minutes: tr.tp('automod.review.card.burstMinutes', minutes),
        }));
    }
    return lines.join('\n');
}

export function cardFields(entry, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const fields = [];
    const latest = entry.latest || {};
    fields.push({
        name: latest.deleted ? tr.t('automod.review.field.messageDeleted') : tr.t('automod.review.field.message'),
        value: spoilerExcerpt(latest.content, automodConfig.cardExcerptChars, { lang }),
    });
    const codes = caseCodes(entry);
    if (codes.length) fields.push({ name: codes.length > 1 ? tr.t('automod.review.field.cases') : tr.t('automod.review.field.case'), value: codes.map((c) => `\`${c}\``).join(' '), inline: true });
    if (latest.messageUrl && !latest.deleted) fields.push({ name: tr.t('automod.review.field.messageLink'), value: tr.t('automod.review.field.jump', { url: latest.messageUrl }), inline: true });
    if (entry.kind === 'report' && entry.report?.reporter) fields.push({ name: tr.t('automod.review.field.reportedBy'), value: truncate(entry.report.reporter, 1024), inline: true });
    if (entry.contest) fields.push(contestField(entry.contest, { lang }));
    return fields;
}

/** The "Member disputes" field: the member's own words, markdown escaped. */
export function contestField(contest, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const reason = escapeMarkdown(String(contest?.reason ?? '').trim()) || tr.t('automod.review.field.noReason');
    return {
        name: contest?.caseCode ? tr.t('automod.review.field.disputesCase', { code: contest.caseCode }) : tr.t('automod.review.field.disputes'),
        value: truncate(reason, 1024),
    };
}

/** "**Excessive caps** · <@1> · warned · case `k3f9a` · <#2> · 3 messages" */
export function compactLine(entry, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const messages = (entry.count || 1) > 1 ? tr.tp('automod.review.compact.messages', entry.count) : null;
    if (entry.kind === 'note') {
        // "Second chance · <@1> · Excessive caps · <#2>"
        return [
            entry.note?.title || tr.t('automod.review.compact.note'),
            `<@${entry.userId}>`,
            ruleLabel(entry, lang),
            entry.channelId ? `<#${entry.channelId}>` : null,
            messages,
            probationText(entry, { lang }),
        ].filter(Boolean).join(' · ');
    }
    const action = latestAction(entry);
    const codes = caseCodes(entry);
    const parts = [
        `**${ruleLabel(entry, lang)}**`,
        `<@${entry.userId}>`,
        action ? outcomeShort(action.step, lang) : tr.t('automod.review.compact.flagged'),
        codes.length ? tr.tp('automod.review.compact.cases', codes.length, { codes: codes.map((c) => `\`${c}\``).join(' ') }) : null,
        entry.channelId ? `<#${entry.channelId}>` : null,
        messages,
        probationText(entry, { lang }),
    ];
    return parts.filter(Boolean).join(' · ');
}

function actionSelect(customId, placeholder, suggestedKey = null, lang = 'en') {
    const suggested = botText(lang).t('automod.review.button.suggested');
    return new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(Object.keys(REVIEW_ACTIONS).map((key) => ({
            label: reviewActionLabel(key, { lang }),
            value: key,
            default: false,
            description: key === suggestedKey ? suggested : undefined,
        })));
}

export function actionKeyFor(step) {
    return Object.entries(REVIEW_ACTIONS).find(([, action]) =>
        action.step.type === step?.type && (action.step.durationMs ?? null) === (step?.durationMs ?? null))?.[0] || null;
}

// The server the member is in (a home-server card can be about a support-server member), so
// "apply" acts there even after a restart (reviewCards.actingGuild). Old cards have none.
const guildSuffix = (entry) => (entry.guildId ? `:${entry.guildId}` : '');
const dismissButton = (tr) => new ButtonBuilder().setCustomId('amreview:dismiss').setLabel(tr.t('automod.review.button.dismiss')).setStyle(ButtonStyle.Secondary);

export function cardComponents(entry, tier = cardTier(entry), { lang = 'en' } = {}) {
    const tr = botText(lang);
    const codes = buttonCodes(entry);
    if (tier === 'compact') {
        if (!codes) return [];
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`amreview:undo:${codes}`).setLabel(tr.t('automod.review.button.undo')).setStyle(ButtonStyle.Secondary),
        )];
    }
    if (entry.kind === 'report') {
        const buttons = [dismissButton(tr)];
        if (!entry.report?.removed && entry.report?.messageId) {
            buttons.unshift(new ButtonBuilder().setCustomId(`amreview:delete:${entry.channelId}:${entry.report.messageId}`).setLabel(tr.t('automod.review.button.deleteMessage')).setStyle(ButtonStyle.Danger));
        }
        return [
            new ActionRowBuilder().addComponents(actionSelect(`amreview:apply:${REPORT_RULE}:${entry.userId}${guildSuffix(entry)}`, tr.t('automod.review.button.punishAuthor'), null, lang)),
            new ActionRowBuilder().addComponents(buttons),
        ];
    }
    if (entry.kind === 'monitor' || !codes) {
        const suggested = entry.kind === 'monitor' ? entry.suggested : latestAction(entry)?.step;
        return [
            new ActionRowBuilder().addComponents(actionSelect(`amreview:apply:${entry.rule}:${entry.userId}${guildSuffix(entry)}`, tr.t('automod.review.button.applyPunishment'), actionKeyFor(suggested), lang)),
            new ActionRowBuilder().addComponents(dismissButton(tr)),
        ];
    }
    const many = codes.includes(',');
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`amreview:keep:${codes}`).setLabel(many ? tr.t('automod.review.button.keepAll') : tr.t('automod.review.button.keep')).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`amreview:undo:${codes}`).setLabel(many ? tr.t('automod.review.button.undoAll') : tr.t('automod.review.button.undo')).setStyle(ButtonStyle.Danger),
        ),
        new ActionRowBuilder().addComponents(actionSelect(`amreview:change:${codes}`, many ? tr.t('automod.review.button.undoAllChangeTo') : tr.t('automod.review.button.changeTo'), null, lang)),
    ];
}

/** The language of a card: the server's (a staff-channel post). */
export function cardLanguage(entry) {
    return textForGuild(entry?.guildId || null, { purpose: 'public' }).lang;
}

/** The full message payload for a card: { content, embeds, components }. `lang`: default the card server's. */
export function buildCardPayload(entry, { lang = cardLanguage(entry) } = {}) {
    const tr = botText(lang);
    const tier = cardTier(entry);
    if (tier === 'compact') {
        return { content: truncate(compactLine(entry, { lang }), 2000), embeds: [], components: cardComponents(entry, tier, { lang }) };
    }
    const embed = createEmbed({
        title: truncate(cardTitle(entry, { lang }), 256),
        description: cardDescription(entry, { lang }),
        fields: cardFields(entry, { lang }),
        color: cardColor(entry),
        footer: { text: `${entry.username || tr.t('automod.review.unknownUser')} · ${entry.userId}` },
        timestamp: entry.firstAt ? new Date(entry.firstAt) : true,
    });
    return { content: '', embeds: [embed], components: cardComponents(entry, tier, { lang }) };
}
