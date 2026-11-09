// dmTemplates.js: the DM layouts sent to punished users.
//
// Language: the server's (owner's "mixed" rule). Every translated template takes `{ lang }` last;
// callers get it from resolveBotLanguage({ guildId, userId, purpose: 'dm' }) (utils/botText.js).
// Without it the DM is English, exactly as before. Text: src/content/bot/<lang>/enforcement.json
// (dm.*, duration.*). The keep-apart DMs and the "Contest this" button: member.json (keepApart.*,
// contest.button), also `{ lang }` last.
//
// Punishment DM layout (beginner audit 4.1/4.2, 2026-11-09): title first, then reason (with its
// rule), duration/end, what happens next, how to appeal, the case code "(you need this to
// appeal)", the optional record link: at most 7 lines before the short privacy footer.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isHomeGuild, resolveSetting } from '../settings/guildSettings.js';
import { dateStamp, stamp } from './format.js';
import { ruleLineFor } from '../rules/serverRules.js';
import { privacyUrl } from '../../utils/privacyNotice.js';
import { botText } from '../../utils/botText.js';
import { logger } from '../../utils/logger.js';
import { isWarnLadderEnabled } from './ladderPolicy.js';

const { serverName } = enforcementConfig;
const textOf = (lang) => botText(lang || 'en');

/**
 * The appeal invite a punishment DM of this server names (read on every use: settings change at
 * runtime). Mewvo's own servers (and a caller that names no server) keep Mewvo's Support invite,
 * exactly as before. Any other server: Mewvo's Support invite when it chose appealsHome 'mewvo',
 * its own appealsInvite with 'own' (the default for those servers since owner decision D2,
 * 2026-11-09; settingsRegistry neutral), and null (no invite line) with 'own' and no invite set. Never throws: when that server's settings cannot be read
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
    const origin = portalOrigin(env);
    return origin ? textOf(lang).t('enforcement.dm.record', { url: `${origin}/me` }) : null;
}

/** The website's origin when the member portal is on (MEMBER_PORTAL_ENABLED + an http(s) PUBLIC_URL), else null. */
function portalOrigin(env = process.env) {
    if (!/^(1|true|yes|on)$/i.test(String(env.MEMBER_PORTAL_ENABLED || '').trim())) return null;
    const origin = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
    return /^https?:\/\/[^\s<>]+$/.test(origin) ? origin : null;
}

/**
 * The member portal's web appeal page for a case of another (non-home) server: /me/appeal/<code>,
 * or /me/appeals without a code (multi-server B4a). A member punished there often shares no server
 * with the bot, so the Discord panel cannot reach them; the website always can. Mewvo's own
 * servers (and a caller that names no server) keep their DMs exactly as before: null. Null too
 * while the portal is off.
 */
export function webAppealUrl(guildId, caseCode = null, env = process.env) {
    if (!guildId || isHomeGuild(guildId, env)) return null;
    const origin = portalOrigin(env);
    if (!origin) return null;
    return caseCode && /^[a-z0-9]{5,7}$/.test(caseCode) ? `${origin}/me/appeal/${caseCode}` : `${origin}/me/appeals`;
}

/**
 * The appeal line of a punishment DM: the most direct way the member can use. The invite
 * (appealInvite) and, for another server with the member portal on, the web appeal page, joined
 * on one line when both exist. Another (non-home) server with neither: "To appeal, contact the
 * staff of <server>" for an appealable case, so the DM never leaves the member without a way
 * (owner decision D2). Mewvo's own servers: the invite line, or nothing.
 * `unappealableLine`: an unappealable case says so ("This ban cannot be appealed."; the ban DM).
 * Returns { line, where, web }: `where` is true when the DM names a formal appeal path (the ban
 * DM's appeal notes depend on it), `web` when the line already links the member portal.
 */
function appealLines(rec, tr, { guildId, serverName: name } = {}, { unappealableLine = false } = {}) {
    const gid = guildOf(rec, guildId);
    const inviteUrl = appealInvite(gid);
    if (rec?.unappealable) return { line: unappealableLine ? tr.t('enforcement.dm.cannotAppeal') : appealHere(tr, inviteUrl), where: false, web: false };
    const webUrl = rec ? webAppealUrl(gid, rec.case_code) : null;
    if (inviteUrl && webUrl) return { line: tr.t('enforcement.dm.appealBoth', { invite: inviteUrl, url: webUrl }), where: true, web: true };
    if (inviteUrl) return { line: appealHere(tr, inviteUrl), where: true, web: false };
    if (webUrl) return { line: tr.t('enforcement.dm.appealWeb', { url: webUrl }), where: true, web: true };
    if (!gid || isHomeGuild(gid)) return { line: null, where: false, web: false };
    // where: false — "contact the staff" is not a formal appeal, so the ban DM's appeal notes
    // ("If your appeal is accepted…", "You can appeal until…") stay out, as before.
    return { line: tr.t('enforcement.dm.appealAskStaff', { server: serverFor(rec, { guildId, serverName: name }, tr) }), where: false, web: false };
}

