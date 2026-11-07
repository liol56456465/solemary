// format.js — case codes, durations and Discord timestamps for enforcement.

import { randomInt } from 'crypto';

// Lowercase letters and digits without look-alikes: 0, o, 1, l, i.
export const CASE_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CASE_CODE_PATTERN = new RegExp(`^[${CASE_CODE_ALPHABET}]{5,7}$`);

export function generateCaseCode() {
    const length = randomInt(5, 8);
    let code = '';
    for (let i = 0; i < length; i += 1) {
        code += CASE_CODE_ALPHABET[randomInt(CASE_CODE_ALPHABET.length)];
    }
    return code;
}

export function normalizeCaseCode(input) {
    const code = String(input || '').trim().toLowerCase();
    return CASE_CODE_PATTERN.test(code) ? code : null;
}

const MINUTE = 60 * 1000;
const UNIT_MS = {
    m: MINUTE,
    h: 60 * MINUTE,
    d: 24 * 60 * MINUTE,
    w: 7 * 24 * 60 * MINUTE,
    mo: 30 * 24 * 60 * MINUTE,
};
const MAX_DURATION_MS = 100 * 365 * UNIT_MS.d;

/**
 * Parses "30m", "24h", "7d", "2w", "1mo" and combinations such as "1d12h".
 * Returns milliseconds, or null when the input is not a valid duration.
 */
export function parseDuration(input) {
    const text = String(input || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!text || !/^(\d+(mo|m|h|d|w))+$/.test(text)) {
        return null;
    }

    let total = 0;
    for (const [, amount, unit] of text.matchAll(/(\d+)(mo|m|h|d|w)/g)) {
        total += Number(amount) * UNIT_MS[unit];
    }

    if (!Number.isFinite(total) || total < MINUTE || total > MAX_DURATION_MS) {
        return null;
    }
    return total;
}

// The warn-ladder ban for each level, the same as enforcementConfig.ladderBans (a test
// checks they match; format.js does not import the config); null = permanent.
export const LADDER_STAGE_BANS = Object.freeze({ 1: 7 * 24 * 60 * 60 * 1000, 2: 30 * 24 * 60 * 60 * 1000, 3: null });

/**
 * The warn-ladder level in plain words: "warning stage 1 of 3 (7-day ban)".
 * Level 0 is "warning stage 0 of 3 (no warning ban yet)". `bans` maps level → ban length.
 */
export function ladderStage(level, bans = LADDER_STAGE_BANS) {
    return `warning stage ${ladderStageShort(level, bans)}`;
}

/** "1 of 3 (7-day ban)": for a place already labelled "Warning stage". */
export function ladderStageShort(level, bans = LADDER_STAGE_BANS) {
    const n = Math.max(0, Math.min(3, Number(level) || 0));
    if (n === 0) return '0 of 3 (no warning ban yet)';
    const ms = bans[n];
    const ban = ms == null ? 'permanent ban' : `${Math.round(ms / (24 * 60 * 60 * 1000))}-day ban`;
    return `${n} of 3 (${ban})`;
}

/** ladderStage with a capital first letter, for labels and the start of a line. */
export function ladderStageLabel(level, bans) {
    const text = ladderStage(level, bans);
    return text[0].toUpperCase() + text.slice(1);
}

export function formatDuration(ms) {
    if (ms == null) {
        return 'Permanent';
    }

    const parts = [];
    let rest = ms;
    for (const [label, size] of [['month', UNIT_MS.mo], ['day', UNIT_MS.d], ['hour', UNIT_MS.h], ['minute', UNIT_MS.m]]) {
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(`${count} ${label}${count === 1 ? '' : 's'}`);
            rest -= count * size;
        }
    }
    return parts.slice(0, 2).join(' ') || 'less than a minute';
}

export function addMonths(date, months) {
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return result;
}

export function unix(date) {
    return Math.floor(new Date(date).getTime() / 1000);
}

/** "<t:F> (<t:R>)" — the full date plus a live countdown. */
export function stamp(date) {
    const seconds = unix(date);
    return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}

export function dateStamp(date) {
    return `<t:${unix(date)}:F>`;
}

export function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Joins whole lines up to `max` characters (embed description: 4096). Never cuts a line (or a
 * mention) in half; when lines don't fit, the last one is "…and N more".
 */
export function fitWholeLines(lines, max = 4096) {
    const out = [];
    let length = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const more = `…and ${lines.length - i} more`;
        const reserve = i < lines.length - 1 ? more.length + 1 : 0;
        const sep = out.length ? 1 : 0;
        if (length + sep + line.length + reserve > max) {
            out.push(more);
            break;
        }
        out.push(line);
        length += sep + line.length;
    }
    return out.join('\n');
}
