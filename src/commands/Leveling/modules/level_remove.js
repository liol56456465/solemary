import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
import { checkUserPermissions } from '../../../utils/permissionGuard.js';
import { removeLevels, getUserLevelData, getLevelingConfig } from '../../../services/leveling/leveling.js';
import { createEmbed } from '../../../utils/embeds.js';
import { roleSyncNote, syncLevelRolesForMember } from '../../../services/leveling/levelRoleSyncService.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { textForInteraction } from '../../../utils/botText.js';
import { describe } from '../../../utils/commandLocalizations.js';
export default {
  data: describe(new SlashCommandBuilder().setName('levelremove'), 'leveling.cmd.levelremove.description')
    .addUserOption((option) =>
      describe(option.setName('user'), 'leveling.cmd.levelremove.user')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      describe(option.setName('levels'), 'leveling.cmd.levelremove.levels')
        .setRequired(true)
        .setMinValue(1)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  category: 'Leveling',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);
    // The result is posted in the channel (server language); refusals go to the user (their language).
    const tr = textForInteraction(interaction);
    const pub = textForInteraction(interaction, { purpose: 'public' });

    const hasPermission = await checkUserPermissions(
      interaction,
      PermissionFlagsBits.ManageGuild,
      tr.t('leveling.change.manageGuild')
    );
    if (!hasPermission) return;

    const levelingConfig = await getLevelingConfig(client, interaction.guildId);
    if (!levelingConfig?.enabled) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setColor('#f1c40f')
            .setDescription(pub.t('leveling.disabled'))
        ],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const targetUser = interaction.options.getUser('user');
    const levelsToRemove = interaction.options.getInteger('levels');

    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      throw new TitanBotError(
        `User ${targetUser.id} not found in this guild`,
        ErrorTypes.USER_INPUT,
        tr.t('leveling.notInServer')
      );
    }

    const userData = await getUserLevelData(client, interaction.guildId, targetUser.id);
    if (userData.level === 0) {
      throw new TitanBotError(
        `User ${targetUser.id} is already at minimum level`,
        ErrorTypes.VALIDATION,
        tr.t('leveling.change.atZero', { user: targetUser.tag })
      );
    }

    const updatedData = await removeLevels(client, interaction.guildId, targetUser.id, levelsToRemove);

    // Reward roles follow the new level (reward mode; roles above the level come off).
    const roleSync = await syncLevelRolesForMember(client, member, {
      level: updatedData.level,
      removeUnearned: true,
      reason: `Level changed by ${interaction.user.tag}`,
    }).catch((error) => {
      logger.warn(`Level reward roles not synced for ${targetUser.id} in guild ${interaction.guildId}: ${error.message}`);
      return { added: [], removed: [], skipped: [], errors: 1 };
    });
    const roleNote = roleSyncNote(roleSync, { lang: pub.lang });

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        createEmbed({
          title: pub.t('leveling.change.removedTitle'),
          description: `${pub.t('leveling.change.removed', { levels: levelsToRemove, user: targetUser.tag, level: updatedData.level })}${roleNote ? `\n${roleNote}` : ''}`,
          color: 'success'
        })
      ]
    });

    logger.info(
      `[ADMIN] User ${interaction.user.tag} removed ${levelsToRemove} levels from ${targetUser.tag} in guild ${interaction.guildId}`
    );
  }
};