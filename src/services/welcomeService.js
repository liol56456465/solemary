// welcomeService.js — atomic reads/writes of the welcome config store (welcome,
// goodbye, auto-roles, join/leave logs). Used by the /welcome, /goodbye, /autorole
// and /greet commands and the web dashboard. Every write goes through
// client.db.update, which locks the row for the whole read-modify-write.

import { z } from 'zod';
import { getWelcomeConfig, normalizeWelcomeConfig } from '../utils/database.js';
import { unwrapReplitData } from '../utils/database/guildConfigStorage.js';
import { getWelcomeConfigKey } from '../utils/database/keys.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { nullableSnowflake, parseSettingsPatch, snowflake, stripUndefined, validationError } from '../utils/settingsValidation.js';

/** /autorole allows a single auto-role; adding another replaces it. */
export const MAX_AUTO_ROLES = 1;
/** Upper bound for the auto-role delay (seconds). */
export const MAX_AUTO_ROLE_DELAY_SECONDS = 3600;

const LABELS = {
    enabled: 'Welcome enabled',
    channelId: 'Welcome channel',
    welcomeMessage: 'Welcome message',
    welcomeEmbed: 'Welcome embed',
    welcomePing: 'Welcome ping',
    welcomeImage: 'Welcome image',
    welcomeImageRef: 'Welcome image',
    goodbyeEnabled: 'Goodbye enabled',
    goodbyeChannelId: 'Goodbye channel',
    leaveMessage: 'Goodbye message',
    leaveEmbed: 'Goodbye embed',
    goodbyeImageRef: 'Goodbye image',
    dmMessage: 'Welcome DM message',
    goodbyePing: 'Goodbye ping',
    roleIds: 'Auto-roles',
    autoRoleDelay: 'Auto-role delay',
    joinLogs: 'Join logs',
    leaveLogs: 'Leave logs',
    'joinLogs.enabled': 'Join logs enabled',
    'joinLogs.channelId': 'Join logs channel',
    'leaveLogs.enabled': 'Leave logs enabled',
    'leaveLogs.channelId': 'Leave logs channel',
};

const bool = (label) => z.boolean({ error: `${label} must be true or false.` });
const message = (label, { allowEmpty = false } = {}) =>
    z.string({ error: `${label} must be text.` })
        .min(allowEmpty ? 0 : 1, `${label} cannot be empty.`)
        .max(2000, `${label} must be at most 2000 characters.`);
// Embeds and stored image references keep whatever shape the bot writes today.
const looseObject = (label) => z.looseObject({}, { error: `${label} must be an object.` });
const logsSchema = (prefix) => z.strictObject({
    enabled: bool(LABELS[`${prefix}.enabled`]).optional(),
    channelId: nullableSnowflake(LABELS[`${prefix}.channelId`]).optional(),
});

const WelcomeSettingsPatchSchema = z.strictObject({
    enabled: bool(LABELS.enabled).optional(),
    channelId: nullableSnowflake(LABELS.channelId).optional(),
    welcomeMessage: message(LABELS.welcomeMessage).optional(),
    welcomeEmbed: looseObject(LABELS.welcomeEmbed).optional(),
    welcomePing: bool(LABELS.welcomePing).optional(),
    welcomeImage: z.string({ error: `${LABELS.welcomeImage} must be a URL.` }).max(2048, `${LABELS.welcomeImage} URL is too long.`).nullable().optional(),
    welcomeImageRef: looseObject(LABELS.welcomeImageRef).nullable().optional(),
    goodbyeEnabled: bool(LABELS.goodbyeEnabled).optional(),
    goodbyeChannelId: nullableSnowflake(LABELS.goodbyeChannelId).optional(),
    leaveMessage: message(LABELS.leaveMessage).optional(),
    leaveEmbed: looseObject(LABELS.leaveEmbed).optional(),
    goodbyeImageRef: looseObject(LABELS.goodbyeImageRef).nullable().optional(),
    dmMessage: message(LABELS.dmMessage, { allowEmpty: true }).optional(),
    goodbyePing: bool(LABELS.goodbyePing).optional(),
    roleIds: z.array(snowflake('Auto-role'), { error: `${LABELS.roleIds} must be a list of role IDs.` })
        .max(25, `${LABELS.roleIds} can hold at most 25 roles.`)
        .optional(),
    autoRoleDelay: z.number({ error: `${LABELS.autoRoleDelay} must be a number.` })
        .int(`${LABELS.autoRoleDelay} must be a whole number of seconds.`)
        .min(0, `${LABELS.autoRoleDelay} cannot be negative.`)
        .max(MAX_AUTO_ROLE_DELAY_SECONDS, `${LABELS.autoRoleDelay} must be at most ${MAX_AUTO_ROLE_DELAY_SECONDS} seconds.`)
        .optional(),
    joinLogs: logsSchema('joinLogs').optional(),
    leaveLogs: logsSchema('leaveLogs').optional(),
});

