// auditLogLogging.js — server log entries built from audit log entries: emoji, sticker,
// scheduled event, webhook, invite and native AutoMod rule changes.
//
// Using GUILD_AUDIT_LOG_ENTRY_CREATE (already received for the staff guard, via the
// GuildModeration intent) instead of the dedicated gateway events means no new
// intents and the log shows who did it. Needs View Audit Log, like the staff guard.

import { AuditLogEvent } from 'discord.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { logger } from '../utils/logger.js';

const ENTRY_TYPES = {
    [AuditLogEvent.EmojiCreate]: [EVENT_TYPES.EMOJI_CREATE, 'Emoji created'],
    [AuditLogEvent.EmojiDelete]: [EVENT_TYPES.EMOJI_DELETE, 'Emoji deleted'],
    [AuditLogEvent.EmojiUpdate]: [EVENT_TYPES.EMOJI_UPDATE, 'Emoji updated'],
    [AuditLogEvent.StickerCreate]: [EVENT_TYPES.STICKER_CREATE, 'Sticker created'],
    [AuditLogEvent.StickerDelete]: [EVENT_TYPES.STICKER_DELETE, 'Sticker deleted'],
    [AuditLogEvent.StickerUpdate]: [EVENT_TYPES.STICKER_UPDATE, 'Sticker updated'],
    [AuditLogEvent.GuildScheduledEventCreate]: [EVENT_TYPES.EVENT_CREATE, 'Scheduled event created'],
    [AuditLogEvent.GuildScheduledEventDelete]: [EVENT_TYPES.EVENT_DELETE, 'Scheduled event deleted'],
    [AuditLogEvent.GuildScheduledEventUpdate]: [EVENT_TYPES.EVENT_UPDATE, 'Scheduled event updated'],
    [AuditLogEvent.WebhookCreate]: [EVENT_TYPES.WEBHOOK_CREATE, 'Webhook created'],
    [AuditLogEvent.WebhookDelete]: [EVENT_TYPES.WEBHOOK_DELETE, 'Webhook deleted'],
    [AuditLogEvent.WebhookUpdate]: [EVENT_TYPES.WEBHOOK_UPDATE, 'Webhook updated'],
    [AuditLogEvent.InviteCreate]: [EVENT_TYPES.INVITE_CREATE, 'Invite created'],
    [AuditLogEvent.InviteDelete]: [EVENT_TYPES.INVITE_DELETE, 'Invite deleted'],
    [AuditLogEvent.AutoModerationRuleCreate]: [EVENT_TYPES.AUTOMOD_RULE_CREATE, 'AutoMod rule created'],
    [AuditLogEvent.AutoModerationRuleDelete]: [EVENT_TYPES.AUTOMOD_RULE_DELETE, 'AutoMod rule deleted'],
    [AuditLogEvent.AutoModerationRuleUpdate]: [EVENT_TYPES.AUTOMOD_RULE_UPDATE, 'AutoMod rule updated'],
};

// Change keys worth showing on an update, with readable names.
const SHOWN_KEYS = {
    name: 'Name', description: 'Description', tags: 'Tags', channel_id: 'Channel', avatar_hash: 'Avatar',
    max_uses: 'Max uses', max_age: 'Expires after', temporary: 'Temporary', code: 'Code',
    scheduled_start_time: 'Start', scheduled_end_time: 'End', location: 'Location', status: 'Status',
    entity_type: 'Type', enabled: 'Enabled', event_type: 'Event type', trigger_metadata: 'Trigger',
    actions: 'Actions', exempt_roles: 'Exempt roles', exempt_channels: 'Exempt channels', roles: 'Roles',
};

function changeOf(entry, key) {
    return entry.changes?.find((change) => change.key === key) || null;
}

function show(value, key) {
    if (value === undefined || value === null || value === '') return '—';
    if (key === 'channel_id') return `<#${value}>`;
    if (key === 'max_age') return Number(value) ? `${Math.round(Number(value) / 3600)} h` : 'never';
    if (key === 'max_uses') return Number(value) ? String(value) : 'no limit';
    if (Array.isArray(value)) return value.length ? `${value.length} item(s)` : 'none';
    if (typeof value === 'object') return '(changed)';
    const text = String(value);
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** A value from the change list (new for creates/updates, old for deletes), or the target's. */
function valueOf(entry, key) {
    const change = changeOf(entry, key);
    if (change) return change.new ?? change.old ?? null;
    return entry.target?.[key] ?? null;
}

/**
 * The log entry for an audit log entry, or null when it isn't one we log. Pure.
 * Returns { eventType, title, lines, userId, channelId }.
 */
export function describeAuditEntry(entry) {
    const mapped = ENTRY_TYPES[entry.action];
    if (!mapped) return null;
    const [eventType, title] = mapped;
    const isUpdate = eventType.endsWith('update');
    const isInvite = entry.action === AuditLogEvent.InviteCreate || entry.action === AuditLogEvent.InviteDelete;

    const name = isInvite
        ? `discord.gg/${valueOf(entry, 'code') || entry.target?.code || '?'}`
        : valueOf(entry, 'name') || entry.target?.name || null;
    const channelId = valueOf(entry, 'channel_id') || entry.target?.channelId || null;
    const targetId = entry.targetId || entry.target?.id || null;

    const lines = [`**${isInvite ? 'Invite' : 'Name'}:** ${name ? show(name) : '—'}${targetId && !isInvite ? ` (\`${targetId}\`)` : ''}`];
    if (entry.executorId) lines.push(`**By:** <@${entry.executorId}> (\`${entry.executorId}\`)`);
    if (channelId) lines.push(`**Channel:** <#${channelId}>`);
    if (isInvite && entry.action === AuditLogEvent.InviteCreate) {
        lines.push(`**Max uses:** ${show(valueOf(entry, 'max_uses'), 'max_uses')} · **Expires after:** ${show(valueOf(entry, 'max_age'), 'max_age')}`);
    }
    if (isUpdate) {
        const changes = (entry.changes || [])
            .filter((change) => SHOWN_KEYS[change.key])
            .slice(0, 6)
            .map((change) => `**${SHOWN_KEYS[change.key]}:** ${show(change.old, change.key)} → ${show(change.new, change.key)}`);
        lines.push(...(changes.length ? changes : ['*No visible changes*']));
    }
    if (entry.reason) lines.push(`**Reason:** ${show(entry.reason)}`);
    return { eventType, title, lines, userId: entry.executorId || null, channelId };
}

/** Logs an audit log entry to the server's log channel, if it is one of ours. Never throws. */
export async function logAuditEntry(entry, guild) {
    try {
        const described = describeAuditEntry(entry);
        if (!described) return;
        await logEvent({
            client: guild.client,
            guildId: guild.id,
            eventType: described.eventType,
            data: {
                title: described.title,
                lines: described.lines,
                quoted: false,
                userId: described.userId,
                channelId: described.channelId,
            },
        });
    } catch (error) {
        logger.debug(`Audit log logging failed: ${error.message}`);
    }
}
