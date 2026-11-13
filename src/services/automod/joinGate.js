// joinGate.js — optional checks on members joining a server (/automod joingate). Runs in
// every server where automod is on (off by default outside the main server).
//
// Checks (each off / flag / kick, all off by default):
//   avatar   no profile picture
//   links    username or display name contains an invite or link (discord.gg/…, http…, x.com)
//   botname  username looks generated: letters followed by 5+ digits ("alex483920"), or
//            12+ characters mixing letters and digits at random ("k3j9x0q2m7pz")
//   age      account younger than N days (default: the OAuth verification guard's
//            minimum, MIN_ACCOUNT_AGE_MS, so both agree)
// "flag" posts one compact line in the review channel with Kick / Dismiss buttons;
// "kick" DMs the member why and how to come back, then kicks (no case: they broke no
// rule). If several checks hit, the strongest action wins.
//
// Bots, and members who already verified with "Verify with Discord" (stored OAuth
// tokens: they passed the verification guard, account age included), are exempt.
// Profile bios are not visible to bots, so "invite in bio" can't be checked.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SnowflakeUtil } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { createEmbed } from '../../utils/embeds.js';
import { deleteFromDb, getFromDb, setInDb } from '../../utils/database.js';
import { MIN_ACCOUNT_AGE_MS } from '../verificationGuard.js';
import { hasVerifiedIn } from '../oauthVerification.js';
import { formatDuration } from '../enforcement/format.js';
import { durationIn } from '../enforcement/dmTemplates.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { getAutomodSettings, isImmuneMember } from './automodSettings.js';
import { reviewChannel } from './reviewCards.js';
import { STATUS_COLORS } from './reviewFormat.js';

const DAY = 24 * 60 * 60 * 1000;
export const JOIN_GATE_ACTIONS = ['off', 'flag', 'kick'];
export const DEFAULT_GATE_DAYS = Math.round(MIN_ACCOUNT_AGE_MS / DAY);
const FLAG_TTL_SECONDS = 14 * 24 * 60 * 60;

export const JOIN_GATE_CHECKS = {
    avatar: { label: 'No profile picture', comeBack: 'after setting a profile picture' },
    links: { label: 'Link or invite in their name', comeBack: 'after removing the link from your username and display name' },
    botname: { label: 'Generated-looking username', comeBack: 'with a username that does not look automatically generated' },
    age: { label: 'New account', comeBack: 'once your account is older' },
};

// The check names, come-back hints and actions in a language (literal keys: tests/botI18nUsage.test.js).
const CHECK_TEXT = {
    avatar: (tr) => ({ label: tr.t('automod.joinGate.check.avatar'), comeBack: tr.t('automod.joinGate.comeBack.avatar') }),
    links: (tr) => ({ label: tr.t('automod.joinGate.check.links'), comeBack: tr.t('automod.joinGate.comeBack.links') }),
    botname: (tr) => ({ label: tr.t('automod.joinGate.check.botname'), comeBack: tr.t('automod.joinGate.comeBack.botname') }),
    age: (tr) => ({ label: tr.t('automod.joinGate.check.age'), comeBack: tr.t('automod.joinGate.comeBack.age') }),
};
const ACTION_TEXT = {
    off: (tr) => tr.t('automod.joinGate.action.off'),
    flag: (tr) => tr.t('automod.joinGate.action.flag'),
    kick: (tr) => tr.t('automod.joinGate.action.kick'),
};

/** A check's { label, comeBack } in a language (English: JOIN_GATE_CHECKS as is). */
export function joinGateCheckText(check, { lang = 'en' } = {}) {
    if (lang === 'en' || !CHECK_TEXT[check]) return JOIN_GATE_CHECKS[check];
    return CHECK_TEXT[check](botText(lang));
}

/** A join gate action word (off / flag / kick) in a language. */
export function joinGateActionText(action, { lang = 'en' } = {}) {
    if (lang === 'en' || !ACTION_TEXT[action]) return action;
    return ACTION_TEXT[action](botText(lang));
}

/**
 * One hit's reason in a language. English (and hits stored before `detail` existed): the stored
 * English reason as is. Member text (a name) goes in as a parameter, never re-read.
 */
