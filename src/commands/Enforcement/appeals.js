import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { buildCaseDossier, decideAppeal, listPendingAppeals } from '../../services/enforcement/appealService.js';
import { getCaseByCode } from '../../services/enforcement/caseService.js';
import { dateStamp, normalizeCaseCode, truncate } from '../../services/enforcement/format.js';

async function showPending(interaction) {
    const pending = await listPendingAppeals();
    const lines = pending.map((row) =>
        `\`${row.case_code}\` **${row.type}**${row.is_test ? ' (test)' : ''} ${row.username} (\`${row.user_id}\`), filed ${dateStamp(row.created_at)}`
        + `${row.channel_id ? ` in <#${row.channel_id}>` : ''}`);
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
            title: `Pending appeals (${pending.length})`,
            description: truncate(lines.length
                ? `${lines.join('\n')}\n\nSee a case with \`/appeals code:<code>\`, decide with \`decision:accept|deny\`.`
                : 'There are no pending appeals.', 4096),
            color: 'primary',
        })],
    });
}

export default {
    // Registered as a guild command in MAIN_GUILD_ID only.
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('appeals')
        .setDescription('List pending appeals, see a case in full, or accept/deny an appeal')
        .addStringOption((option) => option
            .setName('code')
            .setDescription('Case code. Leave empty to list pending appeals')
            .setMinLength(5)
            .setMaxLength(7))
        .addStringOption((option) => option
            .setName('decision')
            .setDescription('Accept lifts the punishment; deny keeps it. Leave empty to only view the case')
            .addChoices({ name: 'accept', value: 'accept' }, { name: 'deny', value: 'deny' }))
        .addStringOption((option) => option
            .setName('note')
            .setDescription('Optional note, shown in the appeal channel and the log')
            .setMaxLength(500)),

    async execute(interaction, config, client) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild for /appeals', ErrorTypes.PERMISSION,
                'This command only works in the main server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                'You need the Administrator permission to review appeals.', { expected: true });
        }

        const rawCode = interaction.options.getString('code');
        const decision = interaction.options.getString('decision');
        const caseCode = rawCode ? normalizeCaseCode(rawCode) : null;
        if (rawCode && !caseCode) {
            throw new TitanBotError('Invalid case code', ErrorTypes.USER_INPUT,
                'That is not a valid case code (5–7 letters and digits).', { expected: true });
        }
        if (decision && !caseCode) {
            throw new TitanBotError('Decision without code', ErrorTypes.USER_INPUT,
                'Give the case code of the appeal you want to decide.', { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (!caseCode) return showPending(interaction);

        if (!decision) {
            const record = await getCaseByCode(caseCode);
            if (!record) {
                throw new TitanBotError('Unknown case code', ErrorTypes.USER_INPUT,
                    `No case with code \`${caseCode}\`.`, { expected: true });
            }
            return InteractionHelper.safeEditReply(interaction, { embeds: await buildCaseDossier(record, { client }) });
        }

        const result = await decideAppeal({
            client,
            admin: interaction.user,
            caseCode,
            decision,
            note: interaction.options.getString('note')?.trim() || null,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                `Appeal ${result.label}`,
                [
                    `\`${caseCode}\` — ${result.record.name}`,
                    `DM to the user: ${result.dmDelivered ? 'delivered' : '**not delivered**'}.`,
                    ...result.notes,
                ].join('\n')
            )],
        });
    },
};
