// dmTemplates.js: the DM layouts sent to punished users.
//
// Language: the server's (owner's "mixed" rule). Every translated template takes `{ lang }` last;
// callers get it from resolveBotLanguage({ guildId, userId, purpose: 'dm' }) (utils/botText.js).
// Without it the DM is English, exactly as before. Text: src/content/bot/<lang>/enforcement.json
// (dm.*, duration.*). The keep-apart DMs and the "Contest this" button are still English only.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isHomeGuild, resolveSetting } from '../settings/guildSettings.js';
import { dateStamp, stamp } from './format.js';
import { ruleLineFor } from '../rules/serverRules.js';
import { privacyUrl } from '../../utils/privacyNotice.js';
import { botText } from '../../utils/botText.js';
import { logger } from '../../utils/logger.js';

const { serverName } = enforcementConfig;
const textOf = (lang) => botText(lang || 'en');

/**
 * The appeal invite a punishment DM of this server names (read on every use: settings change at
 * runtime). Mewvo's own servers (and a caller that names no server) keep Mewvo's Support invite,
 * exactly as before. Any other server: Mewvo's Support invite when its appealsHome is 'mewvo'
 * (the default), its own appealsInvite when it chose 'own', and null (no invite line) when it
 * chose 'own' without setting one. Never throws: when that server's settings cannot be read
 * (database down at boot) the DM goes out without the line instead of stopping the action.
 */
export function appealInvite(guildId, env = process.env) {
    if (!guildId || isHomeGuild(guildId, env)) return enforcementConfig.supportServerInvite;
    try {
        if (resolveSetting(guildId, 'appealsHome', env) === 'own') return resolveSetting(guildId, 'appealsInvite', env) || null;
        return enforcementConfig.supportServerInvite || null;
    } catch (error) {
        logger.warn(`Appeal invite of guild ${guildId} not readable (${error?.message || error}); DM sent without it.`);
        return null;
    }
}

/** The guild a DM is about: options.guildId, else the case's guild. */
const guildOf = (rec, guildId) => guildId ?? rec?.guild_id ?? null;

/**
 * A Discord server name made safe for a DM line: one line, at most 100 characters, markdown
 * escaped (it sits inside **bold**; masked links too), and @ / < broken with a zero-width space so the name can
 * never render as a mention. Empty or missing → ''.
 */
export function safeServerName(name) {
    const flat = String(name ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!flat) return '';
    return escapeMarkdown(flat, { maskedLink: true }).replace(/@/g, '@\u200b').replace(/</g, '<\u200b');
}

/**
 * The server a DM names. Mewvo's own servers (and a caller that names no server) keep 'Mewvo',
 * exactly as before. Any other server: its Discord name (`name`: callers pass guild.name, else
 * the case's guild_name when a row carries one), made safe; unknown → `fallback` (a neutral
 * "the server" in the DM's language).
 */
export function dmServerName(guildId, name, fallback = 'the server') {
    if (!guildId || isHomeGuild(guildId)) return serverName;
    return safeServerName(name) || fallback;
}

/** dmServerName for the translated templates: options.serverName, else rec.guild_name. */
function serverFor(rec, { guildId, serverName: name } = {}, tr) {
    const gid = guildOf(rec, guildId);
    // Home: no catalog lookup at all, so Mewvo's DMs stay byte-for-byte as before.
    if (!gid || isHomeGuild(gid)) return serverName;
    return dmServerName(gid, name ?? rec?.guild_name, tr.t('enforcement.dm.thisServer'));
}

/** "Appeal here: <invite>", or null when this server has no invite to name. */
function appealHere(tr, inviteUrl) {
    return inviteUrl ? tr.t('enforcement.dm.appealHere', { invite: inviteUrl }) : null;
}

function appealLine(record, tr, inviteUrl) {
    return record.unappealable
        ? tr.t('enforcement.dm.cannotAppeal')
        : appealHere(tr, inviteUrl);
}

// Discord's message content limit: the rule line is dropped rather than going over it.
const DM_MAX = 2000;

const MINUTE = 60 * 1000;
const DURATION_UNITS = [['month', 30 * 24 * 60 * MINUTE], ['day', 24 * 60 * MINUTE], ['hour', 60 * MINUTE], ['minute', MINUTE]];

/**
 * A duration in words in a language, the same shape as format.js formatDuration (at most two
 * units: "1 day 12 hours"). English is identical to formatDuration (a test checks).
 */
