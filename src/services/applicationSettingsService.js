// applicationSettingsService.js — the application system's server settings
// (enabled, log channel, manager roles, default questions, retention), shared by
// /app-admin dashboard and the web dashboard.
//
// updateApplicationSettings validates a patch and writes it under the key's row lock
// (client.db.update), so two editors never overwrite each other's fields.

import { getApplicationSettings, unwrapReplitData } from '../utils/database.js';
import { getApplicationSettingsKey } from '../utils/database/keys.js';
import { normalizeApplicationQuestions, parseApplicationQuestionInput } from '../utils/applicationQuestions.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';

export const MAX_APPLICATION_QUESTIONS = 5;
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;
const SNOWFLAKE = /^\d{17,20}$/;

function invalid(message) {
    return createError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

/** Editor lines ("Why join? [min:10]") → stored questions; 1–5 required. */
export function parseQuestionLines(lines) {
    const questions = (Array.isArray(lines) ? lines : String(lines ?? '').split('\n'))
        .map((line) => parseApplicationQuestionInput(line))
        .filter(Boolean);
    if (questions.length === 0) throw invalid('At least one question is required.');
    if (questions.length > MAX_APPLICATION_QUESTIONS) throw invalid(`At most ${MAX_APPLICATION_QUESTIONS} questions (one per line).`);
    return questions;
}

function retention(value, label) {
    if (!Number.isInteger(value) || value < RETENTION_MIN_DAYS || value > RETENTION_MAX_DAYS) {
        throw invalid(`${label} retention must be a whole number between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} days.`);
    }
    return value;
}

const VALIDATORS = {
    enabled: (v) => {
        if (typeof v !== 'boolean') throw invalid('enabled must be on or off.');
        return v;
    },
    logChannelId: (v) => {
        if (v !== null && !SNOWFLAKE.test(String(v))) throw invalid('The log channel must be a channel ID.');
        return v;
    },
    managerRoles: (v) => {
        if (!Array.isArray(v) || v.some((id) => !SNOWFLAKE.test(String(id)))) throw invalid('Manager roles must be role IDs.');
        if (v.length > 25) throw invalid('At most 25 manager roles.');
        return [...new Set(v)];
    },
    questions: (v) => {
        const normalized = normalizeApplicationQuestions(v);
        if (!normalized.length) throw invalid('At least one question is required.');
        if (normalized.length > MAX_APPLICATION_QUESTIONS) throw invalid(`At most ${MAX_APPLICATION_QUESTIONS} questions.`);
        return v;
    },
    pendingApplicationRetentionDays: (v) => retention(v, 'Pending'),
    reviewedApplicationRetentionDays: (v) => retention(v, 'Reviewed'),
};

/** Validates a patch of known keys; throws a VALIDATION error with a readable message. */
export function validateApplicationSettingsPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('Invalid application settings update.');
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
        if (!VALIDATORS[key]) throw invalid(`Unknown application setting "${key}".`);
        out[key] = VALIDATORS[key](value);
    }
    return out;
}

/**
 * Merges a validated patch into the stored settings under the row lock.
 * Returns { before, after } (complete settings with defaults).
 */
export async function updateApplicationSettings(client, guildId, patch) {
    const clean = validateApplicationSettingsPatch(patch);
    if (!client?.db?.update) {
        throw createError('Database not available', ErrorTypes.DATABASE, 'The database is not responding right now, so nothing was changed.');
    }
    const before = await getApplicationSettings(client, guildId);
    await client.db.update(getApplicationSettingsKey(guildId), (current) => ({
        ...(unwrapReplitData(current) && typeof unwrapReplitData(current) === 'object' ? unwrapReplitData(current) : {}),
        ...clean,
    }), {});
    const after = await getApplicationSettings(client, guildId);
    return { before, after };
}
