import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { WIPE_ITEMS } from '../../services/wipedataService.js';
import { botText } from '../../utils/botText.js';
import { localized, replyText } from '../../utils/commandLocalizations.js';

/** The catalog label of each wipe item (one literal key per WIPE_ITEMS id; legacy items are never shown). */
const ITEM_KEYS = Object.freeze({
    levels: 'utility.wipedata.item.levels', birthday: 'utility.wipedata.item.birthday', todo: 'utility.wipedata.item.todo',
    reminders: 'utility.wipedata.item.reminders', oauth: 'utility.wipedata.item.oauth', dmlog: 'utility.wipedata.item.dmlog',
    invites: 'utility.wipedata.item.invites',
});

/** A wipe item's label in a language (an id without a catalog key: the service's English label, else the id). */
export function wipeItemLabel(id, tr = botText('en')) {
    return ITEM_KEYS[id] ? tr.t(ITEM_KEYS[id]) : WIPE_ITEMS.find((item) => item.id === id)?.label || id;
}

/** The confirmation prompt text. Pure, for tests. */
export function wipeWarningText(tr = botText('en')) {
    return tr.t('utility.wipedata.intro') + '\n'
        + WIPE_ITEMS.filter((item) => !item.legacy).map((item) => `- ${wipeItemLabel(item.id, tr)}`).join('\n')
        + '\n\n' + tr.t('utility.wipedata.body') + '\n\n' + tr.t('utility.wipedata.final');
}
export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('wipedata')
        .setDescription('Delete your levels, birthday, to-do list, reminders and login token (cannot be undone)')
        .setDescriptionLocalizations(localized('utility.slash.wipedata.description')),

    async execute(interaction, guildConfig, client) {
        // A private prompt: the user's language.
        const tr = replyText(interaction);
        const embed = warningEmbed(tr.t('utility.wipedata.title'), wipeWarningText(tr));

        // Same ids and styles as utils/components.js getConfirmationButtons('wipedata'), with translated labels.
        const confirmButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('wipedata_yes').setLabel(tr.t('utility.wipedata.confirm')).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('wipedata_no').setLabel(tr.t('utility.wipedata.cancel')).setStyle(ButtonStyle.Danger),
        );

        await InteractionHelper.safeReply(interaction, {
            embeds: [embed],
            components: [confirmButtons],
            flags: MessageFlags.Ephemeral
        });

        logger.info(`Wipedata command executed - confirmation prompt shown`, {
            userId: interaction.user.id,
            guildId: interaction.guildId
        });
    }
};