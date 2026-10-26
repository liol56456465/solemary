// appealsHandler.js — the public Appeal / Report staff panels posted by /setappeal.
//
// These components are deliberately open to everyone (no Administrator check):
//   appeal:open | appeal:report            buttons on the panels
//   appealmodal:submit | appealmodal:report modals they open
// The Appeal button works in both servers; Report staff only in the support server.

import {
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
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
            textLabel('Why did you get punished?', new TextInputBuilder()
                .setCustomId('punished')
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(10)
                .setMaxLength(1000)
                .setRequired(true), 'What happened that got you banned, muted or warned?'),
            textLabel('Why should it be lifted?', new TextInputBuilder()
                .setCustomId('reason')
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(20)
                .setMaxLength(1000)
                .setRequired(true)),
            new LabelBuilder()
                .setLabel('Did you do it?')
                .setDescription('Be honest — honest appeals are reviewed more favourably.')
                .setStringSelectMenuComponent(new StringSelectMenuBuilder()
                    .setCustomId('didit')
                    .setRequired(true)
                    .addOptions(
                        { label: 'Yes, I did it', value: 'yes' },
                        { label: 'Partly', value: 'partly' },
                        { label: "No, I didn't do it", value: 'no' },
                    )),
            textLabel('Case code (optional)', new TextInputBuilder()
                .setCustomId('code')
                .setStyle(TextInputStyle.Short)
                .setMinLength(5)
                .setMaxLength(7)
                .setRequired(false), 'From your DM, e.g. k7m2qx. Leave empty to appeal your latest punishment.'),
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

/** 'main' | 'support' | null for any other place. */
function panelServer(interaction) {
    if (!interaction.inGuild()) return null;
    if (interaction.guildId === enforcementConfig.mainGuildId) return 'main';
    if (interaction.guildId === enforcementConfig.supportGuildId) return 'support';
    return null;
}

const WRONG_PLACE = 'Appeals are handled in the Meowist servers.';

export async function handleAppealButton(interaction, client, args) {
    const server = panelServer(interaction);
    const [step] = args;
    if (!server || (step === 'report' && server !== 'support')) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: WRONG_PLACE });
    }
    if (step === 'open') return InteractionHelper.safeShowModal(interaction, appealModal());
    if (step === 'report') return InteractionHelper.safeShowModal(interaction, reportModal());
}

export async function handleAppealModal(interaction, client, args) {
    const server = panelServer(interaction);
    if (!server) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: WRONG_PLACE });
    }

    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const [step] = args;

    if (step === 'submit') {
        const rawCode = interaction.fields.getTextInputValue('code')?.trim() || '';
        const caseCode = rawCode ? normalizeCaseCode(rawCode) : null;
        if (rawCode && !caseCode) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'That is not a valid case code. It is 5–7 letters and digits, from the DM you received. Or leave it empty.',
            });
        }
        const { channel } = await submitAppeal({
            client,
            user: interaction.user,
            caseCode,
            from: server,
            answers: {
                punished: interaction.fields.getTextInputValue('punished').trim(),
                reason: interaction.fields.getTextInputValue('reason').trim(),
                didIt: interaction.fields.getStringSelectValues('didit')[0],
            },
        });
        const where = channel.permissionOverwrites.cache.has(interaction.user.id)
            ? `Your appeal channel: <#${channel.id}>. `
            : '';
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Appeal submitted', `${where}You'll get a DM with the decision.`)],
        });
    }

    if (step === 'report' && server === 'support') {
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
