// voiceText.js — voice time as text for /rank, /profile and /leaderboard type:voice. Pure.

import { botText } from '../../utils/botText.js';

/** "3 h 5 min" / "45 min" (whole minutes, rounded down) in a bot language. */
export function voiceTimeText(seconds, lang = 'en') {
    const tr = botText(lang);
    const total = Math.max(0, Math.floor((Number(seconds) || 0) / 60));
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return hours > 0
        ? tr.t('leveling.voiceTime.hours', { hours, minutes })
        : tr.t('leveling.voiceTime.minutes', { minutes });
}

/**
 * The "Voice time" value for /rank and /profile, or null when there is nothing to show: Voice XP
 * is off in the server and the member has no stored voice time. stats: readVoiceStats's result.
 */
export function voiceTimeValue(stats, voiceEnabled, lang = 'en') {
    const seconds = Number(stats?.seconds) || 0;
    if (!voiceEnabled && seconds <= 0) return null;
    return voiceTimeText(seconds, lang);
}
