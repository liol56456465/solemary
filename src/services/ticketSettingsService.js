// ticketSettingsService.js — atomic reads/writes of the ticket settings stored in
// guild config. Used by the /ticket commands and the web dashboard; every write
// runs under the guild-config row lock and only touches the patched keys.

import { z } from 'zod';
import { getGuildConfig } from './config/guildConfig.js';
import { updateGuildConfigAtomic } from '../utils/database/guildConfigStorage.js';
import { nullableSnowflake, parseSettingsPatch, pickKeys, stripUndefined, trimmedText, validationError } from '../utils/settingsValidation.js';

export const TICKET_SETTING_KEYS = [
    'ticketPanelChannelId',
    'ticketPanelMessageId',
    'ticketStaffRoleId',
    'ticketCategoryId',
    'ticketClosedCategoryId',
    'ticketPanelMessage',
    'ticketButtonLabel',
    'maxTicketsPerUser',
    'dmOnClose',
    'ticketLogsChannelId',
    'ticketTranscriptChannelId',
];

const LABELS = {
    ticketPanelChannelId: 'Ticket panel channel',
    ticketPanelMessageId: 'Ticket panel message',
    ticketStaffRoleId: 'Ticket staff role',
    ticketCategoryId: 'Open tickets category',
    ticketClosedCategoryId: 'Closed tickets category',
    ticketPanelMessage: 'Panel message',
    ticketButtonLabel: 'Button label',
    maxTicketsPerUser: 'Max tickets per user',
    dmOnClose: 'DM on close',
    ticketLogsChannelId: 'Ticket logs channel',
    ticketTranscriptChannelId: 'Ticket transcript channel',
};

const TicketSettingsPatchSchema = z.strictObject({
    ticketPanelChannelId: nullableSnowflake(LABELS.ticketPanelChannelId).optional(),
    ticketPanelMessageId: nullableSnowflake(LABELS.ticketPanelMessageId).optional(),
    ticketStaffRoleId: nullableSnowflake(LABELS.ticketStaffRoleId).optional(),
    ticketCategoryId: nullableSnowflake(LABELS.ticketCategoryId).optional(),
    ticketClosedCategoryId: nullableSnowflake(LABELS.ticketClosedCategoryId).optional(),
    ticketPanelMessage: trimmedText(LABELS.ticketPanelMessage, 2000).optional(),
    ticketButtonLabel: trimmedText(LABELS.ticketButtonLabel, 80).optional(),
    maxTicketsPerUser: z
        .number({ error: `${LABELS.maxTicketsPerUser} must be a number.` })
        .int(`${LABELS.maxTicketsPerUser} must be a whole number.`)
        .min(1, `${LABELS.maxTicketsPerUser} must be between 1 and 10.`)
        .max(10, `${LABELS.maxTicketsPerUser} must be between 1 and 10.`)
        .optional(),
    dmOnClose: z.boolean({ error: `${LABELS.dmOnClose} must be true or false.` }).optional(),
    ticketLogsChannelId: nullableSnowflake(LABELS.ticketLogsChannelId).optional(),
    ticketTranscriptChannelId: nullableSnowflake(LABELS.ticketTranscriptChannelId).optional(),
});

/** Validates a ticket settings patch without writing it; returns the parsed patch. */
export function validateTicketSettingsPatch(patch, guildId) {
    return stripUndefined(parseSettingsPatch(TicketSettingsPatchSchema, patch, {
        service: 'ticketSettingsService',
        labels: LABELS,
        guildId,
    }));
}

export async function getTicketSettings(client, guildId) {
    const config = await getGuildConfig(client, guildId);
    return pickKeys(config, TICKET_SETTING_KEYS);
}

/**
 * Validates `patch` and merges only its keys into the stored guild config, under
 * the row lock. Returns { before, after } (ticket settings subset).
 * Throws TitanBotError(VALIDATION) on bad input.
 */
export async function updateTicketSettings(client, guildId, patch) {
    const parsed = validateTicketSettingsPatch(patch, guildId);
    let before;
    const saved = await updateGuildConfigAtomic(client, guildId, (current) => {
        before = pickKeys(current, TICKET_SETTING_KEYS);
        return { ...current, ...parsed };
    }, { operation: 'updateTicketSettings' });
    return { before, after: pickKeys(saved, TICKET_SETTING_KEYS) };
}

/**
 * Atomically removes the given ticket keys (used by "Delete System").
 * Returns { before, after }.
 */
export async function clearTicketSettings(client, guildId, keys = TICKET_SETTING_KEYS) {
    const list = Array.isArray(keys) ? keys : [keys];
    const unknown = list.filter((key) => !TICKET_SETTING_KEYS.includes(key));
    if (unknown.length > 0) {
        throw validationError(
            `clearTicketSettings: unknown keys ${unknown.join(', ')}`,
            `Unknown ticket setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
            { guildId },
        );
    }

    let before;
    const saved = await updateGuildConfigAtomic(client, guildId, (current) => {
        before = pickKeys(current, TICKET_SETTING_KEYS);
        const next = { ...current };
        for (const key of list) delete next[key];
        return next;
    }, { operation: 'clearTicketSettings' });
    return { before, after: pickKeys(saved, TICKET_SETTING_KEYS) };
}
