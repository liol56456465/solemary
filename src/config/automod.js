// automod.js — rules, punishment ladders and thresholds for the automatic moderator.
//
// Every automatic punishment is a normal enforcement case (appealable, logged,
// counted toward the warning roles) with reason_key "automod:<group>", and gets a
// review card in the staff channel where a moderator can keep, reverse or change it.
// Repeats are counted per group over repeatWindowMs: the Nth offence uses step N of
// the ladder (the last step repeats).

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

function readIdList(name) {
    return (process.env[name] || '').split(',').map((id) => id.trim()).filter(Boolean);
}

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

    // Where review cards and reports go; defaults to the mod log channel.
    reviewChannelId: (process.env.AUTOMOD_REVIEW_CHANNEL_ID || '').trim() || null,
    // Channels automod ignores entirely, in addition to the ones set with /automod exempt.
    exemptChannelIds: readIdList('AUTOMOD_EXEMPT_CHANNEL_IDS'),
    // Extra words for the language filter (AUTOMOD_EXTRA_WORDS=word1,word2).
    extraBlockedWords: (process.env.AUTOMOD_EXTRA_WORDS || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean),

    // Staff guard: an admin doing this much within the window loses their staff roles.
    guardWindowMs: 10 * 60 * 1000,
    guardBanKickLimit: 5,
    guardDeleteLimit: 3,
    staffWarnLimit: 3,
    staffWarnExpiryMs: 90 * DAY,
};

export default automodConfig;
