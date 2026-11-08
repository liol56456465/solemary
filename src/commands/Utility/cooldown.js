// /cooldown: put yourself in a Discord timeout for a while, to take a break
// (services/members/selfCooldownService.js). Everyone may use it; it only ever affects
// the invoker. Every reply is private. A confirm step comes first (selfcooldown buttons).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botText } from '../../utils/botText.js';
import { localized, replyText } from '../Core/modules/commandText.js';
import {
    BUTTON_PREFIX, COOLDOWN_DURATIONS, LIMIT_PER_WINDOW, REASON_MAX, checkLimit, createPrompt, promptText, refusalFor,
} from '../../services/members/selfCooldownService.js';

const NO_MENTIONS = { parse: [] };

/** The duration labels in the catalog (one literal key per COOLDOWN_DURATIONS entry). */
export const DURATION_KEYS = Object.freeze({
    '1h': 'utility.cooldown.duration.1h', '6h': 'utility.cooldown.duration.6h', '12h': 'utility.cooldown.duration.12h',
    '1d': 'utility.cooldown.duration.1d', '3d': 'utility.cooldown.duration.3d', '7d': 'utility.cooldown.duration.7d',
});

/** A duration's label in a language (falls back to the service's English label). */
export function durationLabel(durationKey, tr = botText('en')) {
    return DURATION_KEYS[durationKey] ? tr.t(DURATION_KEYS[durationKey]) : COOLDOWN_DURATIONS[durationKey]?.label;
}

export function confirmButtons(userId, nonce, tr = botText('en')) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}:start:${userId}:${nonce}`).setLabel(tr.t('utility.cooldown.start')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}:cancel:${userId}:${nonce}`).setLabel(tr.t('utility.cooldown.cancel')).setStyle(ButtonStyle.Secondary),
    );
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('cooldown')
        .setDescription('Take a break: put yourself in a timeout for a while')
        .setDescriptionLocalizations(localized('utility.slash.cooldown.description'))
        .addStringOption((o) => o.setName('duration').setDescription('How long')
            .setDescriptionLocalizations(localized('utility.slash.cooldown.options.duration')).setRequired(true)
            .addChoices(...Object.entries(COOLDOWN_DURATIONS).map(([value, { label }]) => ({ name: label, value }))))
        .addStringOption((o) => o.setName('reason').setDescription('Why (optional; only staff see it)')
            .setDescriptionLocalizations(localized('utility.slash.cooldown.options.reason')).setMaxLength(REASON_MAX)),

    async execute(interaction) {
        // Every reply is private: the user's language. (The prompt body and refusals come from
        // selfCooldownService.js and are English for now.)
        const tr = replyText(interaction);
        const reply = (description, color = 'warning', title = tr.t('utility.cooldown.title'), components = []) => InteractionHelper.safeReply(interaction, {
            embeds: [createEmbed({ title, description, color })], components, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS,
        });
        if (!interaction.inGuild?.() || !interaction.guild) {
            return reply(tr.t('utility.cooldown.serverOnly'));
        }
        const durationKey = interaction.options.getString('duration', true);
        if (!COOLDOWN_DURATIONS[durationKey]) return reply(tr.t('utility.cooldown.pickDuration'));
        const reason = (interaction.options.getString('reason') || '').trim().slice(0, REASON_MAX) || null;

        const { guild, user } = interaction;
        // The interaction carries the member (no API call, so the reply stays inside 3 s).
        const member = interaction.member?.roles?.highest ? interaction.member : await guild.members.fetch(user.id).catch(() => null);
        if (!member) return reply(tr.t('utility.cooldown.notFound'));
        const refusal = refusalFor({ guild, member, botMember: guild.members.me });
        if (refusal) return reply(refusal);
        const limited = checkLimit(guild.id, user.id);
        if (limited) {
            return reply(tr.t('utility.cooldown.limited', { limit: LIMIT_PER_WINDOW, when: `<t:${Math.floor(limited.nextAt / 1000)}:R>` }));
        }

        const nonce = createPrompt({ userId: user.id, guildId: guild.id, durationKey, reason });
        return reply(promptText(durationKey, reason), 'warning', tr.t('utility.cooldown.confirmTitle'), [confirmButtons(user.id, nonce, tr)]);
    },
};
