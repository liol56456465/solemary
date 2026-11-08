// appealsHandler.js — the public Appeal / Report staff panels posted by /setappeal.
//
// The panel components are deliberately open to everyone (no Administrator check):
//   appeal:open | appeal:report            buttons on the panels
//   appeal:status | appeal:standing        the member's own appeals / standing (private)
//   appealmodal:submit | appealmodal:report modals they open
// The Appeal button works in both servers; Report staff only in the support server.
// The Accept / Deny buttons on appeal messages (at the bottom) are admin-only.
// Mute/warn appeals and staff reports open admin-only channels in the main server; ban/kick
// appeals open in the support server with the appellant (staff work in a private thread there).

import {
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { textForInteraction } from '../utils/botText.js';
import { normalizeCaseCode, truncate } from '../services/enforcement/format.js';
import { getCaseByCode, listUserAppeals } from '../services/enforcement/caseService.js';
import {
    appealStaffGuildId, decideAppeal, isCaseOfCallerServer, submitAppeal, submitStaffReport,
} from '../services/enforcement/appealService.js';
import { isHomeGuild } from '../services/settings/guildSettings.js';
import { claimAppeal } from '../services/enforcement/appealStatusService.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { getMemberStanding, standingFields } from '../services/enforcement/standingService.js';

function textLabel(label, input, description = null) {
    const builder = new LabelBuilder().setLabel(label).setTextInputComponent(input);
    return description ? builder.setDescription(description) : builder;
}

function appealModal() {
    return new ModalBuilder()
        .setCustomId('appealmodal:submit')
        .setTitle('Appeal a punishment')
        .addLabelComponents(
            textLabel('Why should it be lifted?', new TextInputBuilder()
                .setCustomId('reason')
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(20)
                .setMaxLength(1000)
                .setRequired(true), 'Why should you be unbanned, unmuted or unwarned?'),
            textLabel('Case code', new TextInputBuilder()
                .setCustomId('code')
                .setStyle(TextInputStyle.Short)
                .setMinLength(5)
                .setMaxLength(7)
                .setRequired(true), 'From the DM you got when you were punished, e.g. k7m2qx.'),
            textLabel('More info (optional)', new TextInputBuilder()
                .setCustomId('moreinfo')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1000)
                .setRequired(false), 'Anything else the administrators should know.'),
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

/**
 * 'main' | 'support' | 'other' (any other server, multi-server B1: its own panel posted with
 * /setappeal) | null outside a server.
 */
export function panelServer(interaction) {
    if (!interaction.inGuild()) return null;
    if (interaction.guildId === enforcementConfig.mainGuildId) return 'main';
    if (interaction.guildId === enforcementConfig.supportGuildId) return 'support';
    return 'other';
}

/** Outside a server (or a report button in Mewvo's main server, where reports are not filed). */
export function wrongPlaceMessage(server, step) {
    if (server === 'main' && step === 'report') return 'Staff reports are filed from the panel in the Mewvo support server.';
    return 'Use the appeal panel in a server.';
}

/** Staff reports: the support server's panel (for Mewvo) or another server's own panel; never the main one. */
const takesReports = (server) => server === 'support' || server === 'other';

export async function handleAppealButton(interaction, client, args) {
    const server = panelServer(interaction);
    const [step] = args;
    if (!server || (step === 'report' && !takesReports(server))) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: wrongPlaceMessage(server, step) });
    }
    if (step === 'open') return InteractionHelper.safeShowModal(interaction, appealModal());
    if (step === 'report') return InteractionHelper.safeShowModal(interaction, reportModal());
    if (step === 'status') return showMyAppeals(interaction);
    if (step === 'standing') return showMyStanding(interaction, server);
}

/**
 * The clicking member's own standing: in the main server for Mewvo's panels, in the server
 * itself for another server's panel. Counted warnings, ladder level and what the next warning
 * would do, active punishments, appeals. Private, and only ever about interaction.user.
 */
