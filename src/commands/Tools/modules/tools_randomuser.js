import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { localized, publicText, replyText } from '../../../utils/commandLocalizations.js';
import { filterRandomMemberPool, pickFromPool, pickRandomMember } from '../../../services/randomMemberService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('randomuser')
        .setDescription('Select a random user from the server')
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('Limit selection to users with this role')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.randomuser.options.role'))
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('bots')
                .setDescription('Include bots in the selection (default: false)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.randomuser.options.bots'))
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('online')
                .setDescription('Only select from online users (default: false)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.randomuser.options.online'))
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('mention')
                .setDescription('Mention the selected user (default: false)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.randomuser.options.mention'))
                .setRequired(false)),

    async execute(interaction) {
        // The pick is posted in the channel (not ephemeral): the server's language.
        const tr = publicText(interaction);
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`RandomUser interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'randomuser'
            });
            return;
        }

        if (!interaction.guild) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: tr.t('tools.randomuser.guildOnly'),
                context: { lang: tr.lang },
            });
        }

        const role = interaction.options.getRole('role');
        const includeBots = interaction.options.getBoolean('bots') || false;
        const onlineOnly = interaction.options.getBoolean('online') || false;
        const shouldMention = interaction.options.getBoolean('mention') || false;

        // The member cache only holds members seen since startup; pickRandomMember completes it
        // through the member fetch gate and picks from the cache when a full fetch is not allowed.
        let selectedMember;
        let fromCache = false;
        try {
            ({ member: selectedMember, partial: fromCache } = await pickRandomMember(interaction.guild, { roleId: role?.id || null, includeBots, onlineOnly }));
        } catch (error) {
            return replyUserError(interaction, {
                type: error?.type || ErrorTypes.USER_INPUT,
                message: error?.userMessage || tr.t('tools.randomuser.pickFailed'),
                context: { lang: tr.lang },
            });
        }

        const user = selectedMember.user;
        const joinDate = selectedMember.joinedAt;
        const roles = selectedMember.roles.cache
            .filter(role => role.id !== interaction.guild.id)
            .sort((a, b) => b.position - a.position)
            .map(role => role.toString())
            .slice(0, 10);

        const embed = successEmbed(
            tr.t('tools.randomuser.title'),
            shouldMention ? `${selectedMember}` : `**${user.username}**`
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(memberFields(tr, user, roles))
        .setColor(getColor('primary'));
        if (fromCache) embed.setFooter({ text: tr.t('tools.randomuser.fromCache') });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`randomuser_${interaction.user.id}_again`)
                    .setLabel(tr.t('tools.randomuser.again'))
                    .setStyle(ButtonStyle.Primary)
            );

        const response = await interaction.editReply({
            content: shouldMention ? tr.t('tools.randomuser.picked', { member: `${selectedMember}` }) : null,
            embeds: [embed],
            components: [row],
            allowedMentions: { users: shouldMention ? [user.id] : [] }
        });

        const filter = (i) => i.customId === `randomuser_${interaction.user.id}_again` && i.user.id === interaction.user.id;
        const collector = response.createMessageComponentCollector({ filter, time: 300000 });

        collector.on('collect', async (i) => {
            try {
                const newMemberArray = filterRandomMemberPool(interaction.guild.members.cache.values(), { roleId: role?.id || null, includeBots, onlineOnly });

                if (newMemberArray.length === 0) {
                    const trClicker = replyText(i);
                    await replyUserError(i, {
                        type: ErrorTypes.USER_INPUT,
                        message: trClicker.t('tools.randomuser.noMatch'),
                        context: { lang: trClicker.lang },
                    });
                    return;
                }

                const newSelectedMember = pickFromPool(newMemberArray);
                const newUser = newSelectedMember.user;

                const newRoles = newSelectedMember.roles.cache
                    .filter(r => r.id !== interaction.guild.id)
                    .sort((a, b) => b.position - a.position)
                    .map(r => r.toString())
                    .slice(0, 10);

                const newEmbed = successEmbed(
                    tr.t('tools.randomuser.title'),
                    shouldMention ? `${newSelectedMember}` : `**${newUser.username}**`
                )
                .setThumbnail(newUser.displayAvatarURL({ dynamic: true, size: 256 }))
                .addFields(memberFields(tr, newUser, newRoles))
                .setColor(newSelectedMember.displayHexColor || '#3498db');

                await i.update({
                    content: shouldMention ? tr.t('tools.randomuser.picked', { member: `${newSelectedMember}` }) : null,
                    embeds: [newEmbed],
                    components: [row],
                    allowedMentions: { users: shouldMention ? [newUser.id] : [] }
                });

            } catch (error) {
                logger.error('Button interaction error:', error);
                await i.reply({
                    content: replyText(i).t('tools.randomuser.againFailed'),
                    flags: ['Ephemeral']
                });
            }
        });

        collector.on('end', () => {
            const disabledRow = ActionRowBuilder.from(row).setComponents(
                ButtonBuilder.from(row.components[0]).setDisabled(true)
            );

            interaction.editReply({ components: [disabledRow] }).catch(console.error);
        });
    },
};

/** The picked member's fields (the public reply's language). */
export function memberFields(tr, user, roles) {
    return [
        { name: tr.t('tools.randomuser.username'), value: user.username, inline: true },
        { name: tr.t('tools.randomuser.bot'), value: user.bot ? tr.t('tools.randomuser.yes') : tr.t('tools.randomuser.no'), inline: true },
        {
            name: tr.t('tools.randomuser.roles', { count: roles.length }),
            value: roles.length > 0 ? roles.slice(0, 5).join('') + (roles.length > 5 ? tr.t('tools.randomuser.more', { count: roles.length - 5 }) : '') : tr.t('tools.randomuser.noRoles'),
            inline: false,
        },
    ];
}
