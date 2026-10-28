import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { getCaseByName, searchCaseNames } from '../../services/enforcement/caseService.js';
import { query, T, isEnforcementDbAvailable } from '../../services/enforcement/db.js';
import { buildRecordEmbed, buildRecordList, resolveTargetUser } from '../../handlers/backgroundView.js';
import { truncate } from '../../services/enforcement/format.js';

export default {
    // Registered as a guild command in MAIN_GUILD_ID only.
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('background')
        .setDescription("Show a user's enforcement records and staff notes")
        .addUserOption((option) => option
            .setName('user')
            .setDescription('The user to look up'))
        .addStringOption((option) => option
            .setName('user_id')
            .setDescription('User ID, for people no longer in the server')
            .setMinLength(17)
            .setMaxLength(20))
        .addStringOption((option) => option
            .setName('name')
            .setDescription('Open one record by name')
            .setAutocomplete(true)
            .setMaxLength(100)),

    async execute(interaction, config, client) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild for /background', ErrorTypes.PERMISSION,
                'This command only works in the main server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                'You need the Administrator permission to view records.', { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const name = interaction.options.getString('name')?.trim();
        const hasUser = Boolean(interaction.options.getUser('user') || interaction.options.getString('user_id'));

        if (name) {
            const record = await getCaseByName(interaction.guildId, name);
            const targetUser = hasUser ? await resolveTargetUser(interaction, client) : null;
            if (!record || (targetUser && record.target_user_id !== targetUser.id)) {
                throw new TitanBotError('Record not found', ErrorTypes.USER_INPUT,
                    `No record named **${truncate(name, 100)}**${targetUser ? ` for ${targetUser.username}` : ''}.`, { expected: true });
            }
            await InteractionHelper.safeEditReply(interaction, { embeds: [await buildRecordEmbed(record, { client })] });
            return;
        }

        const targetUser = await resolveTargetUser(interaction, client);
        await InteractionHelper.safeEditReply(interaction, await buildRecordList(interaction.guildId, interaction.user.id, targetUser, 0));
    },

    async autocomplete(interaction) {
        if (interaction.guildId !== enforcementConfig.mainGuildId || !isAdministrator(interaction.member)
            || !isEnforcementDbAvailable()) {
            return interaction.respond([]);
        }

        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'name') return interaction.respond([]);

        const userId = interaction.options.get('user')?.value || interaction.options.getString('user_id')?.trim();
        let rows;
        if (userId && /^\d{17,20}$/.test(userId)) {
            rows = await searchCaseNames(interaction.guildId, userId, focused.value);
        } else {
            ({ rows } = await query(
                `SELECT name, type, case_code FROM ${T.cases} WHERE guild_id = $1 AND name ILIKE $2
                 ORDER BY created_at DESC LIMIT 25`,
                [interaction.guildId, `%${String(focused.value || '').replace(/[%_\\]/g, (c) => `\\${c}`)}%`]
            ));
        }

        await interaction.respond(rows.map((row) => ({
            name: truncate(`${row.name} (${row.type}, ${row.case_code})`, 100),
            value: truncate(row.name, 100),
        })));
    },
};
