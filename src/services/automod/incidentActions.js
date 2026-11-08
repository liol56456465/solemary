// incidentActions.js — Discord's guild incident actions ("pause invites" and "pause
// DMs") for raid panic mode. PUT /guilds/{id}/incident-actions with
// invites_disabled_until / dms_disabled_until (at most 24 hours ahead), via
// discord.js guild.setIncidentActions. Needs Manage Server; without it the lockdown
// still runs and the alert says the pause could not be applied.

import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { botText } from '../../utils/botText.js';

const HOUR = 60 * 60 * 1000;
export const MAX_PANIC_HOURS = 24;
export const DEFAULT_PANIC_HOURS = 2;

/** A whole number of hours between 1 and 24 (default 2). */
export function clampPanicHours(hours) {
    const n = Math.round(Number(hours));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_PANIC_HOURS;
    return Math.min(n, MAX_PANIC_HOURS);
}

/** ISO time `hours` from `now`, never more than 24 h ahead. */
export function panicUntil(hours, now = Date.now()) {
    return new Date(now + clampPanicHours(hours) * HOUR).toISOString();
}

/**
 * Pauses invites and DMs until `hours` from now.
 * Returns { applied: true, until } or { applied: false, reason }.
 */
export async function pauseInvitesAndDms(guild, hours) {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return { applied: false, reason: 'missing Manage Server' };
    }
    const until = panicUntil(hours);
    try {
        await guild.setIncidentActions({ invitesDisabledUntil: until, dmsDisabledUntil: until });
        return { applied: true, until };
    } catch (error) {
        logger.warn(`Could not pause invites and DMs in ${guild.id}: ${error.message}`);
        return { applied: false, reason: error.message };
    }
}

/** Lifts both pauses. Resolves true when Discord accepted it. */
export async function resumeInvitesAndDms(guild) {
    try {
        await guild.setIncidentActions({ invitesDisabledUntil: null, dmsDisabledUntil: null });
        return true;
    } catch (error) {
        logger.warn(`Could not resume invites and DMs in ${guild.id}: ${error.message}`);
        return false;
    }
}

/** The alert line for a lockdown's incident actions. `result` is the stored state (or null when panic mode is off). */
export function describePanic(result, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!result) return tr.t('automod.raid.panic.off');
    if (result.applied) return tr.t('automod.raid.panic.paused', { time: `<t:${Math.floor(new Date(result.until).getTime() / 1000)}:t>` });
    if (result.reason === 'missing Manage Server') return tr.t('automod.raid.panic.noManageServer');
    // Discord's own error text stays as Discord sent it.
    return tr.t('automod.raid.panic.failed', { reason: String(result.reason || tr.t('automod.raid.panic.refused')).slice(0, 200) });
}
