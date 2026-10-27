// automod.js — rules, punishment ladders and thresholds for the automatic moderator.
//
// Every automatic punishment is a normal enforcement case (appealable, logged,
// counted toward the warning roles) with reason_key "automod:<group>", and gets a
// review card in the staff channel where a moderator can keep, reverse or change it.
// Repeats are counted per group over repeatWindowMs: the Nth offence uses step N of
// the ladder (the last step repeats).

import { bindSettingGetters } from '../services/settings/guildSettings.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const warn = { type: 'warn' };
const mute = (durationMs) => ({ type: 'mute', durationMs });
const ban = (durationMs) => ({ type: 'ban', durationMs });
const permBan = { type: 'ban', durationMs: null };

/**
 * severity: when one message breaks several rules, only the most severe is acted on.
 * deleteMessage: remove the offending message before punishing.
 * Every check runs on text folded back to plain letters, so fancy fonts, look-alike
 * letters, zalgo, invisible characters and spelled-out words don't get around them.
 * Rules detected from wording alone (english, disrespect, harassment, sexual) start
 * softer than the owner's AI-based table; a moderator escalates from the review card.
 */
export const AUTOMOD_RULES = {
    scam: { label: 'Scam or phishing link', group: 'scam', severity: 100, deleteMessage: true, steps: [permBan] },
    nsfw: { label: 'NSFW content', group: 'nsfw', severity: 90, deleteMessage: true, steps: [ban(7 * DAY), ban(30 * DAY), permBan] },
    sexual: { label: 'Sexual harassment or references', group: 'sexual', severity: 85, deleteMessage: true, steps: [mute(DAY), ban(7 * DAY), ban(30 * DAY)] },
    harassment: { label: 'Harassment', group: 'harassment', severity: 80, deleteMessage: true, steps: [mute(HOUR), mute(DAY), ban(7 * DAY)] },
    privacy: { label: 'Sharing personal info', group: 'privacy', severity: 75, deleteMessage: true, steps: [mute(HOUR), mute(DAY), ban(7 * DAY)] },
    advertising: { label: 'Unauthorized advertising', group: 'advertising', severity: 70, deleteMessage: true, steps: [warn, mute(DAY), ban(7 * DAY)] },
    impersonation: { label: 'Impersonation or deception', group: 'impersonation', severity: 65, deleteMessage: false, steps: [warn, mute(DAY), ban(7 * DAY)] },
    language: { label: 'Inappropriate language', group: 'language', severity: 60, deleteMessage: true, steps: [warn, mute(HOUR), mute(DAY)] },
    disrespect: { label: 'Disrespect or drama', group: 'disrespect', severity: 50, deleteMessage: true, steps: [warn, mute(HOUR), mute(DAY)] },
    mentions: { label: 'Mass mentions', group: 'spam', severity: 40, deleteMessage: true, steps: [warn, mute(HOUR), mute(DAY)] },
    spam: { label: 'Spam', group: 'spam', severity: 30, deleteMessage: true, steps: [warn, mute(HOUR), mute(DAY)] },
    caps: { label: 'Excessive caps', group: 'spam', severity: 20, deleteMessage: true, steps: [warn, mute(HOUR), mute(DAY)] },
    characters: { label: 'Non-English characters or fancy fonts', group: 'characters', severity: 15, deleteMessage: true, steps: [warn, mute(HOUR), mute(DAY)] },
    english: { label: 'English only', group: 'english', severity: 10, deleteMessage: false, steps: [warn, warn, mute(HOUR)] },
};

/** Punishments a moderator can switch an automod decision to from the review card. */
export const REVIEW_ACTIONS = {
    warn: { label: 'Warn', step: warn },
    mute1h: { label: 'Mute 1 hour', step: mute(HOUR) },
    mute1d: { label: 'Mute 1 day', step: mute(DAY) },
    ban7d: { label: 'Ban 7 days', step: ban(7 * DAY) },
    ban30d: { label: 'Ban 30 days', step: ban(30 * DAY) },
    permban: { label: 'Permanent ban', step: permBan },
};

