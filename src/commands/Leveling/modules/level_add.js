import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
import { checkUserPermissions } from '../../../utils/permissionGuard.js';
import { addLevels, getLevelingConfig } from '../../../services/leveling/leveling.js';
import { createEmbed } from '../../../utils/embeds.js';
import { roleSyncNote, syncLevelRolesForMember } from '../../../services/leveling/levelRoleSyncService.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { textForInteraction } from '../../../utils/botText.js';
import { describe } from '../../../utils/commandLocalizations.js';
export default {
  data: describe(new SlashCommandBuilder().setName('leveladd'), 'leveling.cmd.leveladd.description')
    .addUserOption((option) =>
      describe(option.setName('user'), 'leveling.cmd.leveladd.user')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      describe(option.setName('levels'), 'leveling.cmd.leveladd.levels')
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
    const levelsToAdd = interaction.options.getInteger('levels');

    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      throw new TitanBotError(
        `User ${targetUser.id} not found in this guild`,
        ErrorTypes.USER_INPUT,
        tr.t('leveling.notInServer')
      );
    }

    const userData = await addLevels(client, interaction.guildId, targetUser.id, levelsToAdd);

    // Reward roles follow the new level (reward mode; roles above the level come off).
    const roleSync = await syncLevelRolesForMember(client, member, {
      level: userData.level,
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
          title: pub.t('leveling.change.addedTitle'),
          description: `${pub.t('leveling.change.added', { levels: levelsToAdd, user: targetUser.tag, level: userData.level })}${roleNote ? `\n${roleNote}` : ''}`,
          color: 'success'
        })
      ]
    });

    logger.info(
      `[ADMIN] User ${interaction.user.tag} added ${levelsToAdd} levels to ${targetUser.tag} in guild ${interaction.guildId}`
    );
  }
};