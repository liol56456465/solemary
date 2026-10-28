// staleAppealService.js — tidies appeal and report channels that nobody uses any more.
// Runs with the ticket reminders (every 5 minutes):
//
//   - Report channels with no message for STALE_REPORT_DAYS: transcript to the
//     ticket transcript channel, report marked closed, channel deleted.
//   - Decided appeals whose channel still exists (the delayed delete after a
//     decision is an in-memory timer, so a restart can skip it): same clean-up.
//   - Pending appeals are never closed. After STALE_APPEAL_REMINDER_DAYS without a
//     message, staff get one reminder in the staff channel (main server; for ban/kick
//     appeals never in the support-server channel where the appellant reads).

import { AttachmentBuilder, SnowflakeUtil } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { db } from '../../utils/database/wrapper.js';
import { logger } from '../../utils/logger.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { generateTranscript } from '../ticket.js';
import { isEnforcementDbAvailable, query, T } from './db.js';

const DECIDED_GRACE_MS = 10 * 60 * 1000; // the normal delayed delete gets this long first
const reminderKey = (appealId) => `appeals:stale-reminded:${appealId}`;

/** When the channel last saw a message (or was created). */
function lastActivity(channel) {
    return channel.lastMessageId
        ? Number(SnowflakeUtil.timestampFrom(channel.lastMessageId))
        : channel.createdTimestamp;
}

async function closeWithTranscript(client, guild, channel, row, why) {
    const config = await getGuildConfig(client, guild.id);
    const transcriptChannel = config.ticketTranscriptChannelId
        ? await client.channels.fetch(config.ticketTranscriptChannelId).catch(() => null)
        : null;
    const transcript = transcriptChannel?.isSendable() ? await generateTranscript(channel) : null;
    if (transcript) {
        await transcriptChannel.send({
            content: `${row.kind === 'report' ? 'Staff report' : `Appeal \`${row.case_code}\``} from <@${row.user_id}> (\`${row.user_id}\`) closed automatically: ${why}.`,
            files: [new AttachmentBuilder(transcript.buffer, { name: `${row.kind}-${row.id}.html` })],
            allowedMentions: { parse: [] },
        });
    }
    if (row.kind === 'report' && row.status === 'pending') {
        await query(`UPDATE ${T.appeals} SET status = 'closed', decided_at = NOW(), note = $2 WHERE id = $1`, [row.id, `Closed automatically: ${why}`]);
    }
    await channel.delete(`Closed automatically: ${why}`);
    logger.info(`Closed ${row.kind} channel ${channel.id} (${why})`);
}

async function remindStaff(client, guild, channel, row) {
    if (await db.get(reminderKey(row.id), null)) return;
    // Ban/kick appeal: remind in the main-server staff channel, not where the appellant reads.
    if (row.staff_channel_id) {
        channel = guild.channels.cache.get(row.staff_channel_id)
            || await guild.channels.fetch(row.staff_channel_id).catch(() => null);
        if (!channel) return;
    }
    const config = await getGuildConfig(client, guild.id);
    const staffRoleId = config.ticketStaffRoleId;
    const days = Math.round(enforcementConfig.staleAppealReminderMs / 86400000);
    await channel.send({
        content: `${staffRoleId ? `<@&${staffRoleId}> ` : ''}This appeal (\`${row.case_code}\`) has had no activity for ${days} days and is still waiting for a decision. Use the Accept / Deny buttons above or \`/appeals\`.`,
        allowedMentions: { roles: staffRoleId ? [staffRoleId] : [] },
    });
    await db.set(reminderKey(row.id), { at: new Date().toISOString() });
}

export async function tidyStaleAppealChannels(client) {
    if (!isEnforcementDbAvailable()) return;
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!guild) return;

    const { rows } = await query(
        `SELECT id, kind, case_code, user_id, status, channel_id, channel_guild_id, staff_channel_id, decided_at FROM ${T.appeals}
         WHERE channel_id IS NOT NULL AND created_at > NOW() - INTERVAL '90 days'
         ORDER BY created_at`,
    );
    const now = Date.now();
    for (const row of rows) {
        const channelGuild = row.channel_guild_id ? client.guilds.cache.get(row.channel_guild_id) : guild;
        const channel = channelGuild?.channels.cache.get(row.channel_id);
        if (!channel) continue;
        try {
            const idleMs = now - lastActivity(channel);
            if (row.kind === 'report') {
                if (idleMs >= enforcementConfig.staleReportMs) {
                    await closeWithTranscript(client, guild, channel, row, `no messages for ${Math.round(enforcementConfig.staleReportMs / 86400000)} days`);
                }
            } else if (row.status === 'pending') {
                if (idleMs >= enforcementConfig.staleAppealReminderMs) await remindStaff(client, guild, channel, row);
            } else if (row.decided_at && now - new Date(row.decided_at).getTime() >= DECIDED_GRACE_MS) {
                await closeWithTranscript(client, guild, channel, row, `appeal already ${row.status}`);
                const staffChannel = row.staff_channel_id ? guild.channels.cache.get(row.staff_channel_id) : null;
                if (staffChannel) await closeWithTranscript(client, guild, staffChannel, row, `appeal already ${row.status}`);
            }
        } catch (error) {
            logger.warn(`Stale ${row.kind} channel ${row.channel_id} could not be tidied: ${error.message}`);
        }
    }
}