export function durationIn(ms, lang = 'en') {
    const tr = textOf(lang);
    if (ms == null) return tr.t('enforcement.duration.permanent');
    const parts = [];
    let rest = ms;
    for (const [unit, size] of DURATION_UNITS) {
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(tr.tp(`enforcement.duration.${unit}`, count));
            rest -= count * size;
        }
    }
    return parts.slice(0, 2).join(' ') || tr.t('enforcement.duration.lessThanMinute');
}

/**
 * Adds "Privacy: <PUBLIC_URL/privacy>" as the last line when PUBLIC_URL is set and the
 * DM still fits the limit; otherwise the DM is returned unchanged.
 */
export function withPrivacyLine(text, env = process.env, { lang = 'en' } = {}) {
    const url = privacyUrl(env);
    if (!url) return text;
    const out = `${text}\n${textOf(lang).t('enforcement.dm.privacy', { url })}`;
    return out.length <= DM_MAX ? out : text;
}

/**
 * "Your full record: <https://…/me>" when the website's My record page is on
 * (MEMBER_PORTAL_ENABLED + an http(s) PUBLIC_URL); otherwise nothing. Optional like the rule line.
 */
export function recordLine(env = process.env, { lang = 'en' } = {}) {
    if (!/^(1|true|yes|on)$/i.test(String(env.MEMBER_PORTAL_ENABLED || '').trim())) return null;
    const origin = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s<>]+$/.test(origin)) return null;
    return textOf(lang).t('enforcement.dm.record', { url: `${origin}/me` });
}

function common(record, tr) {
    return [
        tr.t('enforcement.dm.by', { name: record.moderator_username }),
        tr.t('enforcement.dm.reason', { reason: record.reason }),
        // "Rule 3: No spam — <link>" when the prebuilt reason is linked to a server rule.
        { ruleLine: ruleLineFor(record, process.env, { word: tr.t('enforcement.dm.rule') }) },
        tr.t('enforcement.dm.date', { date: dateStamp(record.created_at) }),
    ];
}

/** Joins DM lines; the rule line placeholder is kept only while the DM fits the limit. */
function finish(lines, tr) {
    const plain = lines.filter((line) => typeof line === 'string');
    const withRule = lines.map((line) => (typeof line === 'string' ? line : line?.ruleLine || line?.optional || null)).filter(Boolean);
    const text = withRule.join('\n');
    return withPrivacyLine(text.length <= DM_MAX ? text : plain.join('\n'), process.env, { lang: tr.lang });
}

const record = (tr) => ({ optional: recordLine(process.env, { lang: tr.lang }) });

