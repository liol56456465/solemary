// channelLogLines.js — server log lines for channels and threads. Pure: takes plain
// channel-like objects, so it can be tested without Discord.

import { ChannelType } from 'discord.js';

const TYPE_LABELS = {
    [ChannelType.GuildText]: 'Text channel',
    [ChannelType.GuildVoice]: 'Voice channel',
    [ChannelType.GuildCategory]: 'Category',
    [ChannelType.GuildAnnouncement]: 'Announcement channel',
    [ChannelType.GuildStageVoice]: 'Stage channel',
    [ChannelType.GuildForum]: 'Forum',
    [ChannelType.GuildMedia]: 'Media channel',
    [ChannelType.PublicThread]: 'Thread',
    [ChannelType.PrivateThread]: 'Private thread',
    [ChannelType.AnnouncementThread]: 'Announcement thread',
};

export function channelTypeLabel(type) {
    return TYPE_LABELS[type] || 'Channel';
}

const clip = (text, max = 100) => {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** Lines describing a channel (created or deleted). */
export function channelLines(channel) {
    const lines = [
        `**Name:** ${clip(channel.name)} (\`${channel.id}\`)`,
        `**Type:** ${channelTypeLabel(channel.type)}`,
    ];
    if (channel.parentId) lines.push(`**Category:** <#${channel.parentId}>`);
    if (channel.topic) lines.push(`**Topic:** ${clip(channel.topic, 200)}`);
    return lines;
}

function overwriteKey(overwrites) {
    if (!overwrites) return '';
    const list = typeof overwrites.values === 'function' ? [...overwrites.values()] : overwrites;
    return list.map((o) => `${o.id}:${o.allow?.bitfield ?? o.allow}:${o.deny?.bitfield ?? o.deny}`).sort().join('|');
}

/** "Before → after" lines for what changed on a channel; [] when nothing we show changed. */
export function channelUpdateLines(before, after) {
    const lines = [];
    if (before.name !== after.name) lines.push(`**Name:** ${clip(before.name)} → ${clip(after.name)}`);
    if ((before.topic || '') !== (after.topic || '')) lines.push(`**Topic:** ${clip(before.topic || '—', 150)} → ${clip(after.topic || '—', 150)}`);
    if ((before.parentId || null) !== (after.parentId || null)) {
        lines.push(`**Category:** ${before.parentId ? `<#${before.parentId}>` : 'none'} → ${after.parentId ? `<#${after.parentId}>` : 'none'}`);
    }
    if (Boolean(before.nsfw) !== Boolean(after.nsfw)) lines.push(`**Age-restricted:** ${before.nsfw ? 'yes' : 'no'} → ${after.nsfw ? 'yes' : 'no'}`);
    if ((before.rateLimitPerUser || 0) !== (after.rateLimitPerUser || 0)) {
        lines.push(`**Slowmode:** ${before.rateLimitPerUser || 0}s → ${after.rateLimitPerUser || 0}s`);
    }
    if ((before.userLimit || 0) !== (after.userLimit || 0)) lines.push(`**User limit:** ${before.userLimit || 'none'} → ${after.userLimit || 'none'}`);
    if (overwriteKey(before.permissionOverwrites?.cache) !== overwriteKey(after.permissionOverwrites?.cache)) {
        lines.push('**Permissions:** overwrites changed');
    }
    return lines;
}

/** What changed on a thread (archived, locked, renamed); [] when nothing we show. */
export function threadUpdateLines(before, after) {
    const lines = [];
    if (before.name !== after.name) lines.push(`**Name:** ${clip(before.name)} → ${clip(after.name)}`);
    if (Boolean(before.archived) !== Boolean(after.archived)) lines.push(`**Archived:** ${after.archived ? 'yes' : 'no (reopened)'}`);
    if (Boolean(before.locked) !== Boolean(after.locked)) lines.push(`**Locked:** ${after.locked ? 'yes' : 'no'}`);
    return lines;
}

/** Lines describing a thread (created or deleted). */
export function threadLines(thread) {
    const lines = [
        `**Thread:** ${clip(thread.name)} (\`${thread.id}\`)`,
        `**Type:** ${channelTypeLabel(thread.type)}`,
    ];
    if (thread.parentId) lines.push(`**In:** <#${thread.parentId}>`);
    if (thread.ownerId) lines.push(`**Started by:** <@${thread.ownerId}>`);
    return lines;
}
