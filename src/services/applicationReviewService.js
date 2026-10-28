// applicationReviewService.js — approving or denying a submitted application, with
// everything that goes with it: the status change (ApplicationService.reviewApplication,
// pending only), the DM to the applicant, the log message's status field, and the role
// on approval. Shared by /app-admin review and the web dashboard (Applications page).

import { EmbedBuilder } from 'discord.js';
import { createEmbed } from '../utils/embeds.js';
import { getApplicationStatusColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { getApplication } from '../utils/database.js';
import ApplicationService from './applicationService.js';

export const REVIEW_NOTE_MAX = 500;

export function getApplicationStatusPresentation(statusValue) {
    const normalized = typeof statusValue === 'string' ? statusValue.trim().toLowerCase() : 'unknown';
    const statusLabel =
        normalized === 'pending' ? 'In Progress' :
        normalized === 'approved' ? 'Accepted' :
        normalized === 'denied' ? 'Denied' :
        'Unknown';
    const statusEmoji =
        normalized === 'pending' ? '🟡' :
        normalized === 'approved' ? '🟢' :
        normalized === 'denied' ? '🔴' :
        '⚪';
    return { normalized, statusLabel, statusEmoji };
}

/**
 * Reviews one application. action: 'approve' | 'deny'. Throws (nothing changed) when it
 * does not exist or is not pending. After the status is saved, the DM, the log message
 * and the role are best effort: their outcome is returned, failures are logged.
 * Returns { application, status, reason, dmDelivered, logUpdated, roleAdded (null on deny) }.
 */
export async function reviewApplicationAndNotify(client, guild, applicationId, { action, reason, reviewerId }) {
    const application = await getApplication(client, guild.id, applicationId);
    if (!application) {
        throw createError('Application not found', ErrorTypes.USER_INPUT, 'Application not found.', { applicationId, expected: true });
    }
    const note = String(reason ?? '').trim().slice(0, REVIEW_NOTE_MAX) || 'No reason provided.';
    const isApprove = action === 'approve';
    const status = isApprove ? 'approved' : 'denied';

    const updated = await ApplicationService.reviewApplication(client, guild.id, applicationId, { action, reason: note, reviewerId });

    let dmDelivered = false;
    try {
        const user = await client.users.fetch(application.userId);
        const view = getApplicationStatusPresentation(status);
        const dmEmbed = createEmbed({
            title: `${view.statusEmoji} Application ${view.statusLabel}`,
            description: `Your application for **${application.roleName}** has been **${status}**\n`
                + `**Note:** ${note}\n\n`
                + `Use \`/apply status id:${applicationId}\` to view details.`,
        }).setColor(getApplicationStatusColor(status));
        await user.send({ embeds: [dmEmbed] });
        dmDelivered = true;
    } catch (error) {
        logger.warn('Failed to send DM to user for application review', { error: error.message, userId: application.userId, applicationId });
    }

    let logUpdated = false;
    if (application.logMessageId && application.logChannelId) {
        try {
            const logChannel = guild.channels.cache.get(application.logChannelId);
            const logMessage = logChannel ? await logChannel.messages.fetch(application.logMessageId) : null;
            const embed = logMessage?.embeds?.[0];
            if (embed) {
                const view = getApplicationStatusPresentation(status);
                const newEmbed = EmbedBuilder.from(embed)
                    .setColor(getApplicationStatusColor(status))
                    .spliceFields(0, 1, { name: 'Status', value: `${view.statusEmoji} ${view.statusLabel}` });
                await logMessage.edit({ embeds: [newEmbed], components: [] });
                logUpdated = true;
            }
        } catch (error) {
            logger.warn('Failed to update log message for application', { error: error.message, applicationId, logMessageId: application.logMessageId });
        }
    }

    let roleAdded = null;
    if (isApprove) {
        roleAdded = false;
        try {
            const member = await guild.members.fetch(application.userId);
            await member.roles.add(application.roleId);
            roleAdded = true;
        } catch (error) {
            logger.error('Failed to assign role to approved applicant', { error: error.message, userId: application.userId, roleId: application.roleId, applicationId });
        }
    }

    return { application: updated || { ...application, status }, status, reason: note, dmDelivered, logUpdated, roleAdded };
}
