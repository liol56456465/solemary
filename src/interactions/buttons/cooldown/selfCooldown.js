// selfcooldown:<start|cancel>:<userId>:<nonce> — the confirm step of /cooldown.
// Only the member who ran /cooldown may click; the prompt lives 5 minutes (in memory).
// Eligibility and the 3-per-24h limit are checked again on Start (things may have changed).

import { MessageFlags } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import {
    BUTTON_PREFIX, COOLDOWN_DURATIONS, EXPIRED_MESSAGE, LIMIT_PER_WINDOW, applySelfCooldown, checkLimit, refusalFor, takePrompt,
} from '../../../services/members/selfCooldownService.js';

const NO_MENTIONS = { parse: [] };
// guildId:userId with a Start being applied right now: a burst of clicks on several prompts
// would otherwise all pass the checks before the first timeout lands (and beat the limit).
const applying = new Set();
const result = (description, color = 'warning', title = 'Cooldown') => ({
    embeds: [createEmbed({ title, description, color })], components: [], allowedMentions: NO_MENTIONS,
});

export default {
    name: BUTTON_PREFIX,
    // (interaction, client, args) from the dispatcher; the 4th argument is for tests.
    async execute(interaction, client, args = [], { apply = applySelfCooldown } = {}) {
        const [action, userId, nonce] = args;
        if (!userId || interaction.user.id !== userId) {
            return interaction.reply({ content: 'This button is not for you. Run /cooldown yourself if you want a break.', flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
        }
        // Acknowledge first (3 s); the result replaces the prompt and removes its buttons.
        await interaction.deferUpdate();
        const prompt = takePrompt(nonce);
        if (!prompt || prompt.userId !== userId || prompt.guildId !== interaction.guildId) {
            return interaction.editReply(result(EXPIRED_MESSAGE));
        }
        if (action !== 'start') {
            return interaction.editReply(result('No cooldown was started.', 'info', 'Cancelled'));
        }

        const guild = interaction.guild;
        const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
        if (!member) return interaction.editReply(result('I could not find you in this server, so no cooldown was started.'));
        const refusal = refusalFor({ guild, member, botMember: guild.members.me });
        if (refusal) return interaction.editReply(result(`${refusal}\n\nNo cooldown was started.`));
        const limited = checkLimit(guild.id, userId);
        if (limited) {
            return interaction.editReply(result(`You have started ${LIMIT_PER_WINDOW} cooldowns in the last 24 hours. You can start another <t:${Math.floor(limited.nextAt / 1000)}:R>.`));
        }

        const key = `${guild.id}:${userId}`;
        if (applying.has(key)) return interaction.editReply(result('A cooldown is already being started for you, so this one was not.'));
        applying.add(key);
        let until;
        try {
            ({ until } = await apply({ client, guild, member, durationKey: prompt.durationKey, reason: prompt.reason }));
        } catch (error) {
            logger.warn(`Self-cooldown for ${userId} in ${guild.id} failed: ${error.message}`);
            return interaction.editReply(result('Discord refused the timeout, so no cooldown was started. Ask staff to check my permissions and role position.', 'error'));
        } finally {
            applying.delete(key);
        }
        const unix = Math.floor(until / 1000);
        return interaction.editReply(result(
            `Your ${COOLDOWN_DURATIONS[prompt.durationKey].label} cooldown has started. It ends on its own <t:${unix}:F> (<t:${unix}:R>). Take care.`,
            'success', 'Cooldown started',
        ));
    },
};
