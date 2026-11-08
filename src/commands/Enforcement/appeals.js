import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { decisionResultEmbed } from '../../handlers/appealsHandler.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { buildCaseDossier, caseTypeIn, decideAppeal, isCaseOfCallerServer, listPendingAppeals } from '../../services/enforcement/appealService.js';
import { getCaseByCode } from '../../services/enforcement/caseService.js';
import { dateStamp, normalizeCaseCode, truncate } from '../../services/enforcement/format.js';

// Every answer is ephemeral: the admin's Discord language (utils/botText.js 'reply').

/** The pending-appeals list as an embed. Pure (tests). */
export function pendingAppealsEmbed(pending, tr) {
    const lines = pending.map((row) => tr.t('staff.appeals.pending.line', {
        code: row.case_code,
        type: caseTypeIn(row.type, { lang: tr.lang }),
        test: row.is_test ? tr.t('staff.appeals.pending.test') : '',
        username: row.username,
        userId: row.user_id,
        date: dateStamp(row.created_at),
        where: row.channel_id ? tr.t('staff.appeals.pending.inChannel', { channelId: row.channel_id }) : '',
    }));
    return createEmbed({
        title: truncate(tr.t('staff.appeals.pending.title', { count: pending.length }), 256),
        description: truncate(lines.length
            ? `${lines.join('\n')}\n\n${tr.t('staff.appeals.pending.hint')}`
            : tr.t('staff.appeals.pending.none'), 4096),
        color: 'primary',
    });
}

async function showPending(interaction, tr) {
    const pending = await listPendingAppeals(20, interaction.guildId);
    await InteractionHelper.safeEditReply(interaction, { embeds: [pendingAppealsEmbed(pending, tr)] });
}

export default {
    // Every server (B2 global commands); each server sees and decides only its own appeals.
    data: new SlashCommandBuilder()
        .setName('appeals')
        .setDescription('List pending appeals, see a case in full, or accept/deny an appeal')
        .setDescriptionLocalizations(descriptionLocalizations('staff.appeals.cmd.description'))
        .addStringOption((option) => option
            .setName('code')
            .setDescription('Case code. Leave empty to list pending appeals')
            .setDescriptionLocalizations(descriptionLocalizations('staff.appeals.cmd.code'))
            .setMinLength(5)
            .setMaxLength(7))
        .addStringOption((option) => option
            .setName('decision')
            .setDescription('Accept lifts the punishment; deny keeps it. Leave empty to only view the case')
            .setDescriptionLocalizations(descriptionLocalizations('staff.appeals.cmd.decision'))
            .addChoices(
                { name: 'accept', name_localizations: descriptionLocalizations('staff.appeals.cmd.choiceAccept'), value: 'accept' },
                { name: 'deny', name_localizations: descriptionLocalizations('staff.appeals.cmd.choiceDeny'), value: 'deny' },
            ))
        .addStringOption((option) => option
            .setName('note')
            .setDescription('Optional note, shown in the appeal channel and the log')
            .setDescriptionLocalizations(descriptionLocalizations('staff.appeals.cmd.note'))
            .setMaxLength(500)),

    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        // Any server (multi-server B1): only that server's own appeals (listPendingAppeals,
        // getCaseByCode and decideAppeal are scoped by interaction.guildId). Mewvo's Support server
        // decides nothing itself: its appeals are the main server's.
        if (!interaction.guildId || interaction.guildId === enforcementConfig.supportGuildId) {
            throw new TitanBotError('Wrong guild for /appeals', ErrorTypes.PERMISSION,
                interaction.guildId ? tr.t('staff.appeals.mainServerOnly') : tr.t('staff.appeals.serverOnly'), { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                tr.t('staff.appeals.noAdmin'), { expected: true });
        }

        const rawCode = interaction.options.getString('code');
        const decision = interaction.options.getString('decision');
        const caseCode = rawCode ? normalizeCaseCode(rawCode) : null;
        if (rawCode && !caseCode) {
            throw new TitanBotError('Invalid case code', ErrorTypes.USER_INPUT,
                tr.t('staff.appeals.invalidCode'), { expected: true });
        }
        if (decision && !caseCode) {
            throw new TitanBotError('Decision without code', ErrorTypes.USER_INPUT,
                tr.t('staff.appeals.decisionWithoutCode'), { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (!caseCode) return showPending(interaction, tr);

        if (!decision) {
            // Another server's case reads as unknown: its dossier is never shown here.
            const record = await getCaseByCode(caseCode, interaction.guildId);
            if (!record) {
                throw new TitanBotError('Unknown case code', ErrorTypes.USER_INPUT,
                    tr.t('staff.appeals.unknownCase', { code: caseCode }), { expected: true });
            }
            if (!isCaseOfCallerServer(record, interaction.guildId)) {
                throw new TitanBotError('Case of another server', ErrorTypes.PERMISSION, tr.t('staff.appeals.otherServer'), { expected: true });
            }
            return InteractionHelper.safeEditReply(interaction, { embeds: await buildCaseDossier(record, { client, lang: tr.lang }) });
        }

        const result = await decideAppeal({
            client,
            admin: interaction.user,
            caseCode,
            decision,
            note: interaction.options.getString('note')?.trim() || null,
            via: 'slash',
            callerGuildId: interaction.guildId,
            lang: tr.lang,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [decisionResultEmbed({ caseCode, result, decision }, tr)],
        });
    },
};
