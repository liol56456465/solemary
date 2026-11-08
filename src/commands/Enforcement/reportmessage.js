import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { reportMessage } from '../../services/automod/memberChecks.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { textForInteraction } from '../../utils/botText.js';

export const REPORT_COOLDOWN_MS = 30 * 1000;
const recentReports = new BoundedMap(5000); // guildId:reporterId → at (bounded: the bot is public)

/** Test hook. */
export function resetReportCooldowns() {
    recentReports.clear();
}

export default {
    // Every server (multi-server B4): the card goes to that server's review channel. Open to every member.
    data: new ContextMenuCommandBuilder()
        .setName('Report message')
        .setType(ApplicationCommandType.Message),

    async execute(interaction) {
        const tr = textForInteraction(interaction); // ephemeral: the reporter's language
        if (!interaction.guildId || !interaction.guild) {
            throw new TitanBotError('Report outside a server', ErrorTypes.PERMISSION, tr.t('staff.reportmessage.serverOnly'), { expected: true });
        }
        const message = interaction.targetMessage;
        if (message.author.bot || message.author.id === interaction.user.id) {
            throw new TitanBotError('Invalid report', ErrorTypes.USER_INPUT, tr.t('staff.reportmessage.ownMessage'), { expected: true });
        }
        const cooldownKey = `${interaction.guildId}:${interaction.user.id}`;
        const last = recentReports.get(cooldownKey) || 0;
        if (Date.now() - last < REPORT_COOLDOWN_MS) {
            throw new TitanBotError('Report cooldown', ErrorTypes.RATE_LIMIT, tr.t('staff.reportmessage.cooldown'), { expected: true });
        }
        recentReports.set(cooldownKey, Date.now());

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const card = await reportMessage(message, interaction.user);
        if (!card) {
            // No review channel (or mod log) set in this server, or the post failed: say so, never "sent".
            throw new TitanBotError('Report not delivered', ErrorTypes.USER_INPUT,
                tr.t('staff.reportmessage.notDelivered'), { expected: true });
        }
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('staff.reportmessage.sentTitle'), tr.t('staff.reportmessage.sent'))],
        });
    },
};
