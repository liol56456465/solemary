// muteService.js — the Muted role: create, position, channel denies, apply/remove.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { query, T } from './db.js';
import { resolveSetting } from '../settings/guildSettings.js';
import { logger } from '../../utils/logger.js';

const MUTED_DENY_NAMES = [
    'SendMessages',
    'SendMessagesInThreads',
    'CreatePublicThreads',
    'CreatePrivateThreads',
    'AddReactions',
    'Speak',
];
export const MUTED_DENY = MUTED_DENY_NAMES.map((name) => PermissionFlagsBits[name]);

// Thread channels inherit from their parent and cannot hold overwrites.
const SKIP_TYPES = new Set([
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
]);

async function getStoredRoleId(guildId) {
    const { rows } = await query(`SELECT muted_role_id FROM ${T.settings} WHERE guild_id = $1`, [guildId]);
    return rows[0]?.muted_role_id || null;
}

async function storeRoleId(guildId, roleId) {
    await query(
        `INSERT INTO ${T.settings} (guild_id, muted_role_id, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (guild_id) DO UPDATE SET muted_role_id = EXCLUDED.muted_role_id, updated_at = NOW()`,
        [guildId, roleId]
    );
}

/**
 * Returns the guild's muted role without creating anything: this server's configured
 * mutedRoleId (resolveSetting: never the main server's role in another server), then the role
 * the bot created and stored for it.
 */
export async function findMutedRole(guild) {
    for (const roleId of [resolveSetting(guild.id, 'mutedRoleId'), await getStoredRoleId(guild.id)]) {
        if (!roleId) continue;
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (role) return role;
    }
    return null;
}

function hasMutedOverwrite(channel, roleId) {
    const overwrite = channel.permissionOverwrites?.cache?.get(roleId);
    return Boolean(overwrite && MUTED_DENY.every((flag) => overwrite.deny.has(flag)));
}

export async function applyMutedOverwrite(channel, role) {
    if (SKIP_TYPES.has(channel.type) || !channel.permissionOverwrites) {
        return false;
    }
    if (hasMutedOverwrite(channel, role.id)) {
        return false;
    }
    const deny = Object.fromEntries(MUTED_DENY_NAMES.map((name) => [name, false]));
    await channel.permissionOverwrites.edit(role, deny, { reason: 'Muted role: deny chat, reactions and voice' });
    return true;
}

/**
 * Finds or creates the muted role, keeps it just below the bot's highest role,
 * and adds the deny overwrite to any channel that is missing it.
 *
 * Where the role sits does not decide whether a mute works (checked 2026-11-09, Discord's
 * permission order): channel overwrites of all of a member's roles are combined regardless of role
 * position, and a role overwrite ALLOW beats a role overwrite DENY; then the member's own overwrite
 * applies, and Administrator ignores overwrites. Position only matters for the bot being allowed to
 * give the role (it must be below the bot's highest role; a role the bot creates always is) and
 * for display. The real gaps are found by mutedRoleGaps below and shown to the moderator.
 */
export async function ensureMutedRole(guild) {
    let role = await findMutedRole(guild);

    if (!role) {
        role = await guild.roles.create({
            name: enforcementConfig.mutedRoleName,
            permissions: [],
            reason: 'Muted role for /enforcements',
        });
        await storeRoleId(guild.id, role.id);
        logger.info(`Created muted role ${role.id} in guild ${guild.id}`);
    }

    const botHighest = guild.members.me?.roles?.highest;
    if (botHighest && role.position < botHighest.position - 1) {
        await role.setPosition(Math.max(1, botHighest.position - 1)).catch((error) => {
            logger.warn(`Could not position muted role in guild ${guild.id}: ${error.message}`);
        });
    }

    const channels = await guild.channels.fetch();
    let updated = 0;
    for (const channel of channels.values()) {
        if (!channel) continue;
        try {
            if (await applyMutedOverwrite(channel, role)) updated += 1;
        } catch (error) {
            logger.warn(`Could not set muted overwrite on channel ${channel.id}: ${error.message}`);
        }
    }
    if (updated > 0) {
        logger.info(`Applied muted overwrites to ${updated} channel(s) in guild ${guild.id}`);
    }

    return role;
}

function overwriteAllows(overwrite, bit) {
    return Boolean(overwrite?.allow?.has?.(bit));
}

function overwriteDenies(overwrite, bit) {
    return Boolean(overwrite?.deny?.has?.(bit));
}

const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/**
 * Pure (guild cache): where the Muted role cannot stop `member`. { admin, channels }:
 *   admin     the member has Administrator (overwrites do not apply to them at all)
 *   channels  channels they can see where their own overwrite, or (without an own deny) one of
 *             their other roles' overwrites, ALLOWS Send Messages (Speak in voice channels): an
 *             allow beats the Muted role's deny, whatever the role order.
 */
export function mutedRoleGaps(guild, member, mutedRoleId) {
    if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return { admin: true, channels: [] };
    const roleIds = [...(member?.roles?.cache?.keys?.() || [])].filter((id) => id !== mutedRoleId && id !== guild.id);
    const channels = [];
    for (const channel of guild?.channels?.cache?.values?.() || []) {
        if (!channel || SKIP_TYPES.has(channel.type) || channel.type === ChannelType.GuildCategory) continue;
        const cache = channel.permissionOverwrites?.cache;
        if (!cache?.get) continue;
        const bits = VOICE_TYPES.has(channel.type) ? [PermissionFlagsBits.SendMessages, PermissionFlagsBits.Speak] : [PermissionFlagsBits.SendMessages];
        const own = cache.get(member.id);
        const leaks = bits.some((bit) => overwriteAllows(own, bit)
            || (!overwriteDenies(own, bit) && roleIds.some((id) => overwriteAllows(cache.get(id), bit))));
        if (!leaks) continue;
        if (channel.permissionsFor?.(member)?.has?.(PermissionFlagsBits.ViewChannel) === false) continue;
        channels.push(channel);
    }
    return { admin: false, channels };
}

/** The moderator's notes for mutedRoleGaps (their language): [] when the mute holds everywhere. */
export function mutedRoleGapNotes(tr, gaps, name) {
    if (gaps?.admin) return [tr.t('staff.enfCheck.note.muteAdmin', { name })];
    const list = gaps?.channels || [];
    if (!list.length) return [];
    const shown = list.slice(0, 5).map((c) => `#${c.name}`).join(', ') + (list.length > 5 ? ` +${list.length - 5}` : '');
    return [tr.tp('staff.enfCheck.note.muteLeak', list.length, { name, channels: shown })];
}

export async function addMutedRole(member, role, reason) {
    if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role, reason);
    }
    if (member.voice?.channelId) {
        await member.voice.disconnect(reason).catch((error) => {
            logger.warn(`Could not disconnect muted member ${member.id} from voice: ${error.message}`);
        });
    }
}

export async function removeMutedRole(guild, userId, reason) {
    const role = await findMutedRole(guild);
    if (!role) return false;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || !member.roles.cache.has(role.id)) return false;
    await member.roles.remove(role, reason);
    return true;
}
