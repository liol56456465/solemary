import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { localized, publicText } from '../../utils/commandLocalizations.js';

export default {
    data: new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Get detailed information about a user")
    .setDescriptionLocalizations(localized('utility.slash.userinfo.description'))
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("The user to inspect (defaults to you)")
        .setDescriptionLocalizations(localized('utility.slash.userinfo.options.target')),
    ),

  async execute(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`UserInfo interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'userinfo'
      });
      return;
    }

    const user = interaction.options.getUser("target") || interaction.user;
    // The resolved member from the option payload is always present; the cache often isn't.
    const member = interaction.options.getMember("target")
      || (user.id === interaction.user.id ? interaction.member : interaction.guild.members.cache.get(user.id));

    const createdTimestamp = Math.floor(user.createdAt.getTime() / 1000);
    const joinedTimestamp = member?.joinedAt ? Math.floor(member.joinedAt.getTime() / 1000) : null;

    // A public answer: the server's language.
    const tr = publicText(interaction);
    const embed = createEmbed({ title: tr.t('utility.userinfo.title', { name: user.username }) })
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: tr.t('utility.userinfo.id'), value: user.id, inline: true },
        { name: tr.t('utility.userinfo.bot'), value: user.bot ? tr.t('utility.userinfo.yes') : tr.t('utility.userinfo.no'), inline: true },
        {
          name: tr.t('utility.userinfo.roles'),
          value:
            member && member.roles.cache.size > 1
              ? member.roles.cache
                  .map((r) => r.name)
                  .slice(0, 5)
                  .join(",")
              : tr.t('utility.userinfo.none'),
          inline: true,
        },
        {
          name: tr.t('utility.userinfo.created'),
          value: `<t:${createdTimestamp}:R>`,
          inline: false,
        },
        {
          name: tr.t('utility.userinfo.joined'),
          value: joinedTimestamp ? `<t:${joinedTimestamp}:R>` : tr.t('utility.userinfo.notInServer'),
          inline: false,
        },
        {
          name: tr.t('utility.userinfo.highestRole'),
          value: member?.roles?.highest?.name || tr.t('utility.userinfo.none'),
          inline: true,
        },
      );

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    logger.info(`UserInfo command executed`, {
      userId: interaction.user.id,
      targetUserId: user.id,
      guildId: interaction.guildId
    });
  },
};