export const automodConfig = {
    repeatWindowMs: 30 * DAY,

    // Spam: this many messages within the window, or the same text this many times.
    spamMessages: 6,
    spamWindowMs: 5 * 1000,
    duplicateMessages: 3,
    duplicateWindowMs: 30 * 1000,
    // Caps: at least this many letters, and this share of them upper case.
    capsMinLetters: 12,
    capsRatio: 0.75,
    // Mass mentions: distinct users + roles in one message (staff are exempt).
    mentionLimit: 5,
    // English only: judged on messages with at least this many words and letters,
    // when the detector is this sure the text is another language.
    englishMinWords: 5,
    englishMinLetters: 25,
    englishMinConfidence: 0.6,
    // Harassment: targeted insults from one author at one person within the window.
    harassmentRepeats: 3,
    harassmentWindowMs: 10 * 60 * 1000,
    // After acting on someone, further hits of the same group are ignored for a while.
    ruleCooldownMs: 30 * 1000,
    // History kept per user for spam checks.
    historyWindowMs: 60 * 1000,

    // New members: links, attachments and fast posting are limited for their first days.
    newMemberMs: 3 * DAY,
    newMemberSlowmodeMs: 10 * 1000,

    // Ad bots: a new account or new joiner posting invites or the same text across channels.
    adBotAccountAgeMs: 7 * DAY,
    adBotJoinAgeMs: DAY,
    adBotChannelSpread: 3,
    adBotWindowMs: 60 * 1000,

    // Join raids.
    raidJoins: 10,
    raidWindowMs: 60 * 1000,

    // Member reports: this many distinct members reacting with the flag remove the message.
    reportReactions: 3,
    reportEmoji: '🚩',

    // Staff channels, by purpose (see services/automod/channelRouting.js):
    //   review  — things that need a decision: automod cards, member reports, held verifications.
    //   mod log — a one-line record of every enforcement action (MOD_LOG_CHANNEL_ID, config/enforcement.js).
    //   alerts  — raids, staff guard, mass-action guard, auto slowmode, digests and reports, system problems.
    // Review and alerts fall back to the mod log channel when unset, so one channel is enough.
    // reviewChannelId (AUTOMOD_REVIEW_CHANNEL_ID) and alertsChannelId (BOT_ALERTS_CHANNEL_ID)
    // are per-server settings: see the bindSettingGetters call below.

    // Review cards. Low-severity rules (severity at or below lowSeverityMax: mass mentions,
    // spam, caps, characters, English only) post one compact line instead of a full card
    // when the action is a warn; the very low ones (at or below compactMuteSeverityMax:
    // caps, characters, English only) also when it is a mute shorter than compactMaxMuteMs.
    lowSeverityMax: 40,
    compactMuteSeverityMax: 20,
    compactMaxMuteMs: DAY,
    // Trusted members (/automod trusted: a role, or at least a leveling level) are not
    // held to the rules at or below this severity: caps, characters, English only.
    trustedRelaxMaxSeverity: 20,
    // A member's level is read at most this often (only when a relaxable rule was hit).
    trustedLevelCacheMs: 5 * 60 * 1000,
    // Second chance (/automod secondchance): a member's first offence in a rule group
    // within secondChanceWindowMs, on a rule at or below secondChanceMaxSeverity (caps,
    // characters, English only) or in secondChanceRules (Inappropriate language, only
    // when no blocked word / slur was used), gets a short notice instead of a warning.
    // The notice is deleted after secondChanceNoticeMs.
    secondChanceMaxSeverity: 20,
    secondChanceRules: ['language'],
    secondChanceWindowMs: 30 * DAY,
    secondChanceNoticeMs: 15 * 1000,
    // Probation: a member who rejoins within probationRecentBanMs of a ban ending
    // (expired, lifted on appeal, voided) is on probation for probationMs. Automod then
    // uses the next step of the ladder (1st offence → 2nd step, …), and trusted-member
    // relaxing and second chances don't apply. Every card for them says so.
    probationMs: 7 * DAY,
    probationRecentBanMs: 30 * DAY,
    // Second opinion: this share of kept full cards gets a "confirm or undo?" request
    // for a different admin (services/automod/secondOpinion.js).
    secondOpinionRate: 0.05,
    // Mood alerts (/automod mood): per-channel heat from automod hits within
    // moodWindowMs (each message counts its heaviest signal). At moodThreshold heat
    // from at least moodMinMembers different members, the bot posts one calm-down note,
    // turns on its auto slowmode and posts an alert; then waits moodCooldownMs there.
    moodWindowMs: 3 * 60 * 1000,
    moodWeights: { harassment: 3, sexual: 3, disrespect: 2, caps: 1 },
    moodThreshold: 6,
    moodMinMembers: 3,
    moodCooldownMs: 30 * 60 * 1000,
    // Self-tuning (run with the daily digest): a rule whose decisions moderators undid
    // or changed this often, over at least this many actions in the window, gets a
    // "switch to monitor?" suggestion in the alerts channel, at most once per cooldown.
    tuningWindowDays: 14,
    tuningMinActions: 10,
    tuningUndoRate: 0.3,
    tuningCooldownMs: 7 * DAY,
    // Hits of the same rule by the same user within this window update the open card
    // instead of posting another (in memory: a restart starts fresh).
    burstWindowMs: 5 * 60 * 1000,
    // Message text shown on a card, behind a spoiler.
    cardExcerptChars: 300,
    // exemptChannelIds (AUTOMOD_EXEMPT_CHANNEL_IDS: ignored entirely, in addition to
    // /automod exempt) and extraBlockedWords (AUTOMOD_EXTRA_WORDS, for the language filter;
    // compiled once at startup) are per-server settings: see below.

    // Staff guard: an admin doing this much within the window loses their staff roles.
    guardWindowMs: 10 * 60 * 1000,
    guardBanKickLimit: 5,
    guardDeleteLimit: 3,
    staffWarnLimit: 3,
    staffWarnExpiryMs: 90 * DAY,
};

// Per-server settings (guild_settings via services/settings/guildSettings.js): read
// through getters so callers keep using automodConfig.<key>; env vars only seed them.
bindSettingGetters(automodConfig, ['reviewChannelId', 'alertsChannelId', 'exemptChannelIds', 'extraBlockedWords']);

export default automodConfig;