function banDmText(rec, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    const duration = rec.expires_at
        ? tr.t('enforcement.dm.duration', { duration: durationIn(Number(rec.duration_ms), tr.lang), end: stamp(rec.expires_at) })
        : tr.t('enforcement.dm.durationPermanent');
    const inviteUrl = appealInvite(guildOf(rec, guildId));
    const lines = [
        appealLine(rec, tr, inviteUrl),
        tr.t('enforcement.dm.ban.title', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        ...common(rec, tr),
        duration,
        tr.t('enforcement.dm.caseCode', { code: rec.case_code }),
        record(tr),
    ];
    // The appeal notes only when the DM says where to appeal (a server with no invite: neither).
    if (rec.is_auto && !rec.unappealable && inviteUrl) {
        lines.push(tr.t('enforcement.dm.ban.autoNote'));
    }
    if (rec.ladder_level_after === 3 && rec.is_auto && rec.appeal_deadline && !rec.unappealable && inviteUrl) {
        lines.push(tr.t('enforcement.dm.ban.appealUntil', { date: dateStamp(rec.appeal_deadline) }));
    }
    return finish(lines, tr);
}

function kickDmText(rec, inviteUrl, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    return finish([
        appealHere(tr, appealInvite(guildOf(rec, guildId))),
        tr.t('enforcement.dm.kick.title', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        ...common(rec, tr),
        tr.t('enforcement.dm.caseCode', { code: rec.case_code }),
        inviteUrl ? tr.t('enforcement.dm.rejoin', { invite: inviteUrl }) : tr.t('enforcement.dm.kick.noInvite'),
        record(tr),
    ], tr);
}

function muteDmText(rec, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    return finish([
        appealHere(tr, appealInvite(guildOf(rec, guildId))),
        tr.t('enforcement.dm.mute.title', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        ...common(rec, tr),
        tr.t('enforcement.dm.duration', { duration: durationIn(Number(rec.duration_ms), tr.lang), end: stamp(rec.expires_at) }),
        tr.t('enforcement.dm.caseCode', { code: rec.case_code }),
        record(tr),
    ], tr);
}

function warnDmText(rec, warnNumber, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    const limit = enforcementConfig.warnsPerLevel;
    return finish([
        appealHere(tr, appealInvite(guildOf(rec, guildId))),
        tr.t('enforcement.dm.warn.title', { number: warnNumber, limit, server: serverFor(rec, { guildId, serverName: name }, tr) }),
        ...common(rec, tr),
        tr.t('enforcement.dm.caseCode', { code: rec.case_code }),
        tr.t('enforcement.dm.warn.limit', { limit }),
        record(tr),
    ], tr);
}

/**
 * The "no rejoin invite" line for another (non-home) server: its own invite when it set one
 * (appealsHome 'own'), else "ask a staff member". Mewvo's Support can only invite people back into
 * Mewvo's own servers, so it is never named here. Shared by banEnded and appealAccepted.
 */
function otherServerNoInviteLine(tr, gid) {
    const own = appealInvite(gid);
    return own && own !== enforcementConfig.supportServerInvite
        ? tr.t('enforcement.dm.banEnded.noInvite', { invite: own })
        : tr.t('enforcement.dm.kick.noInvite');
}

/**
 * `rec` (optional): the accepted case. Home servers (or no case named): unchanged. Any other
 * server: names the server and the case code, and without a rejoin invite follows the banEnded
 * rule (that server's own invite, or "ask a staff member"), never Mewvo's Support.
 */
function appealAcceptedDmText(adminUsername, inviteUrl, { lang, rec = null, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    const gid = guildOf(rec, guildId);
    if (!gid || isHomeGuild(gid)) {
        return withPrivacyLine([
            tr.t('enforcement.dm.appealAccepted.title'),
            tr.t('enforcement.dm.by', { name: adminUsername }),
            inviteUrl || tr.t('enforcement.dm.appealAccepted.noInvite'),
        ].join('\n'), process.env, { lang: tr.lang });
    }
    return withPrivacyLine([
        tr.t('enforcement.dm.appealAccepted.titleIn', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        tr.t('enforcement.dm.by', { name: adminUsername }),
        rec?.case_code ? tr.t('enforcement.dm.caseCode', { code: rec.case_code }) : null,
        inviteUrl ? tr.t('enforcement.dm.rejoin', { invite: inviteUrl }) : otherServerNoInviteLine(tr, gid),
    ].filter(Boolean).join('\n'), process.env, { lang: tr.lang });
}

/** `guildId`: the server of the denied appeal's case (none named: Mewvo's Support invite, as before). */
function appealDeniedDmText({ lang, guildId } = {}) {
    const tr = textOf(lang);
    const inviteUrl = appealInvite(guildId);
    const text = inviteUrl ? tr.t('enforcement.dm.appealDenied', { invite: inviteUrl }) : tr.t('enforcement.dm.appealDeniedNoInvite');
    return withPrivacyLine(text, process.env, { lang: tr.lang });
}

/**
 * Sent when a ban ends: on expiry, or early when a moderator unbans.
 * `inviteUrl` is a one-time invite back to the server (null when none could be made).
 */
function banEndedDmText(rec, inviteUrl, { early = false, lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    // "Ask for an invite in the support server": Mewvo's Support can only invite people back into
    // Mewvo's own servers, so another server names only its own invite here (else: ask staff).
    const gid = guildOf(rec, guildId);
    const home = !gid || isHomeGuild(gid);
    const homeUrl = home && !inviteUrl ? appealInvite(gid) : null;
    return withPrivacyLine([
        tr.t('enforcement.dm.banEnded.title', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        early ? tr.t('enforcement.dm.banEnded.early') : tr.t('enforcement.dm.banEnded.expired'),
        rec?.case_code ? tr.t('enforcement.dm.caseCode', { code: rec.case_code }) : null,
        inviteUrl ? tr.t('enforcement.dm.rejoin', { invite: inviteUrl })
            : !home ? otherServerNoInviteLine(tr, gid)
                : homeUrl ? tr.t('enforcement.dm.banEnded.noInvite', { invite: homeUrl }) : tr.t('enforcement.dm.kick.noInvite'),
    ].filter(Boolean).join('\n'), process.env, { lang: tr.lang });
}

/** Sent when a mute ends: on expiry, or early when a moderator unmutes. */
function muteEndedDmText(rec, { early = false, lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    return withPrivacyLine([
        tr.t('enforcement.dm.muteEnded.title', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        early ? tr.t('enforcement.dm.muteEnded.early') : tr.t('enforcement.dm.muteEnded.expired'),
        rec?.case_code ? tr.t('enforcement.dm.caseCode', { code: rec.case_code }) : null,
    ].filter(Boolean).join('\n'), process.env, { lang: tr.lang });
}

const VOIDED_TYPES = new Set(['ban', 'kick', 'mute', 'warn']);

/**
 * Sent when an admin voids a case (/case remove): the record no longer counts against
 * the user. `inviteUrl` is set when the void lifted a ban.
 */
function caseVoidedDmText(rec, reason, inviteUrl = null, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    const server = serverFor(rec, { guildId, serverName: name }, tr);
    const title = VOIDED_TYPES.has(rec.type)
        ? tr.t(`enforcement.dm.voided.title.${rec.type}`, { server })
        : tr.t('enforcement.dm.voided.title.generic', { type: rec.type, server });
    return withPrivacyLine([
        title,
        tr.t('enforcement.dm.caseCode', { code: rec.case_code }),
        tr.t('enforcement.dm.voided.reason', { reason }),
        tr.t('enforcement.dm.voided.mistake'),
        inviteUrl ? tr.t('enforcement.dm.voided.unbanned', { invite: inviteUrl }) : null,
    ].filter(Boolean).join('\n'), process.env, { lang: tr.lang });
}

/**
 * Sent to both members when staff start a no-contact order. `other` is the other member (or null);
 * `options.serverName`: the order's server name (another server than Mewvo's is named by it).
 */
export function noContactStartedDm(order, other, { serverName: name } = {}) {
    const otherName = other ? `**${other.username}**` : 'another member';
    return withPrivacyLine([
        `**Keep apart: an order in ${dmServerName(order?.guild_id, name)}**`,
        `Staff have asked you and ${otherName} not to contact each other until ${stamp(order.until)}.`,
        'Until then, do not mention or reply to them in the server: those messages are removed.',
        `Reason: ${order.reason}`,
        'This is not a punishment and does not count as a warning.',
    ].join('\n'));
}

/** Sent to both members when a no-contact order ends (early by staff, or it expired). */
export function noContactEndedDm(order, other, { early = false, serverName: name } = {}) {
    return withPrivacyLine([
        `**Your keep-apart order in ${dmServerName(order?.guild_id, name)} has ended**`,
        `${early ? 'Staff ended it early.' : 'It expired.'} You may contact ${other ? `**${other.username}**` : 'the other member'} again.`,
    ].join('\n'));
}

/**
 * The "Contest this" button under an automod DM whose message was deleted
 * (automodContest.js). DM buttons work without a shared server. customId carries
 * the case code: amcontest:open:<code>.
 */
export function contestComponents(caseCode) {
    if (!caseCode) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`amcontest:open:${caseCode}`).setLabel('Contest this').setStyle(ButtonStyle.Secondary),
    )];
}

/**
 * A translated DM must never stop an action halfway: the text is built before sendDm's own
 * try/catch, so a broken catalog entry (missing key or {placeholder}, bad JSON) would abort a ban
 * or mute after the case row is written. On any error in a non-English template, log it and send
 * the English text instead. English failing is a code bug and still throws (tests cover it).
 */
export function englishOnError(name, render) {
    return (...parts) => {
        try {
            return render(...parts);
        } catch (error) {
            const options = parts.at(-1);
            if (!options || typeof options !== 'object' || !options.lang || options.lang === 'en') throw error;
            logger.warn(`DM template ${name} failed in ${options.lang} (${error?.message || error}); sent in English.`);
            return render(...parts.slice(0, -1), { ...options, lang: 'en' });
        }
    };
}

export const banDm = englishOnError('banDm', banDmText);
export const kickDm = englishOnError('kickDm', kickDmText);
export const muteDm = englishOnError('muteDm', muteDmText);
export const warnDm = englishOnError('warnDm', warnDmText);
export const appealAcceptedDm = englishOnError('appealAcceptedDm', appealAcceptedDmText);
export const appealDeniedDm = englishOnError('appealDeniedDm', appealDeniedDmText);
export const banEndedDm = englishOnError('banEndedDm', banEndedDmText);
export const muteEndedDm = englishOnError('muteEndedDm', muteEndedDmText);
export const caseVoidedDm = englishOnError('caseVoidedDm', caseVoidedDmText);
