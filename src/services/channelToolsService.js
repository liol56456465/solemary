// channelToolsService.js — purge, lock and unlock a channel, for the dashboard's Channel tools
// page. Same behaviour as /purge, /lock and /unlock (src/commands/Moderation/): bulk delete up
// to 100 recent messages (Discord skips messages older than 14 days), lock = deny SendMessages
// for @everyone on the channel, unlock = clear that deny (the channel inherits again).
// Same log events as the commands (utils/moderation.js logEvent → loggingService).
//
// Refusals throw an Error with `type` ('permission' / 'validation') and `userMessage`.
// `log` can be replaced in tests.

import { PermissionFlagsBits } from 'discord.js';
import { logEvent } from '../utils/moderation.js';

export const PURGE_MIN = 1;
export const PURGE_MAX = 100;
/** Discord refuses to bulk-delete messages older than 14 days. */
export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const PERM_LABEL = {
    ViewChannel: 'View Channel', ReadMessageHistory: 'Read Message History', ManageMessages: 'Manage Messages',
    ManageChannels: 'Manage Channels', ManageRoles: 'Manage Permissions',
};

/** Needed for each tool. Editing an overwrite needs Manage Permissions (Manage Roles) in the channel too. */
export const TOOL_PERMS = {
    purge: ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'],
    lock: ['ViewChannel', 'ManageChannels', 'ManageRoles'],
};

function refuse(message, type = 'validation') {
    return Object.assign(new Error(message), { type, userMessage: message });
}

/** The permissions of `perms` the bot lacks in `channel` (labels). */
export function missingBotPerms(guild, channel, perms) {
    const me = guild?.members?.me;
    const granted = me?.permissionsIn ? me.permissionsIn(channel) : null;
    if (!granted?.has) return perms.map((p) => PERM_LABEL[p] || p);
    return perms.filter((p) => !granted.has(PermissionFlagsBits[p])).map((p) => PERM_LABEL[p] || p);
}

function requireBotPerms(guild, channel, perms, doing) {
    const missing = missingBotPerms(guild, channel, perms);
    if (missing.length) {
        throw refuse(`Mewvo is missing ${missing.join(', ')} in #${channel.name}, so it cannot ${doing} there. Nothing was changed.`, 'permission');
    }
}

function everyoneOf(guild) {
    return guild.roles?.everyone || guild.roles?.cache?.get(guild.id) || guild.id;
}

/** True when the channel's own @everyone overwrite denies Send Messages (what /lock sets). */
export function isLockedByOverwrite(guild, channel) {
    const overwrite = channel?.permissionOverwrites?.cache?.get(guild.id);
    return Boolean(overwrite?.deny?.has?.(PermissionFlagsBits.SendMessages));
}

/** Text channels locked with a channel overwrite (the ones Unlock can open again). */
export function lockedChannels(guild, types) {
    return [...(guild?.channels?.cache?.values?.() || [])]
        .filter((c) => types.includes(c.type) && isLockedByOverwrite(guild, c))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function everyoneCanSend(guild, channel) {
    const perms = channel.permissionsFor?.(everyoneOf(guild));
    return perms ? perms.has(PermissionFlagsBits.SendMessages) !== false : true;
}

/**
 * Deletes up to `amount` recent messages in `channel` (only from `fromUserId` when given:
 * the newest 100 messages are searched). Messages older than 14 days are skipped.
 * Returns { deleted, requested, matched, skippedOld }.
 */
export async function purgeChannelMessages({ client, guild, channel, amount, fromUserId = null, moderator, reason = '', log = logEvent, now = Date.now() }) {
    if (!Number.isInteger(amount) || amount < PURGE_MIN || amount > PURGE_MAX) throw refuse(`Please specify a number between ${PURGE_MIN} and ${PURGE_MAX}.`);
    requireBotPerms(guild, channel, TOOL_PERMS.purge, 'delete messages');
    const fetched = await channel.messages.fetch({ limit: fromUserId ? PURGE_MAX : amount });
    let messages = [...fetched.values()];
    if (fromUserId) messages = messages.filter((m) => (m.author?.id || m.authorId) === fromUserId);
    messages = messages.slice(0, amount);
    const fresh = messages.filter((m) => now - (m.createdTimestamp ?? now) < BULK_DELETE_MAX_AGE_MS);
    const skippedOld = messages.length - fresh.length;
    if (!fresh.length) {
        throw refuse(messages.length
            ? 'All matching messages are older than 14 days; Discord does not bulk-delete those. Nothing was deleted.'
            : `No ${fromUserId ? 'messages from that user were found in the last 100 messages' : 'messages were found'} in #${channel.name}. Nothing was deleted.`);
    }
    const deletedSet = await channel.bulkDelete(fresh, true);
    const deleted = deletedSet?.size ?? fresh.length;
    await log({
        client,
        guild,
        event: {
            action: 'Messages Purged',
            target: `${channel} (${deleted} messages)`,
            executor: `${moderator.tag} (${moderator.id})`,
            reason: `Deleted ${deleted} messages${fromUserId ? ` from ${fromUserId}` : ''}${reason ? `: ${reason}` : ''}`,
            metadata: { channelId: channel.id, messageCount: deleted, requestedAmount: amount, moderatorId: moderator.id, ...(fromUserId ? { fromUserId } : {}), via: 'dashboard' },
        },
    });
    return { deleted, requested: amount, matched: messages.length, skippedOld };
}

/** Denies Send Messages for @everyone in `channel` (like /lock). `auditReason` goes to Discord's audit log. */
export async function lockChannel({ client, guild, channel, moderator, auditReason, log = logEvent }) {
    requireBotPerms(guild, channel, TOOL_PERMS.lock, 'lock the channel');
    if (!everyoneCanSend(guild, channel)) throw refuse(`#${channel.name} is already locked.`);
    await channel.permissionOverwrites.edit(everyoneOf(guild), { SendMessages: false }, { type: 0, reason: auditReason });
    await log({
        client,
        guild,
        event: {
            action: 'Channel Locked',
            target: channel.toString(),
            executor: `${moderator.tag} (${moderator.id})`,
            metadata: { channelId: channel.id, category: channel.parent?.name || 'None', moderatorId: moderator.id, via: 'dashboard' },
        },
    });
    return { locked: true };
}

/** Clears the @everyone Send Messages deny (like /unlock): the channel inherits from its category again. */
export async function unlockChannel({ client, guild, channel, moderator, auditReason, log = logEvent }) {
    requireBotPerms(guild, channel, TOOL_PERMS.lock, 'unlock the channel');
    if (!isLockedByOverwrite(guild, channel)) {
        throw refuse(everyoneCanSend(guild, channel)
            ? `#${channel.name} is not locked (everyone can already send messages).`
            : `#${channel.name} is not locked by a channel overwrite: Send Messages is denied by its category or the @everyone role, so unlocking here would change nothing.`);
    }
    await channel.permissionOverwrites.edit(everyoneOf(guild), { SendMessages: null }, { type: 0, reason: auditReason });
    await log({
        client,
        guild,
        event: {
            action: 'Channel Unlocked',
            target: channel.toString(),
            executor: `${moderator.tag} (${moderator.id})`,
            metadata: { channelId: channel.id, category: channel.parent?.name || 'None', moderatorId: moderator.id, via: 'dashboard' },
        },
    });
    return { locked: false };
}
