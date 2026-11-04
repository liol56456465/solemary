// /cooldown: put yourself in a Discord timeout for a while, to take a break
// (services/members/selfCooldownService.js). Everyone may use it; it only ever affects
// the invoker. Every reply is private. A confirm step comes first (selfcooldown buttons).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    BUTTON_PREFIX, COOLDOWN_DURATIONS, LIMIT_PER_WINDOW, REASON_MAX, checkLimit, createPrompt, promptText, refusalFor,
} from '../../services/members/selfCooldownService.js';

const NO_MENTIONS = { parse: [] };

export function confirmButtons(userId, nonce) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}:start:${userId}:${nonce}`).setLabel('Start cooldown').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}:cancel:${userId}:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('cooldown')
        .setDescription('Take a break: put yourself in a timeout for a while')
        .addStringOption((o) => o.setName('duration').setDescription('How long').setRequired(true)
            .addChoices(...Object.entries(COOLDOWN_DURATIONS).map(([value, { label }]) => ({ name: label, value }))))
        .addStringOption((o) => o.setName('reason').setDescription('Why (optional; only staff see it)').setMaxLength(REASON_MAX)),

    async execute(interaction) {
        const reply = (description, color = 'warning', title = 'Cooldown', components = []) => InteractionHelper.safeReply(interaction, {
            embeds: [createEmbed({ title, description, color })], components, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS,
        });
        if (!interaction.inGuild?.() || !interaction.guild) {
            return reply('/cooldown only works in a server.');
        }
        const durationKey = interaction.options.getString('duration', true);
        if (!COOLDOWN_DURATIONS[durationKey]) return reply('Pick one of the listed durations.');
        const reason = (interaction.options.getString('reason') || '').trim().slice(0, REASON_MAX) || null;

        const { guild, user } = interaction;
        // The interaction carries the member (no API call, so the reply stays inside 3 s).
        const member = interaction.member?.roles?.highest ? interaction.member : await guild.members.fetch(user.id).catch(() => null);
        if (!member) return reply('I could not find you in this server. Try again in a moment.');
        const refusal = refusalFor({ guild, member, botMember: guild.members.me });
        if (refusal) return reply(refusal);
        const limited = checkLimit(guild.id, user.id);
        if (limited) {
            return reply(`You have started ${LIMIT_PER_WINDOW} cooldowns in the last 24 hours. You can start another <t:${Math.floor(limited.nextAt / 1000)}:R>.`);
        }

        const nonce = createPrompt({ userId: user.id, guildId: guild.id, durationKey, reason });
        return reply(promptText(durationKey, reason), 'warning', 'Start a cooldown?', [confirmButtons(user.id, nonce)]);
    },
};
