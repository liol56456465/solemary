// /serverdata delete — the server's owner asks for everything Mewvo stores for this server to be
// deleted (owner decision 2026-11-07; services/privacy/serverDataDeletion.js does the work).
//
// Access: registered like any admin command (commandGate: Administrator), then ONLY the server's
// owner (guild.ownerId fetched fresh from Discord) — not admins, not OWNER_IDS. Mewvo's own servers
// are refused. Flow: a private preview with the counts per kind → [Delete data] [Delete data and
// remove Mewvo] [Cancel] → scheduled 7 days later, with [Cancel deletion]. Running it again while
// a deletion is scheduled shows that one (and its Cancel button).
// Buttons: serverdata:<confirm|leave|dismiss|cancel>:<ownerId> (interactions/buttons/serverdata).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { botText } from '../../utils/botText.js';
import { logger } from '../../utils/logger.js';
import { localized, replyText } from '../../utils/commandLocalizations.js';
import { KINDS } from '../../services/privacy/serverDataInventory.js';
import {
    GRACE_DAYS, checkServerOwner, getDeletionRequest, isPending, previewServerData,
} from '../../services/privacy/serverDataDeletion.js';

export const SERVERDATA_BUTTON = 'serverdata';
const NO_MENTIONS = Object.freeze({ parse: [] });

/** One literal catalog key per kind (the key test reads them). */
export const KIND_KEYS = Object.freeze({
    cases: 'serverdata.kind.cases', appeals: 'serverdata.kind.appeals', moderation: 'serverdata.kind.moderation',
    settings: 'serverdata.kind.settings', logs: 'serverdata.kind.logs', levels: 'serverdata.kind.levels',
    tickets: 'serverdata.kind.tickets', automod: 'serverdata.kind.automod', snapshots: 'serverdata.kind.snapshots',
    community: 'serverdata.kind.community', verification: 'serverdata.kind.verification', oauthLinks: 'serverdata.kind.oauthLinks',
    insights: 'serverdata.kind.insights', audit: 'serverdata.kind.audit', kv: 'serverdata.kind.kv', misc: 'serverdata.kind.misc',
});

const REFUSAL_KEYS = Object.freeze({
    home: 'serverdata.refuse.home', badId: 'serverdata.refuse.home', notOwner: 'serverdata.refuse.notOwner',
    unknown: 'serverdata.refuse.unknown', stale: 'serverdata.refuse.unknown',
});

export const refusalText = (reason, tr = botText('en')) => tr.t(REFUSAL_KEYS[reason] || 'serverdata.refuse.notOwner');

export const buttonId = (action, ownerId) => `${SERVERDATA_BUTTON}:${action}:${ownerId}`;

/** The preview message (pure, for tests): counts per kind, the notes, the three buttons. */
export function previewMessage(preview, ownerId, tr = botText('en')) {
    const lines = KINDS.filter((kind) => preview.kinds[kind] > 0)
        .map((kind) => tr.t('serverdata.preview.line', { label: tr.t(KIND_KEYS[kind]), count: new Intl.NumberFormat(tr.lang).format(preview.kinds[kind]) }));
    const description = [
        lines.length ? `${tr.t('serverdata.preview.intro')}\n${lines.join('\n')}` : tr.t('serverdata.preview.empty'),
        tr.t('serverdata.preview.record'),
        tr.t('serverdata.preview.active'),
        tr.t('serverdata.preview.untouched'),
        tr.t('serverdata.preview.grace', { days: GRACE_DAYS }),
    ].join('\n\n');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(buttonId('confirm', ownerId)).setLabel(tr.t('serverdata.button.confirm')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(buttonId('leave', ownerId)).setLabel(tr.t('serverdata.button.confirmLeave')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(buttonId('dismiss', ownerId)).setLabel(tr.t('serverdata.button.dismiss')).setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [createEmbed({ title: tr.t('serverdata.preview.title'), description: description.slice(0, 4000), color: 'warning' })], components: [row], allowedMentions: NO_MENTIONS };
}

/** A pending request (scheduled or running): when, and [Cancel deletion] while it can be cancelled. */
export function scheduledMessage(record, ownerId, tr = botText('en'), { already = false } = {}) {
    const unix = Math.floor(Date.parse(record.dueAt) / 1000);
    const running = record.status === 'running';
    const parts = [
        already ? tr.t('serverdata.scheduled.already') : null,
        running ? tr.t('serverdata.scheduled.running') : tr.t('serverdata.scheduled.body', { unix }),
        record.removeBot && !running ? tr.t('serverdata.scheduled.leave') : null,
        running ? null : tr.t('serverdata.scheduled.hint'),
    ].filter(Boolean);
    const components = running ? [] : [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(buttonId('cancel', ownerId)).setLabel(tr.t('serverdata.button.cancelDeletion')).setStyle(ButtonStyle.Secondary))];
    return { embeds: [createEmbed({ title: tr.t('serverdata.scheduled.title'), description: parts.join('\n\n'), color: 'warning' })], components, allowedMentions: NO_MENTIONS };
}

export const plainMessage = (text) => ({ content: text, embeds: [], components: [], allowedMentions: NO_MENTIONS });

/** The command body, with the services injectable for tests. */
export async function runServerDataCommand(interaction, client, {
    check = checkServerOwner, getRequest = getDeletionRequest, preview = previewServerData,
} = {}) {
    const tr = replyText(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const ok = await check({ client, guildId, userId });
    if (!ok.allowed) {
        logger.info(`/serverdata delete refused for ${userId} in ${guildId}: ${ok.reason}`);
        return interaction.editReply(plainMessage(refusalText(ok.reason, tr)));
    }
    try {
        const record = await getRequest(guildId);
        if (isPending(record)) return interaction.editReply(scheduledMessage(record, userId, tr));
        return interaction.editReply(previewMessage(await preview(guildId), userId, tr));
    } catch (error) {
        logger.error(`/serverdata delete in ${guildId}: ${error.message}`);
        return interaction.editReply(plainMessage(tr.t('serverdata.refuse.database')));
    }
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('serverdata')
        .setDescription(botText('en').t('serverdata.slash.description'))
        .setDescriptionLocalizations(localized('serverdata.slash.description'))
        .addSubcommand((sub) => sub
            .setName('delete')
            .setDescription(botText('en').t('serverdata.slash.delete.description'))
            .setDescriptionLocalizations(localized('serverdata.slash.delete.description'))),

    async execute(interaction, _guildConfig, client) {
        return runServerDataCommand(interaction, client);
    },
};
