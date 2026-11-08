import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getColor, botConfig } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { resolveWelcomeImageUrl } from '../utils/welcomeImageStore.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { setBirthday as dbSetBirthday } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { reapplyMuteOnJoin } from '../services/enforcement/enforcementService.js';
import { reapplyTempRolesOnJoin } from '../services/members/tempRoleService.js';
import { syncPremiumRole } from '../services/billing/premiumEffects.js';
import { syncBannedRoleQuietly } from '../services/enforcement/bannedRoleService.js';
import { syncWarnRolesQuietly } from '../services/enforcement/warnRoleService.js';

import { noteGateKick, noteIncidentEvent, recordJoin } from '../services/automod/raidService.js';
import { checkJoinGate, gateCheckLabels } from '../services/automod/joinGate.js';
import { checkImpersonation } from '../services/automod/memberChecks.js';
import { startProbationOnJoin } from '../services/automod/probationService.js';
import { enforcementConfig } from '../config/enforcement.js';
import { isEnforcementDbAvailable } from '../services/enforcement/db.js';
import { recordMemberEvent } from '../services/members/memberInsightsService.js';
import { applyRoleRulesToMember } from '../services/members/roleRuleService.js';
import { alertWatched } from '../services/enforcement/watchlistService.js';
import { syncLevelRolesForMember } from '../services/leveling/levelRoleSyncService.js';

// Welcome messages keep the mentions they had before the client default dropped roles
// (2026-11-03): users and roles from the admin-written text, never @everyone/@here.
export const WELCOME_MENTIONS = Object.freeze({ parse: ['users', 'roles'] });

