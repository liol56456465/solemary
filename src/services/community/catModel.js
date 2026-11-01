// catModel.js — the pure part of the Mewvo server cat: stages, moods, progress, the name
// rules and the "should we announce?" decision. No database, no Discord, so the settings
// registry, the artwork script and the tests can import it. The I/O lives in catService.js.

/** Growth by the server's counted messages (guild_daily_stats). `min`: messages to reach it. */
export const CAT_STAGES = Object.freeze([
    Object.freeze({ key: 'kitten', name: 'Kitten', min: 0 }),
    Object.freeze({ key: 'young', name: 'Young cat', min: 2_000 }),
    Object.freeze({ key: 'cat', name: 'Cat', min: 15_000 }),
    Object.freeze({ key: 'big', name: 'Big cat', min: 75_000 }),
    Object.freeze({ key: 'legend', name: 'Legend', min: 300_000 }),
]);

/** In priority order (the first that applies wins). */
export const CAT_MOODS = Object.freeze(['scared', 'proud', 'happy', 'sleepy']);

export const CAT_NAME_MAX = 32;
export const CAT_DEFAULT_NAME = 'Mewvo';
export const PROUD_MS = 24 * 60 * 60 * 1000;

/** 0..4: the highest stage whose threshold the total reaches. */
export function stageIndexFor(total) {
    const n = Math.max(0, Number(total) || 0);
    let index = 0;
    CAT_STAGES.forEach((stage, i) => { if (n >= stage.min) index = i; });
    return index;
}

/**
 * Progress from the stage `index` towards the next one: { fraction 0..1, toNext, next }.
 * The last stage is always complete (fraction 1, next null).
 */
export function stageProgress(total, index = stageIndexFor(total)) {
    const next = CAT_STAGES[index + 1] || null;
    if (!next) return { fraction: 1, toNext: 0, next: null };
    const from = CAT_STAGES[index].min;
    const n = Math.max(0, Number(total) || 0);
    const fraction = Math.max(0, Math.min(1, (n - from) / (next.min - from)));
    return { fraction, toNext: Math.max(0, next.min - n), next };
}

/**
 * The cat's mood. scared: a raid lockdown is on; proud: it grew into its current stage in the
 * last 24 hours; happy: the last 7 days had messages and at least as many as the 7 before;
 * sleepy: otherwise (also with no data).
 */
export function catMood({ lockdown = false, grownAt = null, grownStage = null, stageIndex = 0, lastWeek = 0, previousWeek = 0, now = Date.now() } = {}) {
    if (lockdown) return 'scared';
    const grown = grownAt ? Date.parse(grownAt) : NaN;
    if (Number.isFinite(grown) && grownStage === stageIndex && now - grown >= 0 && now - grown < PROUD_MS) return 'proud';
    if (lastWeek > 0 && lastWeek >= previousWeek) return 'happy';
    return 'sleepy';
}

/** One plain sentence for the mood. */
export function moodSentence(name, mood) {
    switch (mood) {
        case 'scared': return `${name} is scared: the server is in raid lockdown.`;
        case 'proud': return `${name} is proud: it grew a stage today.`;
        case 'happy': return `${name} is happy: the server was busier this week.`;
        default: return `${name} is sleepy: the server was quieter this week.`;
    }
}

/**
 * A cat name as plain text: letters, numbers, spaces and ' - . ! ? only (no mentions, no
 * markdown, no links, no invisible characters), single spaces, at most 32 characters.
 * Returns null when nothing is left.
 */
export function sanitizeCatName(input) {
    const text = String(input ?? '')
        .normalize('NFKC')
        .replace(/\p{C}/gu, '')
        .replace(/[^\p{L}\p{M}\p{N} '\-.!?]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return null;
    const cut = [...text].slice(0, CAT_NAME_MAX).join('').trim();
    return cut || null;
}

/** True when the value is already a clean name (what the settings registry accepts). */
export function isCleanCatName(value) {
    return typeof value === 'string' && sanitizeCatName(value) === value;
}

/**
 * What the growth check does for one server. `state` is the stored { stage, grownAt } (null
 * the first time), `stageIndex` the stage now.
 *   'init'      first look: record the stage, never announce (no burst for old servers)
 *   'grew'      a stage higher than recorded: announce (if on and a channel is set), then record
 *   'none'      nothing to do (same stage; or lower, because old daily counts were pruned:
 *               the cat never shrinks)
 */
export function growthAction(state, stageIndex) {
    if (!state || !Number.isInteger(state.stage)) return 'init';
    return stageIndex > state.stage ? 'grew' : 'none';
}

/** The stage shown: the counted one, but never below what was already reached. */
export function shownStage(countedIndex, state) {
    const recorded = Number.isInteger(state?.stage) ? Math.min(state.stage, CAT_STAGES.length - 1) : 0;
    return Math.max(countedIndex, recorded);
}

/** The image file of a stage + mood (static/img/cat/<file>, served at /img/cat/<file>). */
export function catImageFile(stageIndex, mood) {
    const stage = CAT_STAGES[stageIndex] || CAT_STAGES[0];
    return `${stage.key}-${CAT_MOODS.includes(mood) ? mood : 'sleepy'}.png`;
}

/** "▰▰▰▱▱▱▱▱▱▱ 30%" for a fraction (same look as /profile). */
export function catProgressLine(fraction, length = 10) {
    const pct = Math.max(0, Math.min(100, Math.floor((Number(fraction) || 0) * 100)));
    const filled = Math.round((pct / 100) * length);
    return `${'▰'.repeat(filled)}${'▱'.repeat(length - filled)} ${pct}%`;
}
