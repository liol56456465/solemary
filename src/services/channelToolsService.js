// channelToolsService.js — purge, lock and unlock a channel, for the dashboard's Channel tools
// page. Same behaviour as /purge, /lock and /unlock (src/commands/Moderation/): bulk delete up
// to 100 recent messages (Discord skips messages older than 14 days); lock and unlock live in
// services/moderation/channelLock.js (@everyone + roles with their own allow, restored exactly).
// Same log events as the commands (utils/moderation.js logEvent → loggingService).
// Fix permissions (the dashboard's /fix-permissions page): Mewvo gives itself the posting bits a
// feature needs in one channel, only bits its own role has; otherwise the owner gets the Discord steps.
//
// Refusals throw an Error with `type` ('permission' / 'validation') and `userMessage`
// (lock/unlock refusals also carry a `code`, translated by /lock and /unlock).
// `log` and `lockStore` can be replaced in tests.

import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { logEvent } from '../utils/moderation.js';
import { lockChannelWithState, unlockChannelWithState } from './moderation/channelLock.js';

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
        throw Object.assign(refuse(`Mewvo is missing ${missing.join(', ')} in #${channel.name}, so it cannot ${doing} there. Nothing was changed.`, 'permission'),
            { code: 'botMissing', params: { perms: missing.join(', ') } });
    }
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

/**
 * Locks `channel` like /lock (services/moderation/channelLock.js): @everyone and roles with their
 * own Send Messages allow (staff roles keep theirs), stored first so unlock restores exactly that.
 * `auditReason` goes to Discord's audit log; `durationMs` unlocks it automatically later.
 */
export async function lockChannel({ client, guild, channel, moderator, auditReason, durationMs = null, lockStore = undefined, log = logEvent, via = 'dashboard' }) {
    requireBotPerms(guild, channel, TOOL_PERMS.lock, 'lock the channel');
    const result = await lockChannelWithState({ guild, channel, moderatorId: moderator.id, durationMs, auditReason, ...(lockStore ? { store: lockStore } : {}) });
    await log({
        client,
        guild,
        event: {
            action: 'Channel Locked',
            target: channel.toString(),
            executor: `${moderator.tag} (${moderator.id})`,
            metadata: {
                channelId: channel.id, category: channel.parent?.name || 'None', moderatorId: moderator.id, via,
                ...(result.changed.length ? { rolesLocked: result.changed.length } : {}),
                ...(result.unlockAt ? { unlocksAt: result.unlockAt } : {}),
            },
        },
    });
    return { locked: true, ...result };
}

/**
 * Unlocks like /unlock: puts back exactly what the lock changed (its stored record), else clears
 * the @everyone Send Messages deny (the channel inherits from its category again).
 */
export async function unlockChannel({ client, guild, channel, moderator, auditReason, lockStore = undefined, log = logEvent, via = 'dashboard' }) {
    requireBotPerms(guild, channel, TOOL_PERMS.lock, 'unlock the channel');
    const result = await unlockChannelWithState({ guild, channel, auditReason, ...(lockStore ? { store: lockStore } : {}) });
    await log({
        client,
        guild,
        event: {
            action: 'Channel Unlocked',
            target: channel.toString(),
            executor: `${moderator.tag} (${moderator.id})`,
            metadata: { channelId: channel.id, category: channel.parent?.name || 'None', moderatorId: moderator.id, via },
        },
    });
    return { locked: false, ...result };
}

// ── Fix permissions: Mewvo gives itself what a feature needs in one channel ──

const FIX_LABEL = {
    ...PERM_LABEL, SendMessages: 'Send Messages', EmbedLinks: 'Embed Links', AttachFiles: 'Attach Files', AddReactions: 'Add Reactions',
    SendPolls: 'Create Polls', Connect: 'Connect', MoveMembers: 'Move Members', ManageRoles: 'Manage Permissions',
};
const fixLabel = (p) => FIX_LABEL[p] || p;

/**
 * What the Fix permissions page may give Mewvo in a channel: posting and reading bits only,
 * never management ones (Manage Channels / Manage Permissions stay the owner's choice).
 */
export const FIXABLE_PERMS = Object.freeze(['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory',
    'AddReactions', 'SendPolls', 'Connect', 'ManageMessages', 'MoveMembers']);

/** Changing a channel's permission overwrites needs Manage Permissions (ManageRoles) in that channel. */
export const FIX_EDIT_PERMS = Object.freeze(['ManageRoles']);

/**
 * Pure (reads the guild cache): which of `wanted` Mewvo lacks in `channel` and what it can do
 * about it. Discord lets a bot allow only permissions it has itself in the server, so:
 *   missing      the wanted bits Mewvo lacks in the channel
 *   grantable    missing bits it can give itself with a channel overwrite (empty when it cannot edit)
 *   notInServer  missing bits its server roles do not have (the owner must add them to Mewvo's role)
 *   notFixable   missing management bits this page never gives
 *   cannotEdit   what Mewvo lacks to edit the channel's permissions at all
 *   blockedBy    null, 'hidden' (Mewvo cannot see the channel: Discord then gives it no other
 *                permission there, so it cannot edit it either; discord.js does not apply that rule)
 *                or 'thread' (threads have no permission overwrites; fix the parent channel)
 * `checkable` false: the bot member is not in the cache (nothing can be said).
 */