export function hitReason(hit, { lang = 'en' } = {}) {
    const detail = hit?.detail;
    if (lang === 'en' || !detail) return hit.reason;
    const tr = botText(lang);
    if (hit.check === 'avatar') return tr.t('automod.joinGate.reason.avatar');
    if (hit.check === 'links') return tr.t('automod.joinGate.reason.links', { name: String(detail.name ?? '') });
    if (hit.check === 'botname') return tr.t('automod.joinGate.reason.botname', { name: String(detail.name ?? '') });
    if (hit.check === 'age') return tr.tp('automod.joinGate.reason.age', detail.days, { age: durationIn(detail.ageMs, lang) });
    return hit.reason;
}

export const DEFAULT_JOIN_GATE = Object.freeze({ avatar: 'off', links: 'off', botname: 'off', age: 'off', ageDays: DEFAULT_GATE_DAYS });

/** Stored join gate settings (any shape) → a complete object. */
export function normalizeJoinGate(stored) {
    const value = stored && typeof stored === 'object' ? stored : {};
    const out = {};
    for (const check of Object.keys(JOIN_GATE_CHECKS)) {
        out[check] = JOIN_GATE_ACTIONS.includes(value[check]) ? value[check] : 'off';
    }
    const days = Math.round(Number(value.ageDays));
    out.ageDays = Number.isFinite(days) && days >= 1 ? Math.min(days, 365) : DEFAULT_GATE_DAYS;
    return out;
}

const LINK_PATTERNS = [
    /discord(?:app)?\s*\.\s*(?:gg|com\s*\/\s*invite|me)\s*\//i,
    /\.gg\s*\/\s*\w/i,
    /https?:\/\//i,
    /\bwww\./i,
    /\b(?:t\.me|bit\.ly|x\.com|tiktok\.com|youtube\.com|youtu\.be|twitch\.tv|onlyfans\.com)\b/i,
    /\b[a-z0-9-]{2,}\.(?:com|net|gg|xyz|ru|shop|store|link|click|site)\b/i,
];

/** True when a name contains an invite or link. */
export function nameHasLink(name) {
    if (!name) return false;
    return LINK_PATTERNS.some((pattern) => pattern.test(String(name)));
}

/**
 * True for usernames that look machine-made. Conservative on purpose: real
 * usernames often have a few digits ("sam_2004"), so only these count:
 * letters then 5+ digits, or 12+ letters-and-digits with 4+ letter↔digit switches.
 */
export function looksGenerated(username) {
    const name = String(username || '').toLowerCase();
    if (/^[a-z]{3,}\d{5,}$/.test(name)) return true;
    if (/^[a-z0-9]{12,}$/.test(name)) {
        const switches = (name.match(/[a-z](?=\d)|\d(?=[a-z])/g) || []).length;
        const digits = (name.match(/\d/g) || []).length;
        if (switches >= 4 && digits >= 3) return true;
    }
    return false;
}

const STRENGTH = { off: 0, flag: 1, kick: 2 };

/**
 * The checks a user fails. user: { id, username, globalName, avatar }.
 * Returns { action: 'off'|'flag'|'kick', hits: [{ check, action, reason }] }.
 */
export function evaluateJoinGate(user, gate, now = Date.now()) {
    const settings = normalizeJoinGate(gate);
    const hits = [];
    // reason: English (audit log, stored flag, timeline); detail: the parts for a translated reason (hitReason).
    const add = (check, reason, detail = {}) => {
        if (settings[check] !== 'off') hits.push({ check, action: settings[check], reason, detail });
    };
    if (!user.avatar) add('avatar', 'no profile picture');
    const linked = [user.username, user.globalName].find((name) => nameHasLink(name));
    if (linked) add('links', `link in their name ("${String(linked).slice(0, 40)}")`, { name: String(linked).slice(0, 40) });
    if (looksGenerated(user.username)) add('botname', `generated-looking username ("${user.username}")`, { name: String(user.username) });
    const ageMs = now - SnowflakeUtil.timestampFrom(user.id);
    if (ageMs < settings.ageDays * DAY) {
        const shownAge = Math.max(ageMs, 60 * 1000);
        add('age', `account is ${formatDuration(shownAge)} old (minimum ${settings.ageDays} day${settings.ageDays === 1 ? '' : 's'})`, { ageMs: shownAge, days: settings.ageDays });
    }
    const action = hits.reduce((best, hit) => (STRENGTH[hit.action] > STRENGTH[best] ? hit.action : best), 'off');
    return { action, hits };
}