/**
 * "Reason: Spam (Rule 3: No spam, <link>)" when the prebuilt reason is linked to a server rule,
 * as { full, plain }: finish() keeps the rule part only while the DM fits Discord's limit.
 */
function reasonLine(rec, tr) {
    const plain = tr.t('enforcement.dm.reason', { reason: rec.reason });
    const rule = ruleLineFor(rec, process.env, { word: tr.t('enforcement.dm.rule') });
    return rule ? { full: tr.t('enforcement.dm.reasonRule', { reason: rec.reason, rule }), plain } : plain;
}

/** "Case code: x (you need this to appeal)"; just "Case code: x" when the case cannot be appealed. */
function caseLine(rec, tr) {
    return rec.unappealable
        ? tr.t('enforcement.dm.caseCode', { code: rec.case_code })
        : tr.t('enforcement.dm.caseCodeAppeal', { code: rec.case_code });
}

/**
 * Joins DM lines (beginner audit 4.1: the title first, at most 7 lines before the privacy footer).
 * A { full, plain } line (the reason with its rule) and an { optional } line (the record link)
 * keep their extra only while the DM fits Discord's limit; nulls are dropped.
 */
function finish(lines, tr) {
    const plain = lines.map((line) => (typeof line === 'string' ? line : line?.plain || null)).filter(Boolean);
    const rich = lines.map((line) => (typeof line === 'string' ? line : line?.full || line?.optional || line?.plain || null)).filter(Boolean);
    const text = rich.join('\n');
    return withPrivacyLine(text.length <= DM_MAX ? text : plain.join('\n'), process.env, { lang: tr.lang });
}

/** "Your full record: <…/me>"; left out when the appeal line already links the member portal. */
const recordOf = (tr, appeal) => (appeal?.web ? null : { optional: recordLine(process.env, { lang: tr.lang }) });

