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

import { ticketStaffRoleIds, ticketStaffMentions } from '../../utils/ticket/staffRoles.js';
import { AttachmentBuilder, SnowflakeUtil } from 'discord.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { db } from '../../utils/database/wrapper.js';
import { logger } from '../../utils/logger.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { generateTranscript } from '../ticket.js';
import { isEnforcementDbAvailable, query, T } from './db.js';
import { SettingsUnavailableError, guildIdFor, isHomeGuild, resolveSetting } from '../settings/guildSettings.js';

const DECIDED_GRACE_MS = 10 * 60 * 1000; // the normal delayed delete gets this long first
const reminderKey = (appealId) => `appeals:stale-reminded:${appealId}`;

/** When the channel last saw a message (or was created). */
function lastActivity(channel) {
    return channel.lastMessageId
        ? Number(SnowflakeUtil.timestampFrom(channel.lastMessageId))
        : channel.createdTimestamp;
}

/**
 * Why a channel was closed, in a language: { days } (a report with no messages) or { status } (a
 * decided appeal). English is also what is stored and written to the audit log.
 */
function closeReason(why, lang = 'en') {
    const tr = botText(lang);
    if (why.days !== undefined) return tr.tp('staff.dossier.stale.noMessages', why.days);
    const status = {
        accepted: () => tr.t('staff.dossier.appealStatus.accepted'),
        denied: () => tr.t('staff.dossier.appealStatus.denied'),
        closed: () => tr.t('staff.dossier.appealStatus.closed'),
        pending: () => tr.t('staff.dossier.appealStatus.pending'),
    }[why.status]?.() ?? why.status;
    return tr.t('staff.dossier.stale.decided', { status });
}

async function closeWithTranscript(client, guild, channel, row, reason) {
    const why = closeReason(reason);
    const config = await getGuildConfig(client, guild.id);
    const transcriptChannel = config.ticketTranscriptChannelId
        ? await client.channels.fetch(config.ticketTranscriptChannelId).catch(() => null)
        : null;
    const transcript = transcriptChannel?.isSendable() ? await generateTranscript(channel) : null;
    if (transcript) {
        // A staff channel: the server's language.
        const tr = textForGuild(guild.id, { userId: row.user_id, purpose: 'public' });
        const params = { userId: row.user_id, code: row.case_code, why: closeReason(reason, tr.lang) };
        await transcriptChannel.send({
            content: row.kind === 'report' ? tr.t('staff.dossier.stale.reportClosed', params) : tr.t('staff.dossier.stale.appealClosed', params),
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

async function remindStaff(client, guild, channel, row, reminderMs) {
    if (await db.get(reminderKey(row.id), null)) return;
    // Ban/kick appeal: remind in the main-server staff channel, not where the appellant reads.
    if (row.staff_channel_id) {
        channel = guild.channels.cache.get(row.staff_channel_id)
            || await guild.channels.fetch(row.staff_channel_id).catch(() => null);
        if (!channel) return;
    }
    const config = await getGuildConfig(client, guild.id);
    const staffRoleIds = ticketStaffRoleIds(config);
    const days = Math.round(reminderMs / 86400000);
    const tr = textForGuild(guild.id, { userId: row.user_id, purpose: 'public' });
    const reminder = tr.tp(isHomeGuild(guild.id) ? 'staff.dossier.stale.reminderHome' : 'staff.dossier.stale.reminder', days, { code: row.case_code });
    await channel.send({
        // /appeals exists in the main server only; another server decides with the buttons.
        content: `${staffRoleIds.length ? `${ticketStaffMentions(config)} ` : ''}${reminder}`,
        allowedMentions: { roles: staffRoleIds },
    });
    await db.set(reminderKey(row.id), { at: new Date().toISOString() });
}

export async function tidyStaleAppealChannels(client) {
    if (!isEnforcementDbAvailable()) return;
    // Home rows (main/support) are tidied in the main server with its settings, as before; any
    // other server's rows in that server with its own settings. A server whose settings cannot
    // be read is skipped for this run.
    const mainGuild = client.guilds.cache.get(enforcementConfig.mainGuildId) || null;

    const { rows } = await query(
        `SELECT id, kind, case_code, user_id, guild_id, status, channel_id, channel_guild_id, staff_channel_id, decided_at FROM ${T.appeals}
         WHERE channel_id IS NOT NULL AND created_at > NOW() - INTERVAL '90 days'
         ORDER BY created_at`,
    );
    const now = Date.now();
    const skipped = new Set();
    for (const row of rows) {
        const home = isHomeGuild(row.guild_id);
        const guild = home ? mainGuild : client.guilds.cache.get(row.guild_id);
        if (!guild || skipped.has(guild.id)) continue;
        const channelGuild = row.channel_guild_id ? client.guilds.cache.get(row.channel_guild_id) : guild;
        const channel = channelGuild?.channels.cache.get(row.channel_id);
        if (!channel) continue;
        try {
            const settingsGuildId = home ? guildIdFor('main') || guild.id : guild.id;
            const idleMs = now - lastActivity(channel);
            if (row.kind === 'report') {
                const staleReportMs = resolveSetting(settingsGuildId, 'staleReportMs');
                if (idleMs >= staleReportMs) {
                    await closeWithTranscript(client, guild, channel, row, { days: Math.round(staleReportMs / 86400000) });
                }
            } else if (row.status === 'pending') {
                const reminderMs = resolveSetting(settingsGuildId, 'staleAppealReminderMs');
                if (idleMs >= reminderMs) await remindStaff(client, guild, channel, row, reminderMs);
            } else if (row.decided_at && now - new Date(row.decided_at).getTime() >= DECIDED_GRACE_MS) {
                await closeWithTranscript(client, guild, channel, row, { status: row.status });
                const staffChannel = row.staff_channel_id ? guild.channels.cache.get(row.staff_channel_id) : null;
                if (staffChannel) await closeWithTranscript(client, guild, staffChannel, row, { status: row.status });
            }
        } catch (error) {
            if (error instanceof SettingsUnavailableError) {
                skipped.add(guild.id);
                logger.warn(`Stale appeal/report channels of guild ${guild.id} skipped this run: ${error.message}`);
                continue;
            }
            logger.warn(`Stale ${row.kind} channel ${row.channel_id} could not be tidied: ${error.message}`);
        }
    }
}
