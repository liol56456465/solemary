// backgroundView.js — /background record views and their pagination buttons.
//
// custom_id: bg:page:<viewerId>:<targetId>:<page> — stateless, so it survives restarts.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../utils/embeds.js';
import { createError, ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { enforcementConfig } from '../config/enforcement.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { getAppealHistory, listCasesForUser } from '../services/enforcement/caseService.js';
import { dateStamp, formatDuration, stamp, truncate } from '../services/enforcement/format.js';

const PAGE_SIZE = 6;

function userError(message) {
    return createError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** Reads the user / user_id options shared by /enforcements and /background. */
export async function resolveTargetUser(interaction, client) {
    const picked = interaction.options.getUser('user');
    const rawId = interaction.options.getString('user_id')?.trim();

    if (picked && rawId && picked.id !== rawId) {
        throw userError('Use either the user picker or user_id, not both.');
    }
    if (picked) return picked;
    if (!rawId) throw userError('Pick a user or enter a user_id.');
    if (!/^\d{17,20}$/.test(rawId)) throw userError('user_id must be a Discord user ID (17–20 digits).');

    const user = await client.users.fetch(rawId).catch(() => null);
    if (!user) throw userError(`No Discord user with ID \`${rawId}\` exists.`);
    return user;
}

function statusLabel(row) {
    if (row.status === 'active' && row.expires_at && new Date(row.expires_at) <= new Date()) {
        return 'expired';
    }
    return row.status.replace('_', ' ');
}

function appealability(row) {
    if (row.unappealable) return 'Unappealable';
    if (row.appeal_deadline) return `Appealable until ${dateStamp(row.appeal_deadline)}`;
    return 'Appealable';
}

export async function buildRecordEmbed(row) {
    const appeals = await getAppealHistory(row.case_code);
    const lines = [
        `**Case code:** \`${row.case_code}\``,
        `**Type:** ${row.type}${row.is_auto ? ' (automatic, warn ladder)' : ''}${row.is_imported ? ' (imported, not counted)' : ''}`,
        `**User:** ${row.target_username} (\`${row.target_user_id}\`)`,
        `**By:** ${row.moderator_username} (\`${row.moderator_id}\`)`,
        `**When:** ${stamp(row.created_at)}`,
        `**Reason:** ${row.reason} (${row.prebuilt_or_custom})`,
    ];
    if (row.type === 'ban' || row.type === 'mute') {
        lines.push(row.expires_at
            ? `**Duration:** ${formatDuration(Number(row.duration_ms))} — ends ${stamp(row.expires_at)}`
            : '**Duration:** Permanent');
    }
    lines.push(
        `**Appeal:** ${appealability(row)}`,
        `**Ladder level after:** ${row.ladder_level_after}`,
        `**DM delivered:** ${row.dm_delivered ? 'Yes' : 'No'}`,
        `**Status:** ${statusLabel(row)}`,
    );
    if (row.status === 'revoked') {
        lines.push(`**Revoked:** ${row.revoked_at ? dateStamp(row.revoked_at) : '—'}${row.revoked_by ? ` by \`${row.revoked_by}\`` : ''}${row.revoke_reason ? ` — ${row.revoke_reason}` : ''}`);
    }

    const history = appeals.length
        ? appeals.map((appeal) => `${dateStamp(appeal.created_at)} — **${appeal.status}**${appeal.decided_by_username ? ` by ${appeal.decided_by_username}` : ''}${appeal.note ? `: ${appeal.note}` : ''}`).join('\n')
        : 'None';

    return createEmbed({
        title: truncate(row.name, 256),
        description: truncate(lines.join('\n'), 4096),
        fields: [{ name: 'Appeal history', value: truncate(history, 1024) }],
        color: row.status === 'active' ? 'warning' : 'secondary',
    });
}

export async function buildRecordList(guildId, viewerId, targetUser, page) {
    const { rows, total } = await listCasesForUser(guildId, targetUser.id, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const fields = rows.map((row) => ({
        name: truncate(`${row.name} · ${row.type} · ${statusLabel(row)}`, 256),
        value: truncate([
            `\`${row.case_code}\` · ${dateStamp(row.created_at)}${row.is_imported ? ' · imported' : ''}`,
            `Reason: ${row.reason}`,
            row.expires_at ? `Ends ${stamp(row.expires_at)}` : null,
        ].filter(Boolean).join('\n'), 1024),
    }));

    const embed = createEmbed({
        title: truncate(`Background — ${targetUser.username}`, 256),
        description: total
            ? `${total} record(s), newest first. Use \`name:\` to open one in full.`
            : 'No records for this user.',
        fields,
        footer: { text: `Page ${Math.min(page + 1, pages)} of ${pages}` },
        color: 'primary',
    });

    const components = pages > 1 ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`bg:page:${viewerId}:${targetUser.id}:${page - 1}`)
            .setLabel('Newer')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`bg:page:${viewerId}:${targetUser.id}:${page + 1}`)
            .setLabel('Older')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page + 1 >= pages),
    )] : [];

    return { embeds: [embed], components };
}

export async function handleBackgroundButton(interaction, client, args) {
    const [step, viewerId, targetId, rawPage] = args;
    if (step !== 'page') return;

    if (interaction.user.id !== viewerId || !isAdministrator(interaction.member)
        || interaction.guildId !== enforcementConfig.mainGuildId) {
        return replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: 'Run /background yourself to browse records.',
        });
    }

    await interaction.deferUpdate();
    const targetUser = await client.users.fetch(targetId);
    const page = Math.max(0, Number.parseInt(rawPage, 10) || 0);
    await InteractionHelper.safeEditReply(interaction, await buildRecordList(interaction.guildId, viewerId, targetUser, page));
}