async function showMyStanding(interaction, server = 'main') {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;
    const other = server === 'other';
    const guildId = other ? interaction.guildId : enforcementConfig.mainGuildId;
    const standing = await getMemberStanding(guildId, interaction.user.id);
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
            title: `My record in ${other ? (interaction.guild?.name || 'this server') : enforcementConfig.serverName}`,
            description: 'Only you can see this.',
            fields: standingFields(standing),
            color: standing.activeBan || standing.activeMute ? 'warning' : 'primary',
        })],
    });
}

const MY_APPEAL_STATUS = {
    pending: 'Waiting for a decision',
    accepted: 'Accepted',
    denied: 'Denied',
    closed: 'Closed',
};

/** The text of a member's own appeals (the My appeals button and /appeal status). Pure. */
export function myAppealsText(appeals) {
    if (!appeals.length) return 'You have not filed any appeals. Press **Appeal** on the appeal panel to file one; you need the case code from the DM you got.';
    const stamp = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:d>`;
    return appeals.map((appeal) => {
        const status = appeal.status === 'pending' && appeal.claimed_at
            ? 'Waiting for a decision. Someone on the staff team is looking at it.'
            : (MY_APPEAL_STATUS[appeal.status] ?? appeal.status);
        return [
            `**\`${appeal.case_code}\`**: ${appeal.type} (${appeal.name})`,
            `${status} · filed ${stamp(appeal.created_at)}${appeal.decided_at ? ` · decided ${stamp(appeal.decided_at)}` : ''}`,
        ].join('\n');
    }).join('\n\n');
}

/** The clicking member's own appeals: case, status and dates. Only they see it. */
async function showMyAppeals(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;
    const appeals = await listUserAppeals(interaction.user.id);
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
            title: 'My appeals',
            description: myAppealsText(appeals),
            color: 'primary',
        })],
    });
}

