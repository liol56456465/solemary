// automodContest.js — the "Contest this" button on automod DMs and its modal.
//
//   amcontest:open:<code>    button in the member's DM → modal
//   amcontest:submit:<code>  modal submit → marks the review card (services/automod/automodContest.js)
//
// Works in DMs (no guild on the interaction): the case is looked up by the code in the
// customId, must be an automod case (of any server: multi-server B1) and must be against the
// member who pressed the button. The contest goes to that case's own server's review channel.

import { LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { normalizeCaseCode } from '../services/enforcement/format.js';
import { getCaseByCodeAnyServer } from '../services/enforcement/caseService.js';
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

/**
 * The case behind a customId, checked against the member: { record } or { error }.
 * Any-server lookup: the button is in a DM (no guild); checkContestTarget then requires the
 * member's own automod case, so only a case against the member who pressed it is shown.
 */
export async function resolveContestCase(userId, codeArg, lookup = getCaseByCodeAnyServer) {
    const code = normalizeCaseCode(codeArg);
    if (!code) return { error: 'That button is broken (no case code).' };
    const record = await lookup(code);
    const check = checkContestTarget(record, userId);
    return check.ok ? { record } : { error: check.message };
}

// The form must be the first response within 3 s, so the early checks (two database reads) get
// this budget. When they are slower the form opens anyway: the submit (handleContestModal and
// recordContest) checks the case and an earlier contest again.
export const CONTEST_CHECK_BUDGET_MS = 1200;

async function earlyContestCheck(userId, codeArg) {
    const resolved = await resolveContestCase(userId, codeArg);
    if (resolved.error) return resolved;
    if (await getContest(resolved.record.case_code)) {
        return { error: 'You already contested this decision. The moderators will look at it.' };
    }
    return resolved;
}

export async function handleContestButton(interaction, client, args, { budgetMs = CONTEST_CHECK_BUDGET_MS } = {}) {
    const [step, codeArg] = args;
    if (step !== 'open') return reply(interaction, 'Unknown action.');
    const code = normalizeCaseCode(codeArg);
    if (!code) return reply(interaction, 'That button is broken (no case code).');
    let timer;
    const checking = earlyContestCheck(interaction.user.id, codeArg);
    checking.catch(() => {});
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
    const early = await Promise.race([checking, timeout]).finally(() => clearTimeout(timer));
    if (early?.error) return reply(interaction, early.error);
    return InteractionHelper.safeShowModal(interaction, contestModal(early?.record?.case_code ?? code));
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
