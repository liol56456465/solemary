// caseSearchView.js — /case search results and their components.
//
// custom_id: csearch:page:<viewerId>:<page>   Older / Newer buttons
//            csearch:open:<viewerId>          select: open one record in full
// Stateless: the filters are encoded in the result embed's footer ("ref …"), so the
// buttons read them back from the message they are on and survive restarts. Only
// the administrator who ran the search can use them.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { createEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { enforcementConfig, getReason } from '../config/enforcement.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { caseStatusLabel, getCaseByCode, getLatestAppealStatusesForCases } from '../services/enforcement/caseService.js';
import {
    decodeSearchFilters, encodeSearchFilters, searchCaseRecords, SEARCH_PAGE_SIZE,
} from '../services/enforcement/caseSearchService.js';
import { normalizeCaseCode, truncate } from '../services/enforcement/format.js';
import { buildRecordEmbed } from './backgroundView.js';

const REF_PATTERN = /· ref ([A-Za-z0-9_-]+)$/;

/** Human-readable summary of the active filters. */
export function describeSearchFilters(filters) {
    const parts = [];
    if (filters.memberId) parts.push(`member <@${filters.memberId}>`);
    if (filters.moderatorId) parts.push(`moderator <@${filters.moderatorId}>`);
    if (filters.type) parts.push(`type **${filters.type}**`);
    if (filters.reasonKey) parts.push(`reason **${getReason(filters.reasonKey)?.label || filters.reasonKey}**`);
    if (filters.status) parts.push(`status **${filters.status}**`);
    if (filters.from || filters.to) parts.push(`date **${filters.from || '…'} → ${filters.to || '…'}** (UTC)`);
    if (filters.text) parts.push(`text “${truncate(filters.text, 60)}”`);
    return parts.length ? parts.join(' · ') : 'none (all cases)';
}

/** One result line: code, name, type, member, moderator, date, status. */
export function searchResultLine(row, appealStatus = null) {
    const day = `<t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:d>`;
    return [
        `\`${row.case_code}\` **${truncate(row.name, 50)}**`,
        `${row.type}${row.is_test ? ' (test)' : ''}`,
        truncate(row.target_username, 32),
        `by ${truncate(row.moderator_username, 32)}`,
        day,
        caseStatusLabel(row, appealStatus),
    ].join(' · ');
}

export async function buildSearchView(guildId, viewerId, filters, page) {
    const { rows, total } = await searchCaseRecords(guildId, filters, { page });
    const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
    const current = Math.min(Math.max(0, page), pages - 1);
    const appealStatuses = rows.length ? await getLatestAppealStatusesForCases(rows.map((row) => row.case_code)) : new Map();

    const header = `**Filters:** ${describeSearchFilters(filters)}`;
    const body = rows.length
        ? rows.map((row) => searchResultLine(row, appealStatuses.get(row.case_code))).join('\n')
        : (total ? 'No cases on this page any more. Use **Newer**.' : 'No cases match these filters.');

    const embed = createEmbed({
        title: `Case search — ${total} result${total === 1 ? '' : 's'}`,
        description: truncate(`${header}\n\n${body}`, 4096),
        footer: { text: `Page ${current + 1} of ${pages} · newest first · ref ${encodeSearchFilters(filters)}` },
        color: 'primary',
    });

    const components = [];
    if (rows.length) {
        components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`csearch:open:${viewerId}`)
            .setPlaceholder('Open a record in full')
            .addOptions(rows.map((row) => ({
                label: truncate(`${row.case_code} — ${row.name}`, 100),
                value: row.case_code,
                description: truncate(`${row.type} · ${row.target_username} · by ${row.moderator_username}`, 100),
            })))));
    }
    if (pages > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`csearch:page:${viewerId}:${current - 1}`).setLabel('Newer')
                .setStyle(ButtonStyle.Secondary).setDisabled(current <= 0),
            new ButtonBuilder().setCustomId(`csearch:page:${viewerId}:${current + 1}`).setLabel('Older')
                .setStyle(ButtonStyle.Secondary).setDisabled(current + 1 >= pages),
        ));
    }
    return { embeds: [embed], components };
}

/** The filters carried in a result message's footer, or null. */
export function filtersFromMessage(message) {
    const footer = message?.embeds?.[0]?.footer?.text || message?.embeds?.[0]?.data?.footer?.text || '';
    const match = REF_PATTERN.exec(footer);
    return match ? decodeSearchFilters(match[1]) : null;
}

function allowed(interaction, viewerId) {
    return interaction.user.id === viewerId
        && interaction.guildId === enforcementConfig.mainGuildId
        && isAdministrator(interaction.member);
}

export async function handleCaseSearchButton(interaction, client, args) {
    const [step, viewerId, rawPage] = args;
    if (step !== 'page') return;
    if (!allowed(interaction, viewerId)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Run /case search yourself to browse cases.' });
    }
    const filters = filtersFromMessage(interaction.message);
    if (!filters) {
        return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This search can no longer be read. Run /case search again.' });
    }
    await interaction.deferUpdate();
    const page = Math.max(0, Number.parseInt(rawPage, 10) || 0);
    await InteractionHelper.safeEditReply(interaction, await buildSearchView(interaction.guildId, viewerId, filters, page));
}

export async function handleCaseSearchSelect(interaction, client, args) {
    const [step, viewerId] = args;
    if (step !== 'open') return;
    if (!allowed(interaction, viewerId)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Run /case search yourself to browse cases.' });
    }
    const code = normalizeCaseCode(interaction.values[0]);
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const record = code ? await getCaseByCode(code) : null;
    if (!record || record.guild_id !== interaction.guildId) {
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({ title: 'Not found', description: 'That case no longer exists.', color: 'error' })],
        });
    }
    return InteractionHelper.safeEditReply(interaction, { embeds: [await buildRecordEmbed(record, { client })] });
}