export async function handleAppealModal(interaction, client, args) {
    const server = panelServer(interaction);
    if (!server) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: wrongPlaceMessage(server, args?.[0]) });
    }

    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const [step] = args;

    if (step === 'submit') {
        const caseCode = normalizeCaseCode(interaction.fields.getTextInputValue('code')?.trim() || '');
        if (!caseCode) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'That is not a valid case code. It is 5–7 letters and digits, from the DM you received.',
            });
        }
        await submitAppeal({
            client,
            user: interaction.user,
            caseCode,
            answers: {
                reason: interaction.fields.getTextInputValue('reason').trim(),
                moreInfo: interaction.fields.getTextInputValue('moreinfo')?.trim() || '',
            },
        });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Appeal submitted', "The administrators will review it. You'll get a DM with the decision.")],
        });
    }

    if (step === 'report' && takesReports(server)) {
        await submitStaffReport({
            client,
            guildId: interaction.guildId,
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

    // An unknown step, or a report form in a server that takes no reports: answer instead of
    // leaving the member at "thinking…".
    return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This form is not available here any more. Open it again from the panel.' });
}

// ── Accept / Deny on an appeal (admins of the case's staff server) ──────────
//   appealdecide:<accept|deny>:<code>   buttons on the appeal message; each decides
//   only the appeal for that case code, straight away.

const DECISIONS = new Set(['accept', 'deny']);

/**
 * Who may press Accept / Deny / Claim: Administrators of the main server for Mewvo's own cases.
 * In the main server that is the clicking member; in the support server the clicker's
 * main-server membership is fetched fresh. In any other server: that server's Administrators,
 * and only for that server's own case (`record`, loaded by the code in the customId); without a
 * record nobody there may decide.
 */
export async function canDecideAppeals(interaction, client, record = null) {
    if (interaction.guildId === enforcementConfig.mainGuildId) return isAdministrator(interaction.member);
    if (interaction.guildId === enforcementConfig.supportGuildId) {
        const mainGuild = client.guilds.cache.get(enforcementConfig.mainGuildId);
        const mainMember = await mainGuild?.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
        return isAdministrator(mainMember);
    }
    if (!interaction.guildId || isHomeGuild(interaction.guildId)) return false;
    return Boolean(record) && appealStaffGuildId(record) === interaction.guildId && isAdministrator(interaction.member);
}


/**
 * The result of a decision for the deciding admin (Accept / Deny buttons and /appeals), in their
 * language (`tr`; the notes come translated from decideAppeal({ lang })). Pure (tests).
 */
export function decisionResultEmbed({ caseCode, result, decision }, tr) {
    return successEmbed(
        tr.t(decision === 'accept' ? 'staff.appeals.result.accepted' : 'staff.appeals.result.denied'),
        truncate([
            `\`${caseCode}\` · ${result.record.name}`,
            tr.t(result.dmDelivered ? 'staff.appeals.result.dmDelivered' : 'staff.appeals.result.dmNotDelivered'),
            ...result.notes,
            ...(result.ownerOverride ? [tr.t('staff.appeals.result.ownerOverride')] : []),
        ].join('\n'), 4096)
    );
}

/** "I'm looking at it": records the reviewer once, DMs the member, tells the staff channel. */
async function handleClaim(interaction, client, caseCode, tr) {
    const result = await claimAppeal({ client, admin: interaction.user, caseCode });
    if (result.status === 'none') {
        return InteractionHelper.safeEditReply(interaction, { embeds: [createEmbed({ title: tr.t('staff.appeals.claim.noneTitle'), description: tr.t('staff.appeals.claim.none', { code: caseCode }), color: 'warning' })] });
    }
    if (result.status === 'already') {
        return InteractionHelper.safeEditReply(interaction, { embeds: [createEmbed({ title: tr.t('staff.appeals.claim.alreadyTitle'), description: tr.t('staff.appeals.claim.already', { name: result.by }), color: 'warning' })] });
    }
    // Posted in the staff channel: the server's language.
    const channelTr = textForInteraction(interaction, { purpose: 'public' });
    await interaction.channel?.send?.({ content: channelTr.t('staff.appeals.claim.looking', { name: interaction.user.username }), allowedMentions: { parse: [] } }).catch(() => {});
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(tr.t('staff.appeals.claim.tookTitle'), tr.t(result.dmDelivered ? 'staff.appeals.claim.tookDelivered' : 'staff.appeals.claim.tookNotDelivered'))],
    });
}

export async function handleAppealDecisionButton(interaction, client, args) {
    // Deferred first: the support-server check fetches the main-server member.
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    // Ephemeral answers to the admin: their Discord language.
    const tr = textForInteraction(interaction);
    const [decision, rawCode] = args;
    const caseCode = normalizeCaseCode(rawCode || '');
    // The case decides which server's staff may act on it (also for Claim).
    // Only this server's cases (main + support count as one): another server's code reads as unknown.
    const record = caseCode && interaction.guildId ? await getCaseByCode(caseCode, interaction.guildId) : null;
    const refuse = (message) => replyUserError(interaction, { type: ErrorTypes.PERMISSION, message });
    if (caseCode && !record) {
        return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('staff.appeals.unknownCase', { code: caseCode }) });
    }
    if (record && !isCaseOfCallerServer(record, interaction.guildId)) return refuse(tr.t('staff.appeals.otherServer'));
    if (!(await canDecideAppeals(interaction, client, record))) {
        return refuse(isHomeGuild(interaction.guildId)
            ? tr.t('staff.appeals.button.mainAdminsOnly')
            : tr.t('staff.appeals.button.serverAdminsOnly'));
    }
    if (decision === 'claim' && caseCode) return handleClaim(interaction, client, caseCode, tr);
    if (!DECISIONS.has(decision) || !caseCode) {
        return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('staff.appeals.button.outdated') });
    }

    const result = await decideAppeal({
        client, admin: interaction.user, caseCode, decision, note: null, via: 'button', callerGuildId: interaction.guildId, lang: tr.lang,
    });
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [decisionResultEmbed({ caseCode, result, decision }, tr)],
    });
}
