// automodContest.js — the "Contest this" button on automod DMs and its modal.
//
//   amcontest:open:<code>    button in the member's DM → modal
//   amcontest:submit:<code>  modal submit → marks the review card (services/automod/automodContest.js)
//
// Works in DMs (no guild on the interaction): the case is looked up by the code in the
// customId, must be an automod case (of any server: multi-server B1) and must be against the
// member who pressed the button. The contest goes to that case's own server's review channel.
// The form and the answers are in the member's language (textForInteraction: a language role
// when in a server, else their personal language, else their Discord language); customIds unchanged.

import { LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { botText, textForInteraction } from '../utils/botText.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { normalizeCaseCode } from '../services/enforcement/format.js';
import { getCaseByCodeAnyServer } from '../services/enforcement/caseService.js';
import {
    CONTEST_MAX_CHARS, CONTEST_MIN_CHARS, checkContestTarget, getContest, recordContest,
} from '../services/automod/automodContest.js';

export function contestModal(caseCode, tr = botText('en')) {
    return new ModalBuilder()
        .setCustomId(`amcontest:submit:${caseCode}`)
        .setTitle(tr.t('member.contest.title').slice(0, 45))
        .addLabelComponents(
            new LabelBuilder()
                .setLabel(tr.t('member.contest.label').slice(0, 45))
                .setDescription(tr.t('member.contest.hint').slice(0, 100))
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
export async function resolveContestCase(userId, codeArg, lookup = getCaseByCodeAnyServer, tr = botText('en')) {
    const code = normalizeCaseCode(codeArg);
    if (!code) return { error: tr.t('member.contest.broken') };
    const record = await lookup(code);
    const check = checkContestTarget(record, userId);
    return check.ok ? { record } : { error: contestRefusal(check, tr) };
}

/** A refusal from checkContestTarget / recordContest in the member's language (its English `message` otherwise). */
export function contestRefusal(result, tr = botText('en')) {
    return result?.code && tr.has(`member.contest.${result.code}`) ? tr.t(`member.contest.${result.code}`) : result?.message;
}

// The form must be the first response within 3 s, so the early checks (two database reads) get
// this budget. When they are slower the form opens anyway: the submit (handleContestModal and
// recordContest) checks the case and an earlier contest again.
export const CONTEST_CHECK_BUDGET_MS = 1200;

async function earlyContestCheck(userId, codeArg, tr) {
    const resolved = await resolveContestCase(userId, codeArg, getCaseByCodeAnyServer, tr);
    if (resolved.error) return resolved;
    if (await getContest(resolved.record.case_code)) {
        return { error: tr.t('member.contest.already') };
    }
    return resolved;
}

export async function handleContestButton(interaction, client, args, { budgetMs = CONTEST_CHECK_BUDGET_MS } = {}) {
    const [step, codeArg] = args;
    const tr = textForInteraction(interaction);
    if (step !== 'open') return reply(interaction, tr.t('member.contest.unknownAction'));
    const code = normalizeCaseCode(codeArg);
    if (!code) return reply(interaction, tr.t('member.contest.broken'));
    let timer;
    const checking = earlyContestCheck(interaction.user.id, codeArg, tr);
    checking.catch(() => {});
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
    const early = await Promise.race([checking, timeout]).finally(() => clearTimeout(timer));
    if (early?.error) return reply(interaction, early.error);
    return InteractionHelper.safeShowModal(interaction, contestModal(early?.record?.case_code ?? code, tr));
}

export async function handleContestModal(interaction, client, args) {
    const [step, codeArg] = args;
    const tr = textForInteraction(interaction);
    if (step !== 'submit') return reply(interaction, tr.t('member.contest.unknownForm'));
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const { record, error } = await resolveContestCase(interaction.user.id, codeArg, getCaseByCodeAnyServer, tr);
    if (error) return reply(interaction, error);
    const reason = interaction.fields.getTextInputValue('reason') || '';
    const result = await recordContest(client, record, interaction.user.id, reason);
    if (!result.ok) return reply(interaction, contestRefusal(result, tr));
    // The button has done its job: remove it from the DM.
    await interaction.message?.edit?.({ components: [] })?.catch?.(() => {});
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(tr.t('member.contest.sentTitle'), tr.t('member.contest.sent', { code: record.case_code }))],
    });
}
