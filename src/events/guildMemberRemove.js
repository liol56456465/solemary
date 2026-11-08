import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { hasIntent } from '../config/intents.js';
import { getColor, botConfig } from '../config/bot.js';
import { getWelcomeConfig, getUserApplications, deleteApplication } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { resolveWelcomeImageUrl } from '../utils/welcomeImageStore.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { refreshCountersOnMemberChange } from '../services/serverstatsService.js';
import { getGuildBirthdays, deleteBirthday } from '../utils/database.js';
import { keepTempRolesOnLeave } from '../services/members/tempRoleService.js';
import { logger } from '../utils/logger.js';
import { recordMemberEvent } from '../services/members/memberInsightsService.js';

/**
 * A leaver that was not cached arrives as a partial member (Partials.GuildMember): only user,
 * guild and maybe joinedTimestamp are there, and the user itself may be partial (id only).
 * Returns what the goodbye message and the log line show, with safe fallbacks.
 */
export function describeLeaver(member) {
    const user = member?.user ?? null;
    const id = user?.id ?? member?.id ?? 'unknown';
    const label = user?.tag || user?.username || id;
    const joined = Number.isFinite(member?.joinedTimestamp) && member.joinedTimestamp > 0
        ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
        : 'unknown';
    const avatarUrl = typeof user?.displayAvatarURL === 'function' ? user.displayAvatarURL() : null;
    return { id, label, joined, avatarUrl };
}

export default {
  name: Events.GuildMemberRemove,
  once: false,
  
  async execute(member) {
    // Discord sends no member events without the Guild Members intent; a cheap guard all the same
    // (welcome, join gate, member logs, mute re-apply, role and level rules: warned at startup).
    if (!hasIntent('GuildMembers')) return;
    try {
        const { guild, user } = member;
        if (!guild || !user) return;
        const leaver = describeLeaver(member);
        
        const welcomeConfig = await getWelcomeConfig(member.client, guild.id);
        
        const goodbyeChannelId = welcomeConfig?.goodbyeChannelId;

        // Skip only the goodbye message on missing permissions / send failure; the
        // logging, counters and data cleanup below must still run.
        if (welcomeConfig?.goodbyeEnabled && goodbyeChannelId) try {
            const channel = guild.channels.cache.get(goodbyeChannelId);
            const me = guild.members.me;
            const permissions = channel?.isTextBased?.() && me ? channel.permissionsFor(me) : null;
            if (permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {

                const formatData = { user, guild, member };
                const goodbyeMessage = formatWelcomeMessage(
                    welcomeConfig.leaveMessage || welcomeConfig.leaveEmbed?.description || botConfig.welcome?.defaultGoodbyeMessage || '{user} left the server.',
                    formatData
                );

                const embedTitle = formatWelcomeMessage(
                    welcomeConfig.leaveEmbed?.title || 'Goodbye',
                    formatData
                );
                const embedFooter = welcomeConfig.leaveEmbed?.footer
                    ? formatWelcomeMessage(welcomeConfig.leaveEmbed.footer, formatData)
                    : guild.name;

                const canEmbed = permissions.has(PermissionFlagsBits.EmbedLinks);

                if (!canEmbed) {
                    await channel.send({
                        content: welcomeConfig?.goodbyePing ? `<@${user.id}> ${goodbyeMessage}` : goodbyeMessage,
                        allowedMentions: welcomeConfig?.goodbyePing ? { users: [user.id] } : { parse: [] }
                    });
                } else {
                    const embed = new EmbedBuilder()
                        .setTitle(embedTitle)
                        .setDescription(goodbyeMessage)
                        .setColor(welcomeConfig.leaveEmbed?.color || getColor('error'))
                        .setThumbnail(leaver.avatarUrl)
                        .addFields(
                            { name: 'User', value: `${leaver.label} (${leaver.id})`, inline: true },
                            { name: 'Member count', value: String(guild.memberCount ?? '?'), inline: true }
                        )
                        .setTimestamp()
                        .setFooter({ text: embedFooter });

                    if (typeof welcomeConfig.leaveEmbed?.image === 'string') {
                        embed.setImage(await resolveWelcomeImageUrl(member.client, welcomeConfig.leaveEmbed.image, welcomeConfig.goodbyeImageRef, { guildId: guild.id, label: 'goodbye' }));
                    } else if (welcomeConfig.leaveEmbed?.image?.url) {
                        embed.setImage(welcomeConfig.leaveEmbed.image.url);
                    }

                    await channel.send({
                        content: welcomeConfig?.goodbyePing ? `<@${user.id}>` : undefined,
                        allowedMentions: welcomeConfig?.goodbyePing ? { users: [user.id] } : { parse: [] },
                        embeds: [embed]
                    });
                }
            }
        } catch (error) {
            logger.warn(`Could not send goodbye message in guild ${guild.id}: ${error.message}`);
        }

        try {
            await logEvent({
                client: member.client,
                guildId: guild.id,
                eventType: EVENT_TYPES.MEMBER_LEAVE,
                data: {
                    title: 'User left',
                    lines: [
                        `**User:** <@${leaver.id}> (${leaver.label})`,
                        `**ID:** \`${leaver.id}\``,
                        `**Joined:** ${leaver.joined}`,
                        `**Members:** ${guild.memberCount ?? '?'}`,
                    ],
                    quoted: false,
                    thumbnail: leaver.avatarUrl,
                    userId: user.id,
                }
            });
        } catch (error) {
            logger.debug('Error logging member leave:', error);
        }

        // Counter channels: at most one rename per server per 5 minutes, in the background
        // (the 15-minute cron catches up).
        refreshCountersOnMemberChange(member.client, guild);

        try {
            const birthdays = await getGuildBirthdays(member.client, guild.id);
            if (birthdays[user.id]) {
                const backupKey = `guild:${guild.id}:birthdays:left`;
                // Locked: a raid's mass kicks would otherwise overwrite each other's entries.
                await member.client.db.update(backupKey, (backup) => ({ ...backup, [user.id]: birthdays[user.id] }), {});
                await deleteBirthday(member.client, guild.id, user.id);
                logger.debug(`Birthday backed up and removed for user ${user.id} in guild ${guild.id}`);
            }
        } catch (error) {
            logger.debug('Error handling birthday on member leave:', error);
        }

        try {
            const userApplications = await getUserApplications(member.client, guild.id, user.id);
            if (userApplications && userApplications.length > 0) {
                for (const app of userApplications) {
                    await deleteApplication(member.client, guild.id, app.id, user.id);
                }
                logger.debug(`Removed ${userApplications.length} applications for user ${user.id} in guild ${guild.id}`);
            }
        } catch (error) {
            logger.debug('Error handling applications on member leave:', error);
        }

        // Leaves per day for the dashboard's Members → Insights, per server.
        await recordMemberEvent(guild.id, user.id, 'leave').catch((error) => logger.warn(`Leave of ${user.id} not recorded: ${error.message}`));

        try {
            await keepTempRolesOnLeave(member);
        } catch (error) {
            logger.warn(`Could not check temporary roles of ${user.id} on leave: ${error.message}`);
        }

        // Level data is kept when a member leaves (owner, 2026-11-03): on rejoin, guildMemberAdd
        // gives the earned reward roles back. /wipedata still deletes it.

    } catch (error) {
        logger.error('Error in guildMemberRemove event:', error);
    }
  }
};