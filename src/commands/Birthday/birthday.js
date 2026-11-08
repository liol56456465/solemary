import { SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { describe } from '../../utils/commandLocalizations.js';

import birthdaySet from './modules/birthday_set.js';
import birthdayInfo from './modules/birthday_info.js';
import birthdayList from './modules/birthday_list.js';
import birthdayRemove from './modules/birthday_remove.js';
import nextBirthdays from './modules/next_birthdays.js';
import birthdaySetchannel from './modules/birthday_setchannel.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { searchTimeZones } from '../../utils/timezone.js';
export default {
    data: describe(new SlashCommandBuilder().setName('birthday'), 'birthday.cmd.birthday')
        .addSubcommand(subcommand =>
            describe(subcommand.setName('set'), 'birthday.cmd.set')
                .addIntegerOption(option =>
                    describe(option.setName('month'), 'birthday.cmd.month')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(12)
                )
                .addIntegerOption(option =>
                    describe(option.setName('day'), 'birthday.cmd.day')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(31)
                )
        )
        .addSubcommand(subcommand =>
            describe(subcommand.setName('info'), 'birthday.cmd.info')
                .addUserOption(option =>
                    describe(option.setName('user'), 'birthday.cmd.infoUser')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            describe(subcommand.setName('list'), 'birthday.cmd.list')
        )
        .addSubcommand(subcommand =>
            describe(subcommand.setName('remove'), 'birthday.cmd.remove')
        )
        .addSubcommand(subcommand =>
            describe(subcommand.setName('next'), 'birthday.cmd.next')
        )
        .addSubcommand(subcommand =>
            describe(subcommand.setName('setchannel'), 'birthday.cmd.setchannel')
                .addChannelOption(option =>
                    describe(option.setName('channel'), 'birthday.cmd.channel')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(false)
                )
                .addStringOption(option =>
                    describe(option.setName('timezone'), 'birthday.cmd.timezone')
                        .setAutocomplete(true)
                        .setRequired(false)
                )
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'timezone') return interaction.respond([]);
        return interaction.respond(searchTimeZones(focused.value).map(zone => ({ name: zone, value: zone })));
    },

    async execute(interaction, config, client) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'set':
                return await birthdaySet.execute(interaction, config, client);
            case 'info':
                return await birthdayInfo.execute(interaction, config, client);
            case 'list':
                return await birthdayList.execute(interaction, config, client);
            case 'remove':
                return await birthdayRemove.execute(interaction, config, client);
            case 'next':
                return await nextBirthdays.execute(interaction, config, client);
            case 'setchannel':
                return await birthdaySetchannel.execute(interaction, config, client);
            default:
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: textForInteraction(interaction).t('birthday.unknownSubcommand') });
        }
    }
};
