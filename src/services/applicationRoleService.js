// applicationRoleService.js — the application roles (what members apply for) and
// their own questions / log channel. Shared by /app-admin setup, /app-admin dashboard
// and the web dashboard.
//
// The role list and each role's settings are written with client.db.update (row
// lock), so two editors never overwrite each other. Questions use the editor format
// of applicationSettingsService (one per line, a trailing "[min:N]" sets the minimum
// answer length, 1–5 questions).

import {
    deleteApplication, getApplicationRoleSettings, getApplicationRoleSettingsKey, getApplicationRoles, getApplications,
    unwrapReplitData,
} from '../utils/database.js';
import { getApplicationRolesKey } from '../utils/database/keys.js';
import { getDefaultApplicationQuestions } from '../config/bot.js';
import { normalizeApplicationQuestions } from '../utils/applicationQuestions.js';
import { MAX_APPLICATION_QUESTIONS, parseQuestionLines, updateApplicationSettings } from './applicationSettingsService.js';
import { getApplicationSettings } from '../utils/database.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';

export const MAX_APPLICATION_ROLES = 25;
export const APPLICATION_NAME_MAX = 50;
const SNOWFLAKE = /^\d{17,20}$/;

function invalid(message) {
    return createError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

function requireDb(client) {
    if (!client?.db?.update) {
        throw createError('Database not available', ErrorTypes.DATABASE, 'The database is not responding right now, so nothing was changed.');
    }
}

function cleanName(name) {
    const value = String(name ?? '').trim();
    if (!value) throw invalid('The application name cannot be empty.');
    if (value.length > APPLICATION_NAME_MAX) throw invalid(`The application name is limited to ${APPLICATION_NAME_MAX} characters.`);
    return value;
}

function cleanQuestions(questions) {
    if (questions === undefined || questions === null) return undefined;
    const parsed = Array.isArray(questions) && questions.every((q) => typeof q === 'object' && q !== null)
        ? questions
        : parseQuestionLines(questions);
    const normalized = normalizeApplicationQuestions(parsed);
    if (!normalized.length) throw invalid('At least one question is required.');
    if (normalized.length > MAX_APPLICATION_QUESTIONS) throw invalid(`At most ${MAX_APPLICATION_QUESTIONS} questions.`);
    return parsed;
}

const listOf = (raw) => {
    const value = unwrapReplitData(raw);
    return Array.isArray(value) ? value : [];
};

/** Roles with their own settings: [{ roleId, name, enabled, questions, logChannelId }]. */
export async function listApplicationRoles(client, guildId) {
    const roles = await getApplicationRoles(client, guildId);
    return Promise.all(roles.map(async (role) => {
        const settings = await getApplicationRoleSettings(client, guildId, role.roleId).catch(() => ({}));
        return {
            roleId: role.roleId,
            name: role.name || role.roleId,
            enabled: role.enabled !== false,
            questions: Array.isArray(settings?.questions) ? settings.questions : null,
            logChannelId: settings?.logChannelId || null,
        };
    }));
}

/**
 * Adds an application role. questions: editor text/lines (default: the bot's default
 * questions). enableSystem turns the application system on when it is off (as
 * /app-admin setup does). Resolves { role, settings, systemEnabled }.
 */
export async function createApplicationRole(client, guildId, { roleId, name, questions = null, enabled = true, enableSystem = false }) {
    requireDb(client);
    if (!SNOWFLAKE.test(String(roleId || ''))) throw invalid('Pick a role for the application.');
    const role = { roleId: String(roleId), name: cleanName(name), enabled: enabled !== false };
    const roleQuestions = cleanQuestions(questions) ?? getDefaultApplicationQuestions();

    await client.db.update(getApplicationRolesKey(guildId), (current) => {
        const roles = listOf(current);
        if (roles.some((r) => r.roleId === role.roleId)) throw invalid('This role is already configured as an application.');
        if (roles.length >= MAX_APPLICATION_ROLES) throw invalid(`At most ${MAX_APPLICATION_ROLES} application roles.`);
        return [...roles, role];
    }, []);
    const settings = { questions: roleQuestions };
    await client.db.update(getApplicationRoleSettingsKey(guildId, role.roleId), () => settings, {});

    let systemEnabled = false;
    if (enableSystem) {
        const current = await getApplicationSettings(client, guildId);
        if (!current.enabled) {
            await updateApplicationSettings(client, guildId, { enabled: true });
            systemEnabled = true;
        }
    }
    logger.info('Application role added', { guildId, roleId: role.roleId });
    return { role, settings, systemEnabled };
}

/**
 * Changes an application role: { name?, enabled?, questions? (editor text, or null to
 * use the default questions), logChannelId? (null = the global log channel) }.
 * Resolves { before, after } (as listApplicationRoles entries).
 */
export async function updateApplicationRole(client, guildId, roleId, changes = {}) {
    requireDb(client);
    const rolePatch = {};
    if (changes.name !== undefined) rolePatch.name = cleanName(changes.name);
    if (changes.enabled !== undefined) {
        if (typeof changes.enabled !== 'boolean') throw invalid('enabled must be on or off.');
        rolePatch.enabled = changes.enabled;
    }
    const settingsPatch = {};
    if (changes.questions !== undefined) settingsPatch.questions = changes.questions === null ? null : cleanQuestions(changes.questions);
    if (changes.logChannelId !== undefined) {
        if (changes.logChannelId !== null && !SNOWFLAKE.test(String(changes.logChannelId))) throw invalid('The log channel must be a channel ID.');
        settingsPatch.logChannelId = changes.logChannelId;
    }

    const before = (await listApplicationRoles(client, guildId)).find((r) => r.roleId === roleId);
    if (!before) throw invalid('That application role no longer exists.');
    if (Object.keys(rolePatch).length) {
        await client.db.update(getApplicationRolesKey(guildId), (current) => {
            const roles = listOf(current);
            const index = roles.findIndex((r) => r.roleId === roleId);
            if (index === -1) throw invalid('That application role no longer exists.');
            roles[index] = { ...roles[index], ...rolePatch };
            return roles;
        }, []);
    }
    if (Object.keys(settingsPatch).length) {
        await client.db.update(getApplicationRoleSettingsKey(guildId, roleId), (current) => {
            const value = unwrapReplitData(current);
            return { ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}), ...settingsPatch };
        }, {});
    }
    const after = (await listApplicationRoles(client, guildId)).find((r) => r.roleId === roleId);
    return { before, after };
}

/**
 * Deletes an application role, its settings and (by default) every application for it.
 * Resolves { role, deletedApplications }.
 */
export async function deleteApplicationRole(client, guildId, roleId, { deleteApplications = true } = {}) {
    requireDb(client);
    let removed = null;
    await client.db.update(getApplicationRolesKey(guildId), (current) => {
        const roles = listOf(current);
        removed = roles.find((r) => r.roleId === roleId) || null;
        if (!removed) throw invalid('That application role no longer exists.');
        return roles.filter((r) => r.roleId !== roleId);
    }, []);
    await client.db.delete(getApplicationRoleSettingsKey(guildId, roleId)).catch(() => {});
    let deletedApplications = 0;
    if (deleteApplications) {
        const applications = (await getApplications(client, guildId).catch(() => [])).filter((app) => app.roleId === roleId);
        for (const app of applications) {
            await deleteApplication(client, guildId, app.id, app.userId);
            deletedApplications += 1;
        }
    }
    logger.info('Application role removed', { guildId, roleId, deletedApplications });
    return { role: removed, deletedApplications };
}