/** The DM a kicked member gets (in `lang`: the server's language). */
export function kickNotice(guildName, hits, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const kicked = hits.filter((hit) => hit.action === 'kick');
    const ways = [...new Set(kicked.map((hit) => joinGateCheckText(hit.check, { lang }).comeBack))];
    return [
        tr.t('automod.joinGate.dm.removed', { server: guildName, reasons: kicked.map((hit) => hitReason(hit, { lang })).join('; ') }),
        tr.t('automod.joinGate.dm.notBan'),
        tr.t('automod.joinGate.dm.welcomeBack', { ways: ways.join(tr.t('automod.joinGate.dm.waysJoin')) }),
    ].join('\n');
}

const flagKey = (guildId, userId) => `automod:joingate:flag:${guildId}:${userId}`;

export async function getGateFlag(guildId, userId) {
    return getFromDb(flagKey(guildId, userId), null);
}

export async function clearGateFlag(guildId, userId) {
    await deleteFromDb(flagKey(guildId, userId));
}

// Outcome words of a flag line (the third " · " part; closeGateLine replaces it).
const OUTCOME_TEXT = {
    kicked: (tr) => tr.t('automod.joinGate.outcome.kicked'),
    flagged: (tr) => tr.t('automod.joinGate.outcome.flagged'),
    kickFailed: (tr) => tr.t('automod.joinGate.outcome.kickFailed'),
};

function gateLine(member, hits, outcome, lang = 'en') {
    const tr = botText(lang);
    return `${tr.t('automod.joinGate.lineTitle')} · <@${member.id}> ${member.user.username} (\`${member.id}\`) · ${outcome} · ${hits.map((hit) => hitReason(hit, { lang })).join('; ')}`;
}

/**
 * Kick / Dismiss for a flag line: joingate:<decision>:<userId>:<guildId>. The guild id is the
 * joiner's server, which can differ from the server the line is posted in (a support joiner's line
 * is in the main server's review channel); the button acts there (reviewCards.actingGuild).
 */
export function gateButtons(userId, guildId, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const suffix = guildId ? `:${guildId}` : '';
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`joingate:kick:${userId}${suffix}`).setLabel(tr.t('automod.joinGate.button.kick')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`joingate:dismiss:${userId}${suffix}`).setLabel(tr.t('automod.joinGate.button.dismiss')).setStyle(ButtonStyle.Secondary),
    );
}

/** The flag line's embed parts in a language (exported for tests). outcome: kicked | flagged | kickFailed. */
export function gateLinePayload(member, hits, outcome, { lang = 'en', withButtons = false } = {}) {
    const tr = botText(lang);
    const text = gateLine(member, hits, OUTCOME_TEXT[outcome](tr), lang).slice(0, 4096);
    return { description: text, components: withButtons ? [gateButtons(member.id, member.guild.id, { lang })] : [] };
}

async function postGateLine(member, hits, outcome, color, withButtons) {
    const channel = await reviewChannel(member.client, member.guild.id);
    if (!channel) {
        logger.warn(`Join gate ${outcome} ${member.id}, but there is no review channel`);
        return null;
    }
    // A staff-channel post: the language of the server the review channel is in.
    const { lang } = textForGuild(channel.guildId ?? channel.guild?.id ?? member.guild.id, { member, purpose: 'public' });
    const { description, components } = gateLinePayload(member, hits, outcome, { lang, withButtons });
    return channel.send({
        embeds: [createEmbed({ description, color })],
        components,
        allowedMentions: { parse: [] },
    }).catch((error) => {
        logger.warn(`Join gate line failed: ${error.message}`);
        return null;
    });
}

/** Kicks a member with the join-gate DM. Resolves true when kicked. */
export async function kickWithNotice(member, hits, reason) {
    const { lang } = textForGuild(member.guild.id, { member, purpose: 'dm' });
    await member.send({ content: kickNotice(member.guild.name, hits, { lang }), allowedMentions: { parse: [] } }).catch(() => {});
    return member.kick(reason.slice(0, 512)).then(() => true).catch((error) => {
        logger.warn(`Join gate could not kick ${member.id}: ${error.message}`);
        return false;
    });
}

/** The checks a member failed, as labels only (no names or other member text): for the raid timeline. */
export function gateCheckLabels(hits) {
    return [...new Set(hits.map((hit) => JOIN_GATE_CHECKS[hit.check]?.label).filter(Boolean))].join('; ');
}

