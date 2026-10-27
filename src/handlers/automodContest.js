// automodContest.js — the "Contest this" button on automod DMs and its modal.
//
//   amcontest:open:<code>    button in the member's DM → modal
//   amcontest:submit:<code>  modal submit → marks the review card (services/automod/automodContest.js)
//
// Works in DMs (no guild on the interaction): the case is looked up by the code in the
// customId, must be an automod case in the main server, and must be against the member
// who pressed the button.

import { LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { normalizeCaseCode } from '../services/enforcement/format.js';
import { getCaseByCode } from '../services/enforcement/caseService.js';
import {
    CONTEST_MAX_CHARS, CONTEST_MIN_CHARS, checkContestTarget, getContest, recordContest,
} from '../services/automod/automodContest.js';

export function contestModal(caseCode) {
    return new ModalBuilder()
        .setCustomId(`amcontest:submit:${caseCode}`)
        .setTitle('Contest this decision')
        .addLabelComponents(
            new LabelBuilder()
                .setLabel('Why was this OK?')
                .setDescription('A moderator will read this and decide.')
                .setTextInputComponent(new TextInputBuilder()
                    .setCustomId('reason')
                    .setStyle(TextInputStyle.Paragraph)
                    .setMinLength(CONTEST_MIN_CHARS)
                    .setMaxLength(CONTEST_MAX_CHARS)
                    .setRequired(true)),
        );
}

function reply(interaction, content) {
    if (interaction.deferred || interaction.replied) {
        return InteractionHelper.safeEditReply(interaction, { content, allowedMentions: { parse: [] } });
    }
    return InteractionHelper.safeReply(interaction, { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

/** The case behind a customId, checked against the member: { record } or { error }. */
export async function resolveContestCase(userId, codeArg, lookup = getCaseByCode) {
    const code = normalizeCaseCode(codeArg);
    if (!code) return { error: 'That button is broken (no case code).' };
    const record = await lookup(code);
    const check = checkContestTarget(record, userId);
    return check.ok ? { record } : { error: check.message };
}

export async function handleContestButton(interaction, client, args) {
    const [step, codeArg] = args;
    if (step !== 'open') return reply(interaction, 'Unknown action.');
    const { record, error } = await resolveContestCase(interaction.user.id, codeArg);
    if (error) return reply(interaction, error);
    if (await getContest(record.case_code)) {
        return reply(interaction, 'You already contested this decision. The moderators will look at it.');
    }
    return InteractionHelper.safeShowModal(interaction, contestModal(record.case_code));
}

export async function handleContestModal(interaction, client, args) {
    const [step, codeArg] = args;
    if (step !== 'submit') return reply(interaction, 'Unknown form.');
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const { record, error } = await resolveContestCase(interaction.user.id, codeArg);
    if (error) return reply(interaction, error);
    const reason = interaction.fields.getTextInputValue('reason') || '';
    const result = await recordContest(client, record, interaction.user.id, reason);
    if (!result.ok) return reply(interaction, result.message);
    // The button has done its job: remove it from the DM.
    await interaction.message?.edit?.({ components: [] })?.catch?.(() => {});
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Sent to the moderators',
            `A moderator will review case ${record.case_code} with your explanation. You'll get a DM if it is reversed.`)],
    });
}
