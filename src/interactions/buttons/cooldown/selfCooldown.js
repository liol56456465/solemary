// selfcooldown:<start|cancel>:<userId>:<nonce> — the confirm step of /cooldown.
// Only the member who ran /cooldown may click; the prompt lives 5 minutes (in memory).
// Eligibility and the 3-per-24h limit are checked again on Start (things may have changed).

import { MessageFlags } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { botText } from '../../../utils/botText.js';
import { replyText } from '../../../utils/commandLocalizations.js';
import { durationLabel } from '../../../commands/Utility/cooldown.js';
import {
    BUTTON_PREFIX, LIMIT_PER_WINDOW, applySelfCooldown, checkLimit, refusalFor, takePrompt,
} from '../../../services/members/selfCooldownService.js';

const NO_MENTIONS = { parse: [] };
// guildId:userId with a Start being applied right now: a burst of clicks on several prompts
// would otherwise all pass the checks before the first timeout lands (and beat the limit).
const applying = new Set();
const result = (description, color = 'warning', title = botText('en').t('utility.cooldown.title')) => ({
    embeds: [createEmbed({ title, description, color })], components: [], allowedMentions: NO_MENTIONS,
});

export default {
    name: BUTTON_PREFIX,
    // (interaction, client, args) from the dispatcher; the 4th argument is for tests.
    async execute(interaction, client, args = [], { apply = applySelfCooldown } = {}) {
        const [action, userId, nonce] = args;
        // Every answer is private: the clicker's language. (Refusals from selfCooldownService.js stay English.)
        const tr = replyText(interaction);
        const title = tr.t('utility.cooldown.title');
        if (!userId || interaction.user.id !== userId) {
            return interaction.reply({ content: tr.t('utility.cooldown.notYours'), flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
        }
        // Acknowledge first (3 s); the result replaces the prompt and removes its buttons.
        await interaction.deferUpdate();
        const prompt = takePrompt(nonce);
        if (!prompt || prompt.userId !== userId || prompt.guildId !== interaction.guildId) {
            return interaction.editReply(result(tr.t('utility.cooldown.expired'), 'warning', title));
        }
        if (action !== 'start') {
            return interaction.editReply(result(tr.t('utility.cooldown.notStarted'), 'info', tr.t('utility.cooldown.cancelledTitle')));
        }

        const guild = interaction.guild;
        const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
        if (!member) return interaction.editReply(result(tr.t('utility.cooldown.notFoundButton'), 'warning', title));
        const refusal = refusalFor({ guild, member, botMember: guild.members.me });
        if (refusal) return interaction.editReply(result(`${refusal}\n\n${tr.t('utility.cooldown.notStarted')}`, 'warning', title));
        const limited = checkLimit(guild.id, userId);
        if (limited) {
            return interaction.editReply(result(tr.t('utility.cooldown.limited', { limit: LIMIT_PER_WINDOW, when: `<t:${Math.floor(limited.nextAt / 1000)}:R>` }), 'warning', title));
        }

        const key = `${guild.id}:${userId}`;
        if (applying.has(key)) return interaction.editReply(result(tr.t('utility.cooldown.alreadyStarting'), 'warning', title));
        applying.add(key);
        let until;
        try {
            ({ until } = await apply({ client, guild, member, durationKey: prompt.durationKey, reason: prompt.reason }));
        } catch (error) {
            logger.warn(`Self-cooldown for ${userId} in ${guild.id} failed: ${error.message}`);
            return interaction.editReply(result(tr.t('utility.cooldown.refused'), 'error', title));
        } finally {
            applying.delete(key);
        }
        const unix = Math.floor(until / 1000);
        return interaction.editReply(result(
            tr.t('utility.cooldown.started', { duration: durationLabel(prompt.durationKey, tr), date: `<t:${unix}:F>`, relative: `<t:${unix}:R>` }),
            'success', tr.t('utility.cooldown.startedTitle'),
        ));
    },
};