/** The servers whose "Verify with Discord" counts for the join gate of `guildId`. */
export function verificationScope(guildId) {
    const homeIds = [enforcementConfig.mainGuildId, enforcementConfig.supportGuildId].filter(Boolean);
    return homeIds.includes(guildId) ? homeIds : [guildId];
}

/**
 * Runs the join gate for a new member of any server where automod is on. Never throws.
 * Returns 'kicked' | 'flagged' | null. onKick / onFlag(userId, hits) run after the kick or flag.
 */
export async function checkJoinGate(member, { onKick = null, onFlag = null } = {}) {
    try {
        const { guild, user } = member;
        if (!guild?.id || user.bot) return null;
        const settings = await getAutomodSettings(guild.id);
        if (!settings.enabled) return null;
        // Immune members (a listed user id; roles only if the member already has them): never kicked or flagged.
        if (isImmuneMember(member, settings)) return null;
        const { action, hits } = evaluateJoinGate(user, settings.joinGate);
        if (action === 'off') return null;
        // Verified with "Verify with Discord" before: already passed the verification guard. Only a
        // verification in this server counts (Mewvo's two home servers count as one); one in another
        // server never lets a member past this server's gate (multi-server B1). Since owner decision
        // D3 a verification in a server that is not Mewvo's keeps no token and no row, so only
        // verifications there from before that change still skip this gate.
        if (await hasVerifiedIn(user.id, verificationScope(guild.id)).catch(() => false)) return null;

        if (action === 'kick') {
            const kicked = await kickWithNotice(member, hits, `Join gate: ${hits.filter((h) => h.action === 'kick').map((h) => h.reason).join('; ')}`);
            if (kicked) {
                await postGateLine(member, hits, 'kicked', STATUS_COLORS.kept, false);
                await onKick?.(member.id, hits);
                return 'kicked';
            }
            // Could not kick (role hierarchy, permissions): fall back to a flag for staff.
        }
        const message = await postGateLine(member, hits, action === 'kick' ? 'kickFailed' : 'flagged', STATUS_COLORS.waiting, true);
        if (message) {
            await setInDb(flagKey(guild.id, user.id), {
                channelId: message.channelId, messageId: message.id, hits: hits.map(({ check, reason, detail }) => ({ check, reason, detail })), at: Date.now(),
            }, FLAG_TTL_SECONDS).catch((error) => logger.warn(`Could not store join gate flag for ${user.id}: ${error.message}`));
        }
        await onFlag?.(member.id, hits);
        return 'flagged';
    } catch (error) {
        logger.warn(`Join gate failed for ${member?.id}: ${error.message}`);
        return null;
    }
}

/**
 * A flag line with its outcome (the third " · " part) replaced. Works for a line in any language:
 * the title and outcome never contain " · ", and a username cannot. Pure, for tests.
 */
export function closedGateText(text, outcome, { lang = 'en' } = {}) {
    if (!text) return botText(lang).t('automod.joinGate.lineTitle');
    const parts = text.split(' · ');
    if (parts.length < 3) return `${text} · ${outcome}`;
    return [...parts.slice(0, 2), outcome, ...parts.slice(3)].join(' · ').slice(0, 4096);
}

/**
 * Closes a flag line: no buttons, grey or green, with who closed it and how. `outcome` is already
 * in the line's language (the callers build it); `kicked` picks the colour.
 */
export async function closeGateLine(message, outcome, { kicked = outcome.startsWith('kicked'), lang = 'en' } = {}) {
    const embed = message.embeds?.[0];
    const closed = closedGateText(embed?.description, outcome, { lang });
    await message.edit({
        embeds: [createEmbed({ description: closed, color: kicked ? STATUS_COLORS.kept : STATUS_COLORS.undone })],
        components: [],
    }).catch((error) => logger.warn(`Could not close join gate line ${message.id}: ${error.message}`));
}

/** Gate settings as text for /automod joingate and /automod status. */
export function describeJoinGate(gate, { lang = 'en' } = {}) {
    const settings = normalizeJoinGate(gate);
    const tr = botText(lang);
    return Object.keys(JOIN_GATE_CHECKS).map((check) => {
        const { label } = joinGateCheckText(check, { lang });
        const extra = check === 'age' ? tr.tp('automod.joinGate.youngerThan', settings.ageDays) : '';
        return `${label}${extra}: **${joinGateActionText(settings[check], { lang })}**`;
    }).join(' · ');
}
