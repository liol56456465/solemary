// settingsValidation.js — shared zod helpers for the atomic settings services
// (tickets, verification, welcome). Validation failures become a TitanBotError
// of type VALIDATION whose userMessage names the offending field.

import { z } from 'zod';
import { createError, ErrorTypes } from './errorHandler.js';

export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export const snowflake = (label = 'ID') =>
    z.string({ error: `${label} must be a Discord ID.` }).regex(SNOWFLAKE_PATTERN, `${label} must be a Discord ID (17–20 digits).`);

export const nullableSnowflake = (label) => snowflake(label).nullable();

export const trimmedText = (label, max, min = 1) =>
    z.string({ error: `${label} must be text.` })
        .trim()
        .min(min, `${label} cannot be empty.`)
        .max(max, `${label} must be at most ${max} characters.`);

function describeIssue(issue, labels) {
    const path = issue.path.map(String);
    const key = path.join('.');
    // Closest labelled ancestor: 'roleIds.0' → 'roleIds', 'joinLogs.channelId' → itself.
    let label = key || 'value';
    for (let i = path.length; i > 0; i -= 1) {
        const candidate = labels[path.slice(0, i).join('.')];
        if (candidate) { label = candidate; break; }
    }

    if (issue.code === 'unrecognized_keys') {
        const where = key ? ` in ${label}` : '';
        return `Unknown setting${issue.keys.length > 1 ? 's' : ''}${where}: ${issue.keys.join(', ')}.`;
    }
    // Messages built with the helpers above already start with the field label.
    return issue.message.startsWith(label) ? issue.message : `${label}: ${issue.message}`;
}

/**
 * Parses `input` with `schema`; returns the parsed data or throws a VALIDATION
 * TitanBotError naming the first bad field.
 */
export function parseSettingsPatch(schema, input, { service, labels = {}, guildId } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw createError(
            `${service}: patch must be an object`,
            ErrorTypes.VALIDATION,
            'Invalid settings update.',
            { guildId, service },
        );
    }

    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;

    const issues = parsed.error.issues;
    throw createError(
        `${service}: invalid settings patch`,
        ErrorTypes.VALIDATION,
        describeIssue(issues[0], labels),
        {
            guildId,
            service,
            issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message, code: issue.code })),
        },
    );
}

export function validationError(message, userMessage, context = {}) {
    return createError(message, ErrorTypes.VALIDATION, userMessage, context);
}

export function pickKeys(source, keys) {
    const out = {};
    for (const key of keys) {
        out[key] = source?.[key] === undefined ? undefined : structuredClone(source[key]);
    }
    return out;
}

/** Shallow copy without keys whose value is undefined (so a patch never blanks a field by accident). */
export function stripUndefined(obj) {
    return Object.fromEntries(Object.entries(obj || {}).filter(([, value]) => value !== undefined));
}