export default {
  name: Events.GuildMemberAdd,
  once: false,
  
  async execute(member) {
    try {
        const { guild, user } = member;

        // Staff watchlist: a watched member joining/rejoining → one mod log line (memory only; never throws).
        if (!user.bot) {
            void alertWatched(member.client, {
                guildId: guild.id,
                userId: user.id,
                username: user.username,
                kind: 'join',
                event: Number.isFinite(user.createdTimestamp)
                    ? `joined the server (account created <t:${Math.floor(user.createdTimestamp / 1000)}:R>)`
                    : 'joined the server',
            });
        }

        // Leaving and rejoining must not shake off an active mute; runs first so
        // nothing later in the join pipeline can skip it.
        if (isEnforcementDbAvailable()) {
            await reapplyMuteOnJoin(member).catch((error) => {
                logger.warn(`Could not check mute state for ${member.id}: ${error.message}`);
            });
            // Someone banned from the main server who joins the support server gets the banned role.
            if (guild.id === enforcementConfig.supportGuildId) {
                await syncBannedRoleQuietly(member.client, member.id);
            }
            // Rejoining the main server (e.g. after a temporary ban) restores the warning role.
            if (guild.id === enforcementConfig.mainGuildId) {
                // Joins per day for the dashboard's Members → Insights.
                await recordMemberEvent(guild.id, member.id, 'join').catch((error) => logger.warn(`Join of ${member.id} not recorded: ${error.message}`));
                await syncWarnRolesQuietly(guild, member.id);
                // Temporary roles that have not ended yet come back on rejoin.
                await reapplyTempRolesOnJoin(member).catch((error) => logger.warn(`Temporary roles not given back to ${member.id}: ${error.message}`));
                // An active plan gives its supporter role back.
                await syncPremiumRole(member.client, member.id).catch((error) => logger.warn(`Supporter role not given back to ${member.id}: ${error.message}`));
            }
            // Automod on joins, in every server (multi-server B1): each check returns at once
            // where automod is off (the default outside the main server). Same order as before.
            await recordJoin(member).catch((error) => logger.warn(`Raid tracking failed for ${member.id}: ${error.message}`));
            // Join gate (/automod joingate): a kicked member skips the rest of the pipeline.
            // Both callbacks only record (raid incident report, raid timeline); neither throws.
            const gate = await checkJoinGate(member, {
                onKick: async (userId, hits) => {
                    await noteGateKick(guild.id, userId).catch((error) => logger.warn(`Could not note join gate kick: ${error.message}`));
                    await noteIncidentEvent(guild.id, { kind: 'gate_kick', targetId: userId, detail: gateCheckLabels(hits) });
                },
                // Not awaited: the rest of the join pipeline must not wait for the timeline.
                onFlag: (userId, hits) => { noteIncidentEvent(guild.id, { kind: 'gate_flag', targetId: userId, detail: gateCheckLabels(hits) }); },
            });
            if (gate === 'kicked') return;
            await checkImpersonation(member);
            // Back after a ban that ended recently: automod extra-watch period (/automod extrawatch).
            await startProbationOnJoin(member).catch((error) => logger.warn(`Probation check failed for ${member.id}: ${error.message}`));
            if (guild.id === enforcementConfig.mainGuildId) {
                // Role rules (dashboard Members): e.g. "days in the server: 0" gives its role now.
                await applyRoleRulesToMember(member).catch((error) => logger.warn(`Role rules not applied to ${member.id}: ${error.message}`));
            }
        }

        // Rejoin: level data is kept when a member leaves (guildMemberRemove), so give back the
        // level reward roles they earned (by reward mode). New members have no level data and get
        // nothing. Hierarchy and missing permissions are logged and skipped inside; a DB error only logs here.
        if (!user.bot) {
            await syncLevelRolesForMember(member.client, member, { reason: 'Level reward (rejoined)' }).catch((error) => {
                logger.warn(`Level reward roles not given back to ${member.id}: ${error.message}`);
            });
        }

        const config = await getGuildConfig(member.client, guild.id);
        
        const welcomeConfig = await getWelcomeConfig(member.client, guild.id);
        
        const welcomeChannelId = welcomeConfig?.channelId;

        // A failed welcome send (bad image URL, perms changed mid-send, ...) must not
        // abort auto-role and the rest of the join pipeline below.
        if (welcomeConfig?.enabled && welcomeChannelId) try {
            const channel = guild.channels.cache.get(welcomeChannelId);
            const me = guild.members.me;
            const permissions = channel?.isTextBased?.() && me ? channel.permissionsFor(me) : null;
            // Skip only the welcome message if permissions are missing; the rest of the
            // join pipeline (auto-role, verification, logging, counters) must still run.
            if (permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                const formatData = { user, guild, member };
                const welcomeMessage = formatWelcomeMessage(
                    welcomeConfig.welcomeMessage || welcomeConfig.welcomeEmbed?.description || botConfig.welcome?.defaultWelcomeMessage || 'Welcome to {server}, {user}.',
                    formatData
                );

                const messageContent = welcomeConfig.welcomePing ? user.toString() : null;

                const embedTitle = formatWelcomeMessage(
                    welcomeConfig.welcomeEmbed?.title || 'Welcome',
                    formatData
                );
                const embedFooter = welcomeConfig.welcomeEmbed?.footer
                    ? formatWelcomeMessage(welcomeConfig.welcomeEmbed.footer, formatData)
                    : guild.name;

                const canEmbed = permissions.has(PermissionFlagsBits.EmbedLinks);

                if (!canEmbed) {
                    await channel.send({
                        content: messageContent ? `${messageContent} ${welcomeMessage}` : welcomeMessage,
                        // Admin-written welcome text may ping a role on purpose (the client default no longer does).
                        allowedMentions: WELCOME_MENTIONS,
                    });
                } else {
                    const embed = new EmbedBuilder()
                        .setColor(welcomeConfig.welcomeEmbed?.color || getColor('success'))
                        .setTitle(embedTitle)
                        .setDescription(welcomeMessage)
                        .setThumbnail(user.displayAvatarURL())
                        .addFields(
                            { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
                            { name: 'Member count', value: guild.memberCount.toString(), inline: true }
                        )
                        .setTimestamp()
                        .setFooter({ text: embedFooter });
                    
                    if (welcomeConfig.welcomeImage) {
                        embed.setImage(await resolveWelcomeImageUrl(member.client, welcomeConfig.welcomeImage, welcomeConfig.welcomeImageRef, { guildId: guild.id, label: 'welcome' }));
                    } else if (welcomeConfig.welcomeEmbed?.image?.url) {
                        embed.setImage(welcomeConfig.welcomeEmbed.image.url);
                    }
                    
                    await channel.send({
                        content: messageContent,
                        embeds: [embed],
                        allowedMentions: WELCOME_MENTIONS,
                    });
                }
            }
        } catch (error) {
            logger.warn(`Could not send welcome message in guild ${guild.id}: ${error.message}`);
        }
        
        if (welcomeConfig?.roleIds && welcomeConfig.roleIds.length > 0) {
            const delay = welcomeConfig.autoRoleDelay || 0;
            const singleRoleId = welcomeConfig.roleIds[0];
            
            if (delay > 0) {
                const timeout = setTimeout(async () => {
                    const role = guild.roles.cache.get(singleRoleId);
                    if (role) {
                        await assignRoleSafely(member, role);
                    }
                }, delay * 1000);
                if (typeof timeout.unref === 'function') {
                    timeout.unref();
                }
            } else {
                const role = guild.roles.cache.get(singleRoleId);
                if (role) {
                    await assignRoleSafely(member, role);
                }
            }
        }
        
        if (config?.verification?.enabled || config?.verification?.autoVerify?.enabled) {
            await handleVerification(member, guild, config.verification, member.client);
        }

        try {
            await logEvent({
                client: member.client,
                guildId: guild.id,
                eventType: EVENT_TYPES.MEMBER_JOIN,
                data: {
                    title: 'User joined',
                    lines: [
                        `**User:** ${user.toString()} (${user.displayName !== user.username ? `@${user.displayName}` : user.tag})`,
                        `**ID:** \`${user.id}\``,
                        `**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
                        `**Members:** ${guild.memberCount}`,
                    ],
                    quoted: false,
                    thumbnail: user.displayAvatarURL({ dynamic: true }),
                    userId: user.id,
                }
            });
        } catch (error) {
            logger.debug('Error logging member join:', error);
        }

        try {
            const counters = await getServerCounters(member.client, guild.id);
            for (const counter of counters) {
                if (counter && counter.type && counter.channelId && counter.enabled !== false) {
                    await updateCounter(member.client, guild, counter);
                }
            }
        } catch (error) {
            logger.debug('Error updating counters on member join:', error);
        }

        try {
            const backupKey = `guild:${guild.id}:birthdays:left`;
            const backup = (await member.client.db.get(backupKey)) || {};
            if (backup[user.id]) {
                const { month, day } = backup[user.id];
                await dbSetBirthday(member.client, guild.id, user.id, month, day);
                await member.client.db.update(backupKey, (current) => {
                    const next = { ...current };
                    delete next[user.id];
                    return next;
                }, {});
                logger.debug(`Birthday restored for user ${user.id} in guild ${guild.id}`);
            }
        } catch (error) {
            logger.debug('Error restoring birthday on member join:', error);
        }
        
    } catch (error) {
        logger.error('Error in guildMemberAdd event:', error);
    }
  }
};

async function handleVerification(member, guild, verificationConfig, client) {
    const { autoVerifyOnJoin } = await import('../services/verificationService.js');
    
    try {
        const result = await autoVerifyOnJoin(client, guild, member, verificationConfig);
        
        if (result.autoVerified) {
            logger.info('User auto-verified on join', {
                guildId: guild.id,
                userId: member.id,
                userTag: member.user.tag,
                roleName: result.roleName,
                criteria: result.criteria
            });
        } else {
            logger.debug('User not auto-verified on join', {
                guildId: guild.id,
                userId: member.id,
                reason: result.reason
            });
        }

    } catch (error) {
        logger.error('Error in auto-verification for member', {
            guildId: guild.id,
            userId: member.id,
            userTag: member.user.tag,
            error: error.message
        });
    }
}

async function assignRoleSafely(member, role) {
    try {
        await member.roles.add(role);
    } catch (error) {
        logger.warn(`Failed to assign role ${role.id} to member ${member.id}:`, error);
    }
}