// botStateService.js — bot-wide state set from the dashboard Owner area that must survive a
// restart: the presence (status + activity) and the maintenance switch. Both live in the
// key-value store (getFromDb / setInDb) and are applied on ready (events/ready.js).
//
// Maintenance uses the existing mechanism: botConfig.commands.maintenanceMode, read by
// isMaintenanceMode() in interactionCreate / messageCreate (OWNER_IDS are let through). The
// stored value, once set from the dashboard, wins over MAINTENANCE_MODE from the env.

import { ActivityType } from 'discord.js';
import { botConfig } from '../../config/bot.js';
import { getFromDb, setInDb } from '../../utils/database.js';

export const PRESENCE_KEY = 'bot:owner:presence';
export const MAINTENANCE_KEY = 'bot:owner:maintenance';
export const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
/** Activity types the dashboard offers (Streaming needs a Twitch URL, so it is left out). */
export const ACTIVITY_TYPES = {
    none: null,
    playing: ActivityType.Playing,
    listening: ActivityType.Listening,
    watching: ActivityType.Watching,
    competing: ActivityType.Competing,
    custom: ActivityType.Custom,
};
export const ACTIVITY_TEXT_MAX = 128;

/** A presence from the form: { status, activityType, activityText } or a message (string). Pure. */
export function parsePresence({ status, activityType, activityText } = {}) {
    const s = String(status || '');
    if (!STATUSES.includes(s)) return 'Choose a status: online, idle, do not disturb or invisible.';
    const type = String(activityType || 'none');
    if (!Object.hasOwn(ACTIVITY_TYPES, type)) return 'Choose an activity type.';
    const textValue = String(activityText || '').trim();
    if (textValue.length > ACTIVITY_TEXT_MAX) return `The activity text is longer than ${ACTIVITY_TEXT_MAX} characters.`;
    if (type !== 'none' && !textValue) return 'Enter the activity text (or choose no activity).';
    return { status: s, activityType: type, activityText: type === 'none' ? '' : textValue };
}

/** The discord.js presence data for a stored presence. Pure. */
export function presenceData(presence) {
    const type = ACTIVITY_TYPES[presence?.activityType] ?? null;
    if (type === null) return { status: presence.status, activities: [] };
    // A custom status shows `state`; the name is required but not shown.
    const activity = type === ActivityType.Custom
        ? { name: 'Custom Status', state: presence.activityText, type }
        : { name: presence.activityText, type };
    return { status: presence.status, activities: [activity] };
}

export async function getStoredPresence() {
    return getFromDb(PRESENCE_KEY, null);
}

/** Stores and applies a parsed presence. */
export async function savePresence(client, presence) {
    await setInDb(PRESENCE_KEY, presence);
    client.user?.setPresence?.(presenceData(presence));
    return presence;
}

export function isMaintenanceOn() {
    return botConfig.commands?.maintenanceMode === true;
}

/** Turns maintenance on or off now and stores it (written first: a failed write changes nothing). */
export async function setMaintenance(enabled) {
    await setInDb(MAINTENANCE_KEY, { enabled: Boolean(enabled), at: new Date().toISOString() });
    botConfig.commands.maintenanceMode = Boolean(enabled);
    return Boolean(enabled);
}

/**
 * On ready: the stored maintenance switch, and the stored presence (not in test mode,
 * which shows its own "Maintenance" presence). Returns a line for the startup log.
 */
export async function applyStoredBotState(client, { testModeEnabled = false } = {}) {
    const parts = [];
    const maintenance = await getFromDb(MAINTENANCE_KEY, null);
    if (maintenance && typeof maintenance.enabled === 'boolean') {
        botConfig.commands.maintenanceMode = maintenance.enabled;
        parts.push(`maintenance ${maintenance.enabled ? 'ON' : 'off'} (dashboard)`);
    } else {
        parts.push(`maintenance ${isMaintenanceOn() ? 'ON' : 'off'} (env)`);
    }
    const presence = await getStoredPresence();
    const parsed = presence ? parsePresence(presence) : null;
    if (parsed && typeof parsed === 'object' && !testModeEnabled) {
        client.user?.setPresence?.(presenceData(parsed));
        parts.push(`presence ${parsed.status}${parsed.activityType !== 'none' ? ` / ${parsed.activityType}` : ''} (dashboard)`);
    } else {
        parts.push(testModeEnabled ? 'presence from test mode' : 'presence from config');
    }
    return parts.join(', ');
}
