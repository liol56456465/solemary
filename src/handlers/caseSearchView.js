// caseSearchView.js — /case search results and their components.
//
// custom_id: csearch:page:<viewerId>:<page>   Older / Newer buttons
//            csearch:open:<viewerId>          select: open one record in full
// Stateless: the filters are encoded in the result embed's footer ("ref …"), so the
// buttons read them back from the message they are on and survive restarts. Only
// the administrator who ran the search can use them.
// Language: an ephemeral answer, the administrator's Discord language (utils/botText.js 'reply').
// The footer's "· ref …" stays as it is (the buttons read it back).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { createEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { botText, textForInteraction } from '../utils/botText.js';
import { getReason } from '../config/enforcement.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { caseStatusLabel, getCaseByCode, getLatestAppealStatusesForCases } from '../services/enforcement/caseService.js';
import {
    decodeSearchFilters, encodeSearchFilters, searchCaseRecords, SEARCH_PAGE_SIZE,
} from '../services/enforcement/caseSearchService.js';
import { normalizeCaseCode, truncate } from '../services/enforcement/format.js';
import { buildRecordEmbed, caseTypeText } from './backgroundView.js';

const REF_PATTERN = /· ref ([A-Za-z0-9_-]+)$/;

/** Human-readable summary of the active filters. `lang`: the reader's language (default English). */
export function describeSearchFilters(filters, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const parts = [];
    if (filters.memberId) parts.push(tr.t('staff.caseSearch.filter.member', { user: `<@${filters.memberId}>` }));
    if (filters.moderatorId) parts.push(tr.t('staff.caseSearch.filter.moderator', { user: `<@${filters.moderatorId}>` }));
    if (filters.type) parts.push(tr.t('staff.caseSearch.filter.type', { type: caseTypeText(filters.type, tr) }));
    if (filters.reasonKey) parts.push(tr.t('staff.caseSearch.filter.reason', { reason: getReason(filters.reasonKey)?.label || filters.reasonKey }));
    if (filters.status) parts.push(tr.t('staff.caseSearch.filter.status', { status: filters.status }));
    if (filters.from || filters.to) parts.push(tr.t('staff.caseSearch.filter.date', { from: filters.from || '…', to: filters.to || '…' }));
    if (filters.text) parts.push(tr.t('staff.caseSearch.filter.text', { text: truncate(filters.text, 60) }));
    if (filters.tag) parts.push(tr.t('staff.caseSearch.filter.tag', { tag: filters.tag }));
    return parts.length ? parts.join(' · ') : tr.t('staff.caseSearch.filter.none');
}

/** One result line: code, name, type, member, moderator, date, status. */
export function searchResultLine(row, appealStatus = null, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const day = `<t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:d>`;
    return [
        `\`${row.case_code}\` **${truncate(row.name, 50)}**`,
        `${caseTypeText(row.type, tr)}${row.is_test ? tr.t('staff.caseSearch.test') : ''}`,
        truncate(row.target_username, 32),
        tr.t('staff.caseSearch.by', { name: truncate(row.moderator_username, 32) }),
        day,
        caseStatusLabel(row, appealStatus, { lang: tr.lang }),
    ].join(' · ');
}

export async function buildSearchView(guildId, viewerId, filters, page, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const { rows, total } = await searchCaseRecords(guildId, filters, { page });
    const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
    const current = Math.min(Math.max(0, page), pages - 1);
    const appealStatuses = rows.length ? await getLatestAppealStatusesForCases(rows.map((row) => row.case_code)) : new Map();

    const header = tr.t('staff.caseSearch.filters', { filters: describeSearchFilters(filters, { lang: tr.lang }) });
    const body = rows.length
        ? rows.map((row) => searchResultLine(row, appealStatuses.get(row.case_code), { lang: tr.lang })).join('\n')
        : (total ? tr.t('staff.caseSearch.pageEmpty') : tr.t('staff.caseSearch.noMatch'));

    const embed = createEmbed({
        title: truncate(tr.tp('staff.caseSearch.title', total), 256),
        description: truncate(`${header}\n\n${body}`, 4096),
        // "· ref …" must stay last and untranslated: filtersFromMessage reads it back (REF_PATTERN).
        footer: { text: `${tr.t('staff.caseSearch.footer', { page: current + 1, pages })} · ref ${encodeSearchFilters(filters)}` },
        color: 'primary',
    });

    const components = [];
    if (rows.length) {
        components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`csearch:open:${viewerId}`)
            .setPlaceholder(tr.t('staff.caseSearch.openPlaceholder'))
            .addOptions(rows.map((row) => ({
                label: truncate(`${row.case_code}: ${row.name}`, 100),
                value: row.case_code,
                description: truncate(`${caseTypeText(row.type, tr)} · ${row.target_username} · ${tr.t('staff.caseSearch.by', { name: row.moderator_username })}`, 100),
            })))));
    }
    if (pages > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`csearch:page:${viewerId}:${current - 1}`).setLabel(tr.t('staff.caseSearch.newer'))
                .setStyle(ButtonStyle.Secondary).setDisabled(current <= 0),
            new ButtonBuilder().setCustomId(`csearch:page:${viewerId}:${current + 1}`).setLabel(tr.t('staff.caseSearch.older'))
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
        && Boolean(interaction.guildId) // any server: the view only searches interaction.guildId's cases
        && isAdministrator(interaction.member);
}

export async function handleCaseSearchButton(interaction, client, args) {
    const [step, viewerId, rawPage] = args;
    if (step !== 'page') return;
    const tr = textForInteraction(interaction);
    if (!allowed(interaction, viewerId)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('staff.caseSearch.notYours') });
    }
    const filters = filtersFromMessage(interaction.message);
    if (!filters) {
        return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('staff.caseSearch.unreadable') });
    }
    await interaction.deferUpdate();
    const page = Math.max(0, Number.parseInt(rawPage, 10) || 0);
    await InteractionHelper.safeEditReply(interaction, await buildSearchView(interaction.guildId, viewerId, filters, page, { lang: tr.lang }));
}

export async function handleCaseSearchSelect(interaction, client, args) {
    const [step, viewerId] = args;
    if (step !== 'open') return;
    const tr = textForInteraction(interaction);
    if (!allowed(interaction, viewerId)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('staff.caseSearch.notYours') });
    }
    const code = normalizeCaseCode(interaction.values[0]);
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const record = code && interaction.guildId ? await getCaseByCode(code, interaction.guildId) : null;
    if (!record || record.guild_id !== interaction.guildId) {
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({ title: tr.t('staff.caseSearch.notFoundTitle'), description: tr.t('staff.caseSearch.notFound'), color: 'error' })],
        });
    }
    return InteractionHelper.safeEditReply(interaction, { embeds: [await buildRecordEmbed(record, { client, lang: tr.lang })] });
}
