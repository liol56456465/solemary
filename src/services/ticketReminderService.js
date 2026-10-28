// ticketReminderService.js — nudges for tickets that stall (run every 5 minutes).
//
//   - Open for UNANSWERED_MS with no staff reply and nobody claiming it: ping the
//     ticket staff role in the ticket, once.
//   - Staff wrote last and the ticket creator has not answered for INACTIVE_MS: post
//     a note that staff can close it, once (it resets when the creator writes again).
// Each reminder is remembered on the ticket record, so a restart doesn't repeat it.

import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { query, T, isEnforcementDbAvailable } from './enforcement/db.js';

const UNANSWERED_MS = 30 * 60 * 1000;
const INACTIVE_MS = 24 * 60 * 60 * 1000;
const MAX_TICKETS_PER_RUN = 100;

async function openTickets() {
    const { rows } = await query(
        `SELECT guild_id, channel_id FROM ${T.tickets} WHERE data->>'status' = 'open' LIMIT $1`,
        [MAX_TICKETS_PER_RUN]
    );
    return rows;
}

function isStaffAuthor(message, staffRoleId, ticketUserId) {
    if (!message.member || message.author.bot || message.author.id === ticketUserId) return false;
    return (staffRoleId && message.member.roles.cache.has(staffRoleId))
        || message.member.permissions.has(PermissionFlagsBits.ManageMessages)
        || message.member.permissions.has(PermissionFlagsBits.Administrator);
}

async function checkTicket(client, guildId, channelId) {
    const guild = client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel?.isTextBased?.()) return;
    const ticket = await getTicketData(guildId, channelId);
    if (!ticket || ticket.status !== 'open') return;

    const config = await getGuildConfig(client, guildId).catch(() => ({}));
    const staffRoleId = config.ticketStaffRoleId || null;
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return;
    const human = [...messages.values()].filter((m) => !m.author.bot).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const staffReplied = human.some((m) => isStaffAuthor(m, staffRoleId, ticket.userId));
    const now = Date.now();
    let changed = false;

    const openedAt = new Date(ticket.createdAt || channel.createdTimestamp).getTime();
    if (!ticket.claimedBy && !staffReplied && !ticket.remindedUnansweredAt && now - openedAt >= UNANSWERED_MS) {
        await channel.send({
            content: `${staffRoleId ? `<@&${staffRoleId}> ` : ''}This ticket has been waiting ${Math.round((now - openedAt) / 60000)} minutes without a reply. Could someone pick it up?`,
            allowedMentions: { roles: staffRoleId ? [staffRoleId] : [] },
        }).catch(() => {});
        ticket.remindedUnansweredAt = new Date().toISOString();
        changed = true;
    }

    const last = human[human.length - 1];
    if (last && isStaffAuthor(last, staffRoleId, ticket.userId)) {
        if (now - last.createdTimestamp >= INACTIVE_MS && ticket.remindedInactiveFor !== last.id) {
            await channel.send({
                content: `<@${ticket.userId}> hasn't replied for 24 hours. Staff can close this ticket if the issue is solved.`,
                allowedMentions: { parse: [] },
            }).catch(() => {});
            ticket.remindedInactiveFor = last.id;
            changed = true;
        }
    }

    if (changed) await saveTicketData(guildId, channelId, ticket);
}

export async function runTicketReminders(client) {
    if (!isEnforcementDbAvailable()) return;
    for (const { guild_id: guildId, channel_id: channelId } of await openTickets()) {
        await checkTicket(client, guildId, channelId).catch((error) =>
            logger.warn(`Ticket reminder for ${channelId} failed: ${error.message}`));
    }
}
