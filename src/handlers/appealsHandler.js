// appealsHandler.js — the public Appeal / Report staff panel in the support server.
//
// These components are deliberately open to everyone (no Administrator check):
//   appeal:open | appeal:report            buttons on the panel
//   appealmodal:submit | appealmodal:report modals they open

import {
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { normalizeCaseCode } from '../services/enforcement/format.js';
import { submitAppeal, submitStaffReport } from '../services/enforcement/appealService.js';

function textLabel(label, input, description = null) {
    const builder = new LabelBuilder().setLabel(label).setTextInputComponent(input);
    return description ? builder.setDescription(description) : builder;
}

function appealModal() {
    return new ModalBuilder()
        .setCustomId('appealmodal:submit')
        .setTitle('Appeal a punishment')
        .addLabelComponents(
            textLabel('Case code', new TextInputBuilder()
                .setCustomId('code')
                .setStyle(TextInputStyle.Short)
                .setMinLength(5)
                .setMaxLength(7)
                .setRequired(true), 'The code from the DM you received, e.g. k7m2qx'),
            textLabel('Why should this be lifted?', new TextInputBuilder()
                .setCustomId('reason')
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(20)
                .setMaxLength(1500)
                .setRequired(true)),
        );
}

function reportModal() {
    return new ModalBuilder()
        .setCustomId('appealmodal:report')
        .setTitle('Report a staff member')
        .addLabelComponents(
            textLabel('Staff member username', new TextInputBuilder()
                .setCustomId('staff')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(100)
                .setRequired(true)),
            textLabel('What happened?', new TextInputBuilder()
                .setCustomId('details')
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(20)
                .setMaxLength(1000)
                .setRequired(true)),
            textLabel('Proof links', new TextInputBuilder()
                .setCustomId('proof')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1000)
                .setRequired(false), 'Links to screenshots or messages, one per line'),
        );
}

function inSupportGuild(interaction) {
    return interaction.inGuild() && interaction.guildId === enforcementConfig.supportGuildId;
}

export async function handleAppealButton(interaction, client, args) {
    if (!inSupportGuild(interaction)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Appeals are handled in the Meowist Support server.' });
    }
    const [step] = args;
    if (step === 'open') return InteractionHelper.safeShowModal(interaction, appealModal());
    if (step === 'report') return InteractionHelper.safeShowModal(interaction, reportModal());
}

export async function handleAppealModal(interaction, client, args) {
    if (!inSupportGuild(interaction)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Appeals are handled in the Meowist Support server.' });
    }

    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const [step] = args;

    if (step === 'submit') {
        const caseCode = normalizeCaseCode(interaction.fields.getTextInputValue('code'));
        if (!caseCode) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'That is not a valid case code. It is 5–7 letters and digits, from the DM you received.',
            });
        }
        await submitAppeal({
            guild: interaction.guild,
            user: interaction.user,
            caseCode,
            reason: interaction.fields.getTextInputValue('reason').trim(),
        });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Appeal submitted', "Your appeal was submitted. You'll get a DM with the decision.")],
        });
    }

    if (step === 'report') {
        await submitStaffReport({
            guild: interaction.guild,
            user: interaction.user,
            staffMember: interaction.fields.getTextInputValue('staff').trim(),
            details: interaction.fields.getTextInputValue('details').trim(),
            proof: interaction.fields.getTextInputValue('proof')?.trim() || '',
        });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                'Report submitted',
                'Your report was submitted to the administrators. If they ask for screenshot proof, please post it in your DMs with them.'
            )],
        });
    }
}