/** Validates a welcome settings patch without writing it; returns the parsed patch. */
export function validateWelcomeSettingsPatch(patch, guildId) {
    return stripUndefined(parseSettingsPatch(WelcomeSettingsPatchSchema, patch, {
        service: 'welcomeService',
        labels: LABELS,
        guildId,
    }));
}

export async function getWelcomeSettings(client, guildId) {
    return getWelcomeConfig(client, guildId);
}

function requireDb(client, operation) {
    if (!client?.db || typeof client.db.update !== 'function') {
        throw createError(
            `Database not available for ${operation}`,
            ErrorTypes.DATABASE,
            'The database is not responding right now, so nothing was changed. Please try again in a moment.',
        );
    }
}

/**
 * Locked read-modify-write of the welcome config: change(current) returns
 * { next, changed }. `current`/`next` are normalized welcome configs.
 */
async function mutateWelcomeConfig(client, guildId, operation, change) {
    requireDb(client, operation);
    let before;
    let changed = true;
    const saved = await client.db.update(getWelcomeConfigKey(guildId), async (raw) => {
        const current = normalize(unwrapReplitData(raw));
        before = structuredClone(current);
        const result = await change(structuredClone(current));
        changed = result.changed;
        return result.next;
    }, {});
    return { before, after: normalize(saved), changed };
}

// Same normalization getWelcomeConfig applies.
function normalize(raw) {
    return normalizeWelcomeConfig(raw && typeof raw === 'object' ? raw : {});
}

/**
 * Validates `patch` and merges it into the welcome config under the row lock
 * (joinLogs/leaveLogs patches are merged into the stored objects).
 * Returns { before, after }. Throws TitanBotError(VALIDATION) on bad input.
 */
export async function updateWelcomeSettings(client, guildId, patch) {
    const parsed = validateWelcomeSettingsPatch(patch, guildId);
    const { before, after } = await mutateWelcomeConfig(client, guildId, 'updateWelcomeSettings', (current) => {
        const next = { ...current, ...parsed };
        for (const key of ['joinLogs', 'leaveLogs']) {
            if (parsed[key]) next[key] = { ...(current[key] || {}), ...stripUndefined(parsed[key]) };
        }
        return { next, changed: true };
    });
    return { before, after };
}

function assertRoleId(roleId, guildId) {
    if (typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId)) {
        throw validationError(`Invalid auto-role id: ${roleId}`, 'Auto-role must be a Discord role ID.', { guildId });
    }
}

/**
 * Adds `roleId` to the auto-roles under the row lock. With MAX_AUTO_ROLES = 1 the
 * new role replaces the current one (as /autorole add does). Returns
 * { before, after, changed } — changed is false when the role was already set.
 */
export async function addAutoRole(client, guildId, roleId) {
    assertRoleId(roleId, guildId);
    return mutateWelcomeConfig(client, guildId, 'addAutoRole', (current) => {
        const roleIds = Array.isArray(current.roleIds) ? current.roleIds : [];
        if (roleIds.includes(roleId) && roleIds.length <= MAX_AUTO_ROLES) return { next: current, changed: false };
        const nextRoles = [...roleIds.filter((id) => id !== roleId), roleId].slice(-MAX_AUTO_ROLES);
        return { next: { ...current, roleIds: nextRoles }, changed: true };
    });
}

/**
 * Removes `roleId` from the auto-roles under the row lock. Returns
 * { before, after, changed } — changed is false when the role was not set.
 */
export async function removeAutoRole(client, guildId, roleId) {
    // Any stored string may be removed, so stale or malformed entries can be cleaned up.
    if (typeof roleId !== 'string' || roleId.length === 0) {
        throw validationError(`Invalid auto-role id: ${roleId}`, 'Auto-role must be a Discord role ID.', { guildId });
    }
    return mutateWelcomeConfig(client, guildId, 'removeAutoRole', (current) => {
        const roleIds = Array.isArray(current.roleIds) ? current.roleIds : [];
        if (!roleIds.includes(roleId)) return { next: current, changed: false };
        return { next: { ...current, roleIds: roleIds.filter((id) => id !== roleId) }, changed: true };
    });
}