export function planPermissionFix(guild, channel, wanted = []) {
    const names = [...new Set((Array.isArray(wanted) ? wanted : []).filter((p) => PermissionFlagsBits[p] !== undefined))];
    const me = guild?.members?.me;
    const inChannel = channel && me?.permissionsIn ? me.permissionsIn(channel) : null;
    if (!inChannel?.has) return { checkable: false, missing: names, grantable: [], notInServer: [], notFixable: [], cannotEdit: [], blockedBy: null };
    const serverWide = me.permissions;
    const inServer = (p) => Boolean(serverWide?.has?.(PermissionFlagsBits[p]));
    const missing = names.filter((p) => !inChannel.has(PermissionFlagsBits[p]));
    const fixable = missing.filter((p) => FIXABLE_PERMS.includes(p));
    const cannotEdit = FIX_EDIT_PERMS.filter((p) => !inChannel.has(PermissionFlagsBits[p]));
    const isThread = typeof channel.isThread === 'function' ? channel.isThread() : !channel.permissionOverwrites;
    const blockedBy = isThread || !channel.permissionOverwrites ? 'thread' : !inChannel.has(PermissionFlagsBits.ViewChannel) ? 'hidden' : null;
    return {
        checkable: true,
        missing,
        grantable: cannotEdit.length || blockedBy ? [] : fixable.filter(inServer),
        notInServer: fixable.filter((p) => !inServer(p)),
        notFixable: missing.filter((p) => !FIXABLE_PERMS.includes(p)),
        cannotEdit,
        blockedBy,
    };
}

/** Why Mewvo cannot fix it itself, in plain words ('' when it can try). */
export function blockedReason(channel, plan) {
    if (plan.blockedBy === 'thread') return 'This is a thread. Threads use the permissions of their channel, so fix the parent channel instead.';
    if (plan.blockedBy === 'hidden') return `Mewvo cannot see #${channel?.name || 'this channel'}, so Discord does not let it change anything there.`;
    if (plan.cannotEdit.length) return `It is missing ${permissionLabels(plan.cannotEdit).join(', ')} in this channel.`;
    return '';
}

export const permissionLabels = (perms) => perms.map(fixLabel);

/** The plain steps the server owner can take in Discord when Mewvo cannot fix it itself. */
export function manualFixSteps(channel, plan) {
    const steps = [];
    const roleBits = [...new Set([...plan.notInServer, ...plan.cannotEdit])];
    if (roleBits.length) {
        // In the role settings Discord calls Manage Permissions "Manage Roles".
        const roleLabels = roleBits.map((p) => (p === 'ManageRoles' ? 'Manage Roles' : fixLabel(p)));
        steps.push(`In Discord, open Server Settings → Roles → Mewvo, turn on ${roleLabels.join(', ')}, then Save Changes.`);
    }
    if (plan.missing.length) {
        steps.push(`${roleBits.length ? 'Or give' : 'You can also give'} it in this channel only: right-click #${plan.blockedBy === 'thread' ? 'the parent channel' : channel?.name || 'the channel'} → Edit Channel → Permissions → add Mewvo, turn on ${permissionLabels(plan.missing).join(', ')} (green check), then Save Changes.`);
    }
    return steps;
}

/**
 * Adds a channel overwrite for Mewvo's own member that allows only the missing bits it may
 * give itself (planPermissionFix). Refuses (type 'permission', nothing changed) when it cannot
 * edit the channel's permissions or has none of the bits in the server; the message says what
 * the owner must do in Discord. Logs "Channel Permissions Fixed" (mod log, via loggingService).
 * Returns { granted, stillMissing } (labels) and grantedBits (names).
 */
export async function fixBotChannelPermissions({ client, guild, channel, wanted, moderator, auditReason, log = logEvent }) {
    const plan = planPermissionFix(guild, channel, wanted);
    if (!plan.checkable) throw refuse('Mewvo cannot check its own permissions right now. Try again in a minute. Nothing was changed.');
    if (!plan.missing.length) throw refuse(`Mewvo already has what it needs in #${channel.name}. Nothing was changed.`);
    const manual = manualFixSteps(channel, plan).join(' ');
    if (plan.blockedBy || plan.cannotEdit.length) {
        throw refuse(`Mewvo cannot change permissions in #${channel.name}. ${blockedReason(channel, plan)} Nothing was changed. ${manual}`, 'permission');
    }
    if (!plan.grantable.length) {
        throw refuse(`Mewvo cannot give itself ${permissionLabels(plan.missing).join(', ')}: Discord only lets it give permissions its own role already has. Nothing was changed. ${manual}`, 'permission');
    }
    const me = guild.members.me;
    try {
        await channel.permissionOverwrites.edit(me, Object.fromEntries(plan.grantable.map((p) => [p, true])), { type: OverwriteType.Member, reason: auditReason });
    } catch (error) {
        // 50013 Missing Permissions / 50001 Missing Access: Discord said no; say what to do instead.
        if (error?.code === 50013 || error?.code === 50001 || error?.status === 403) {
            throw refuse(`Discord refused the change in #${channel.name}. Nothing was changed. ${manual}`, 'permission');
        }
        throw error;
    }
    const stillMissingBits = [...plan.notInServer, ...plan.notFixable];
    const granted = permissionLabels(plan.grantable);
    const stillMissing = permissionLabels(stillMissingBits);
    await log({
        client,
        guild,
        event: {
            action: 'Channel Permissions Fixed',
            target: channel.toString(),
            executor: `${moderator.tag} (${moderator.id})`,
            reason: `Mewvo gave itself ${granted.join(', ')} in #${channel.name}${stillMissing.length ? ` (still missing: ${stillMissing.join(', ')})` : ''}`,
            metadata: { channelId: channel.id, granted: plan.grantable, stillMissing: stillMissingBits, moderatorId: moderator.id, via: 'dashboard' },
        },
    });
    return { granted, stillMissing, grantedBits: plan.grantable };
}