function banDmText(rec, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    const duration = rec.expires_at
        ? tr.t('enforcement.dm.duration', { duration: durationIn(Number(rec.duration_ms), tr.lang), end: stamp(rec.expires_at) })
        : tr.t('enforcement.dm.durationPermanent');
    const appeal = appealLines(rec, tr, { guildId, serverName: name }, { unappealableLine: true });
    // What happens next: the appeal notes, only when the DM says where to appeal (home servers
    // without an invite: neither).
    const notes = [];
    if (rec.is_auto && !rec.unappealable && appeal.where) notes.push(tr.t('enforcement.dm.ban.autoNote'));
    if (rec.ladder_level_after === 3 && rec.is_auto && rec.appeal_deadline && !rec.unappealable && appeal.where) {
        notes.push(tr.t('enforcement.dm.ban.appealUntil', { date: dateStamp(rec.appeal_deadline) }));
    }
    return finish([
        tr.t('enforcement.dm.ban.title', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        reasonLine(rec, tr),
        duration,
        notes.length ? notes.join(' ') : null,
        appeal.line,
        caseLine(rec, tr),
        recordOf(tr, appeal),
    ], tr);
}

function kickDmText(rec, inviteUrl, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    const appeal = appealLines(rec, tr, { guildId, serverName: name });
    return finish([
        tr.t('enforcement.dm.kick.title', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        reasonLine(rec, tr),
        inviteUrl ? tr.t('enforcement.dm.rejoin', { invite: inviteUrl }) : tr.t('enforcement.dm.kick.noInvite'),
        appeal.line,
        caseLine(rec, tr),
        recordOf(tr, appeal),
    ], tr);
}

function muteDmText(rec, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    const appeal = appealLines(rec, tr, { guildId, serverName: name });
    return finish([
        tr.t('enforcement.dm.mute.title', { server: serverFor(rec, { guildId, serverName: name }, tr) }),
        reasonLine(rec, tr),
        tr.t('enforcement.dm.duration', { duration: durationIn(Number(rec.duration_ms), tr.lang), end: stamp(rec.expires_at) }),
        tr.t('enforcement.dm.mute.next'),
        appeal.line,
        caseLine(rec, tr),
        recordOf(tr, appeal),
    ], tr);
}

/**
 * `warnNumber` null: the warn does not count toward the ladder (warn ladder off in that server, or
 * an automod warn there, ladderPolicy.js), so no "Warning X of 3" and no ban talk.
 * A counted warn DM is only sent below the limit (the warn that reaches it is announced by the
 * ban DM alone), so "what happens next" says how many more warnings lead to which ban.
 */
function warnDmText(rec, warnNumber, { lang, guildId, serverName: name } = {}) {
    const tr = textOf(lang);
    const limit = enforcementConfig.warnsPerLevel;
    const counted = warnNumber !== null && warnNumber !== undefined;
    const server = serverFor(rec, { guildId, serverName: name }, tr);
    // The ban that comes at the limit (audit 3.2): the next stage's ban length.
    const banAtLimit = enforcementConfig.ladderBans[Math.min((Number(rec.ladder_level_after) || 0) + 1, 3)];
    const left = Math.max(1, limit - (Number(warnNumber) || 0));
    const nextLine = !counted
        ? tr.t('enforcement.dm.warn.notCounted')
        : banAtLimit != null
            ? tr.tp('enforcement.dm.warn.next', left, { length: durationIn(banAtLimit, tr.lang) })
            : tr.tp('enforcement.dm.warn.nextPermanent', left);
    const appeal = appealLines(rec, tr, { guildId, serverName: name });
    return finish([
        counted ? tr.t('enforcement.dm.warn.title', { number: warnNumber, limit, server }) : tr.t('enforcement.dm.warn.titleRecorded', { server }),
        reasonLine(rec, tr),
        nextLine,
        appeal.line,
        caseLine(rec, tr),
        recordOf(tr, appeal),
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
    const base = inviteUrl ? tr.t('enforcement.dm.appealDenied', { invite: inviteUrl }) : tr.t('enforcement.dm.appealDeniedNoInvite');
    // Another server's case: also the web appeal page (multi-server B4a); home servers unchanged.
    const web = webAppealUrl(guildId);
    const text = web ? `${base}\n${tr.t('enforcement.dm.appealDeniedWeb', { url: web })}` : base;
    return withPrivacyLine(text, process.env, { lang: tr.lang });
}

/**
 * After an automatic (warn ladder) ban at stage 1 or 2: the ladder never resets, so the next
 * counted warning bans again at once (enforcementService previewWarn: threshold 1 above stage 0).
 * Says so with the real length. Nothing for a manual ban, a stage-3 (permanent) ban, or a server
 * whose warn ladder is off; a settings read that fails leaves the line out (never a guess).
 * An unban does not move the ladder (doUnban), so this holds for an early end too; an accepted
 * appeal sends appealAccepted instead.
 */
function nextWarnLine(rec, tr, gid) {
    const stage = Number(rec?.ladder_level_after);
    if (!rec?.is_auto || rec.type !== 'ban' || !(stage === 1 || stage === 2)) return null;
    try {
        if (!isWarnLadderEnabled(gid)) return null;
    } catch (error) {
        logger.warn(`Warn ladder setting of guild ${gid} not readable (${error?.message || error}); ban-ended DM sent without the next-warning line.`);
        return null;
    }
    const length = enforcementConfig.ladderBans[stage + 1];
    return length != null
        ? tr.t('enforcement.dm.banEnded.nextWarn', { length: durationIn(length, tr.lang) })
        : tr.t('enforcement.dm.banEnded.nextWarnPermanent');
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
        nextWarnLine(rec, tr, gid),
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

// ── Keep-apart (no-contact) DMs: member.json keepApart.* (audit 4.3) ─────────────

/** The order's server in a keep-apart DM ("the server" in the DM's language when it has no name). */
const keepApartServer = (order, name, tr) => dmServerName(order?.guild_id, name, tr.t('enforcement.dm.thisServer'));

/**
 * Sent to both members when staff start a no-contact order. `other` is the other member (or null);
 * `options.serverName`: the order's server name (another server than Mewvo's is named by it).
 * `options.lang`: the member's language (English: the text as before).
 */
function noContactStartedDmText(order, other, { serverName: name, lang } = {}) {
    const tr = textOf(lang);
    const otherName = other ? `**${other.username}**` : tr.t('member.keepApart.anotherMember');
    return withPrivacyLine([
        tr.t('member.keepApart.startedTitle', { server: keepApartServer(order, name, tr) }),
        tr.t('member.keepApart.asked', { other: otherName, until: stamp(order.until) }),
        tr.t('member.keepApart.rule'),
        tr.t('member.keepApart.reason', { reason: order.reason }),
        tr.t('member.keepApart.notPunishment'),
    ].join('\n'), process.env, { lang: tr.lang });
}

/** Sent to both members when a no-contact order ends (early by staff, or it expired). */
function noContactEndedDmText(order, other, { early = false, serverName: name, lang } = {}) {
    const tr = textOf(lang);
    return withPrivacyLine([
        tr.t('member.keepApart.endedTitle', { server: keepApartServer(order, name, tr) }),
        `${tr.t(early ? 'member.keepApart.early' : 'member.keepApart.expired')} ${tr.t('member.keepApart.contact', { other: other ? `**${other.username}**` : tr.t('member.keepApart.theOtherMember') })}`,
    ].join('\n'), process.env, { lang: tr.lang });
}

/**
 * The "Contest this" button under an automod DM whose message was deleted
 * (automodContest.js), in the DM's language. DM buttons work without a shared server.
 * customId carries the case code: amcontest:open:<code> (unchanged in every language).
 */
export function contestComponents(caseCode, { lang } = {}) {
    if (!caseCode) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`amcontest:open:${caseCode}`).setLabel(textOf(lang).t('member.contest.button').slice(0, 80)).setStyle(ButtonStyle.Secondary),
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
export const noContactStartedDm = englishOnError('noContactStartedDm', noContactStartedDmText);
export const noContactEndedDm = englishOnError('noContactEndedDm', noContactEndedDmText);
