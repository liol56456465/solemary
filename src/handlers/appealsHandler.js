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
import { normalizeCaseCode } from '../services/enforcement/format.js';
import { getCaseByCode, listUserAppeals } from '../services/enforcement/caseService.js';
import {
    OTHER_SERVER_CASE, appealStaffGuildId, decideAppeal, isCaseOfCallerServer, submitAppeal, submitStaffReport,
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

/** 'main' | 'support' | null for any other place. */
function panelServer(interaction) {
    if (!interaction.inGuild()) return null;
    if (interaction.guildId === enforcementConfig.mainGuildId) return 'main';
    if (interaction.guildId === enforcementConfig.supportGuildId) return 'support';
    return null;
}

const WRONG_PLACE = 'Appeals are handled in the Mewvo servers.';

export async function handleAppealButton(interaction, client, args) {
    const server = panelServer(interaction);
    const [step] = args;
    if (!server || (step === 'report' && server !== 'support')) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: WRONG_PLACE });
    }
    if (step === 'open') return InteractionHelper.safeShowModal(interaction, appealModal());
    if (step === 'report') return InteractionHelper.safeShowModal(interaction, reportModal());
    if (step === 'status') return showMyAppeals(interaction);
    if (step === 'standing') return showMyStanding(interaction);
}

/**
 * The clicking member's own standing in the main server: counted warnings, ladder
 * level and what the next warning would do, active punishments, appeals. Private,
 * and only ever about interaction.user.
 */
async function showMyStanding(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;
    const standing = await getMemberStanding(enforcementConfig.mainGuildId, interaction.user.id);
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
            title: `My record in ${enforcementConfig.serverName}`,
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
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: WRONG_PLACE });
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

    if (step === 'report' && server === 'support') {
        await submitStaffReport({
            client,
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

/** "I'm looking at it": records the reviewer once, DMs the member, tells the staff channel. */
async function handleClaim(interaction, client, caseCode) {
    const result = await claimAppeal({ client, admin: interaction.user, caseCode });
    if (result.status === 'none') {
        return InteractionHelper.safeEditReply(interaction, { embeds: [createEmbed({ title: 'Nothing to take', description: `There is no open appeal for \`${caseCode}\` any more.`, color: 'warning' })] });
    }
    if (result.status === 'already') {
        return InteractionHelper.safeEditReply(interaction, { embeds: [createEmbed({ title: 'Already taken', description: `${result.by} is already looking at this appeal.`, color: 'warning' })] });
    }
    await interaction.channel?.send?.({ content: `${interaction.user.username} is looking at this appeal.`, allowedMentions: { parse: [] } }).catch(() => {});
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('You took this appeal', `The member was told someone is looking at it. DM ${result.dmDelivered ? 'delivered' : '**not delivered** (their DMs are closed)'}.`)],
    });
}

export async function handleAppealDecisionButton(interaction, client, args) {
    // Deferred first: the support-server check fetches the main-server member.
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const [decision, rawCode] = args;
    const caseCode = normalizeCaseCode(rawCode || '');
    // The case decides which server's staff may act on it (also for Claim).
    const record = caseCode ? await getCaseByCode(caseCode) : null;
    const refuse = (message) => replyUserError(interaction, { type: ErrorTypes.PERMISSION, message });
    if (record && !isCaseOfCallerServer(record, interaction.guildId)) return refuse(OTHER_SERVER_CASE);
    if (!(await canDecideAppeals(interaction, client, record))) {
        return refuse(isHomeGuild(interaction.guildId)
            ? 'Only administrators in the main server can decide appeals.'
            : 'Only administrators of this server can decide its appeals.');
    }
    if (decision === 'claim' && caseCode) return handleClaim(interaction, client, caseCode);
    if (!DECISIONS.has(decision) || !caseCode) return;

    const result = await decideAppeal({
        client, admin: interaction.user, caseCode, decision, note: null, via: 'button', callerGuildId: interaction.guildId,
    });
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            `Appeal ${result.label}`,
            [
                `\`${caseCode}\` · ${result.record.name}`,
                `DM to the user: ${result.dmDelivered ? 'delivered' : '**not delivered**'}.`,
                ...result.notes,
                ...(result.ownerOverride ? ['You issued this punishment: decided as a bot owner, logged as an owner override.'] : []),
            ].join('\n')
        )],
    });
}
