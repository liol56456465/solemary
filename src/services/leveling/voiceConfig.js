// voiceConfig.js — the Voice XP settings inside the leveling config (pure: no Discord, no DB).
//
//   leveling.voice = {
//     enabled:          false        off until an admin turns it on (also for existing servers)
//     xpMin, xpMax:     3, 7         random XP per counted minute (before boosts), 1..VOICE_XP_MAX
//     dailyCapMinutes:  120          counted minutes per member per server per UTC day that give XP
//                                    (0 = time is still counted, no XP; 1440 = no real cap)
//     minHumans:        2            eligible people needed in the channel (2..VOICE_MIN_HUMANS_MAX)
//     requireUnmuted:   false        on: self-muted members do not count
//     excludedChannels: []           voice/stage channel ids that never count (max VOICE_MAX_EXCLUDED)
//   }

const SNOWFLAKE = /^\d{17,20}$/;

export const VOICE_XP_MAX = 50;
export const VOICE_CAP_MAX = 1440;
/** The lowest allowed minHumans is 2: one person alone in voice never earns (no solo AFK farming). */
export const VOICE_MIN_HUMANS_MIN = 2;
export const VOICE_MIN_HUMANS_MAX = 10;
export const VOICE_MAX_EXCLUDED = 100;

export const VOICE_DEFAULTS = Object.freeze({
    enabled: false,
    xpMin: 3,
    xpMax: 7,
    dailyCapMinutes: 120,
    minHumans: 2,
    requireUnmuted: false,
    excludedChannels: Object.freeze([]),
});

const intIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/**
 * The Voice XP settings with defaults for anything missing or invalid (a stored config from
 * before Voice XP has no `voice` key: everything is the default, so it is off).
 */
export function voiceConfigOf(levelingConfig) {
    const v = levelingConfig && typeof levelingConfig.voice === 'object' && levelingConfig.voice !== null ? levelingConfig.voice : {};
    const xpMin = intIn(v.xpMin, 1, VOICE_XP_MAX) ? v.xpMin : VOICE_DEFAULTS.xpMin;
    const xpMaxRaw = intIn(v.xpMax, 1, VOICE_XP_MAX) ? v.xpMax : VOICE_DEFAULTS.xpMax;
    return {
        enabled: v.enabled === true,
        xpMin,
        xpMax: Math.max(xpMin, xpMaxRaw),
        dailyCapMinutes: intIn(v.dailyCapMinutes, 0, VOICE_CAP_MAX) ? v.dailyCapMinutes : VOICE_DEFAULTS.dailyCapMinutes,
        minHumans: intIn(v.minHumans, VOICE_MIN_HUMANS_MIN, VOICE_MIN_HUMANS_MAX) ? v.minHumans : VOICE_DEFAULTS.minHumans,
        requireUnmuted: v.requireUnmuted === true,
        excludedChannels: Array.isArray(v.excludedChannels)
            ? [...new Set(v.excludedChannels.filter((id) => typeof id === 'string' && SNOWFLAKE.test(id)))].slice(0, VOICE_MAX_EXCLUDED)
            : [],
    };
}

/**
 * Problems with a (possibly partial) voice settings object, as [field, English message] pairs;
 * empty when it is valid. Fields that are absent are not checked.
 */
export function voiceConfigProblems(voice) {
    if (voice === undefined) return [];
    if (!voice || typeof voice !== 'object' || Array.isArray(voice)) return [['voice', 'Voice XP settings are not valid.']];
    const out = [];
    const has = (key) => voice[key] !== undefined;
    for (const key of ['enabled', 'requireUnmuted']) {
        if (has(key) && typeof voice[key] !== 'boolean') out.push([key, `Voice XP: ${key} must be on or off.`]);
    }
    for (const key of ['xpMin', 'xpMax']) {
        if (has(key) && !intIn(voice[key], 1, VOICE_XP_MAX)) out.push([key, `Voice XP per minute must be a whole number from 1 to ${VOICE_XP_MAX}.`]);
    }
    if (has('xpMin') && has('xpMax') && intIn(voice.xpMin, 1, VOICE_XP_MAX) && intIn(voice.xpMax, 1, VOICE_XP_MAX) && voice.xpMin > voice.xpMax) {
        out.push(['xpMin', 'Voice XP: the least XP per minute cannot be more than the most.']);
    }
    if (has('dailyCapMinutes') && !intIn(voice.dailyCapMinutes, 0, VOICE_CAP_MAX)) {
        out.push(['dailyCapMinutes', `Voice XP daily cap must be a whole number of minutes from 0 to ${VOICE_CAP_MAX}.`]);
    }
    if (has('minHumans') && !intIn(voice.minHumans, VOICE_MIN_HUMANS_MIN, VOICE_MIN_HUMANS_MAX)) {
        out.push(['minHumans', `Voice XP: people needed in the channel must be from ${VOICE_MIN_HUMANS_MIN} to ${VOICE_MIN_HUMANS_MAX}.`]);
    }
    if (has('excludedChannels')) {
        const list = voice.excludedChannels;
        if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || !SNOWFLAKE.test(id)) || new Set(list).size !== list.length) {
            out.push(['excludedChannels', 'Voice XP excluded channels are not valid.']);
        } else if (list.length > VOICE_MAX_EXCLUDED) {
            out.push(['excludedChannels', `Voice XP: at most ${VOICE_MAX_EXCLUDED} excluded channels.`]);
        }
    }
    const known = new Set(Object.keys(VOICE_DEFAULTS));
    for (const key of Object.keys(voice)) if (!known.has(key)) out.push([key, `Voice XP: unknown setting ${key}.`]);
    return out;
}
