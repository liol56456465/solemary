// enforcementPanel.js — the /enforcements panel and its components.
//
// custom_id layout: <handler>:<step>:<moderatorId>:<arg>
//   enf:act:<mod>:<target>:<action>   action buttons on the panel
//   enf:confirm|cancel|details:<mod>:<nonce>
//   enfsel:reason|warn:<mod>:<nonce>
//   enfmodal:details|lift:<mod>:<nonce>
// Every component re-checks that the clicker is that moderator and still an
// Administrator before doing anything.

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    CheckboxBuilder,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { enforcementConfig, ENFORCEMENT_REASONS, CUSTOM_REASON_KEY } from '../config/enforcement.js';
import { createEmbed } from '../utils/embeds.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger } from '../utils/logger.js';
import { createError, ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import {
    executeAction,
    getTargetState,
    isAdministrator,
} from '../services/enforcement/enforcementService.js';
import {
    getCountedWarns,
    listCasesForUser,
    getLatestAppealStatuses,
    caseStatusLabel,
} from '../services/enforcement/caseService.js';
import { createFlow, getFlow, takeFlow, updateFlow, PANEL_EXPIRED_MESSAGE } from '../services/enforcement/panelState.js';
import { MAX_LINKS_PER_FORM, messageExcerpt } from '../services/enforcement/evidenceService.js';
import { dateStamp, stamp, truncate } from '../services/enforcement/format.js';
import { getActiveOrdersFor, noContactLines } from '../services/enforcement/noContactService.js';
import {
    ACTION_LABELS, RECORD_ACTIONS, attachFlowEvidence, availableActions, completeFlowDetails, countedWarnsText,
    flowSummary, liftReasonPatch, parseFlowInput, reasonPatch, startFlow,
} from '../services/enforcement/flowBuilder.js';

// The flow logic lives in flowBuilder.js (shared with the web dashboard).
export { attachFlowEvidence, availableActions };
const ACTION_STYLES = {
    ban: ButtonStyle.Danger,
    kick: ButtonStyle.Danger,
    mute: ButtonStyle.Primary,
    warn: ButtonStyle.Primary,
    unban: ButtonStyle.Success,
    unmute: ButtonStyle.Success,
    removewarn: ButtonStyle.Secondary,
};
function userError(message, type = ErrorTypes.VALIDATION) {
    return createError(message, type, message, { expected: true });
}

// ── Guards ─────────────────────────────────────────────────────────────────

/** Returns true when the clicker may use this component; otherwise replies and returns false. */
async function guard(interaction, moderatorId) {
    if (interaction.user.id !== moderatorId) {
        await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: 'This panel belongs to another moderator. Run /enforcements yourself.',
        });
        return false;
    }
    if (!interaction.inGuild() || interaction.guildId !== enforcementConfig.mainGuildId) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'This panel only works in the main server.' });
        return false;
    }
    if (!isAdministrator(interaction.member)) {
        await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: 'You no longer have the Administrator permission, so this panel is closed.',
        });
        return false;
    }
    return true;
}

async function expired(interaction) {
    const payload = { embeds: [createEmbed({ title: 'Panel expired', description: PANEL_EXPIRED_MESSAGE, color: 'warning' })], components: [] };
    if (interaction.deferred || interaction.replied) {
        return InteractionHelper.safeEditReply(interaction, payload);
    }
    if (interaction.isMessageComponent?.() || interaction.isFromMessage?.()) {
        return interaction.update(payload).catch(() => InteractionHelper.safeReply(interaction, { ...payload, flags: MessageFlags.Ephemeral }));
    }
    return InteractionHelper.safeReply(interaction, { ...payload, flags: MessageFlags.Ephemeral });
}

// ── Panel ──────────────────────────────────────────────────────────────────

function relative(date) {
    return `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;
}

/**
 * The member summary at the top of the panel, so a moderator sees the history
 * before acting: account age, time in server, roles, warns and ladder, any active
 * punishment, pending appeals. (No message counts: member messages are not stored.)
 */
export function panelSummaryLines(targetUser, state, appealStatuses = new Map(), noContact = []) {
    const member = state.member;
    const roleCount = member ? Math.max(0, (member.roles?.cache?.size ?? 1) - 1) : null; // minus @everyone
    const lines = [
        `**User:** ${targetUser.username} (<@${targetUser.id}>) · \`${targetUser.id}\``,
        `**Account created:** ${dateStamp(targetUser.createdAt)} (${relative(targetUser.createdAt)})`,
        member
            ? `**In server:** yes, joined ${member.joinedAt ? `${dateStamp(member.joinedAt)} (${relative(member.joinedAt)})` : 'at an unknown time'} · ${roleCount} role${roleCount === 1 ? '' : 's'}`
            : '**In server:** no',
        `**Counted warns:** ${countedWarnsText(state.ladder)} · **Ladder level:** ${state.ladder.level}`,
    ];

    const active = [];
    if (state.activeBan) {
        active.push(`ban \`${state.activeBan.case_code}\` — ${state.activeBan.expires_at ? `ends ${stamp(state.activeBan.expires_at)}` : 'permanent'}`);
    } else if (state.banned) {
        active.push('banned (no record — banned outside the panel)');
    }
    if (state.activeMute) {
        active.push(`mute \`${state.activeMute.case_code}\` — ends ${stamp(state.activeMute.expires_at)}`);
    } else if (state.muted) {
        active.push('has the muted role (no record)');
    }
    lines.push(`**Active punishment:** ${active.length ? active.join('; ') : 'none'}`);

    const pendingAppeals = [...appealStatuses].filter(([, status]) => status === 'pending').map(([code]) => `\`${code}\``);
    if (pendingAppeals.length) {
        lines.push(`**Pending appeal:** ${pendingAppeals.join(', ')} (decide in the appeal channel or with /appeals)`);
    }
    if (noContact.length) {
        lines.push(`**No-contact order:** ${noContactLines(noContact).join('; ')}`);
    }
    return lines;
}

/** "Last cases" field: type, name, date and status of the newest few. */
export function recentCasesText(rows, total, appealStatuses = new Map()) {
    if (!rows.length) return 'None';
    const lines = rows.map((row) => `\`${row.case_code}\` **${row.type}**${row.is_test ? ' (test)' : ''} · ${truncate(row.name, 60)} · <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:d> · ${caseStatusLabel(row, appealStatuses.get(row.case_code))}${row.is_imported ? ' · imported' : ''}`);
    if (total > rows.length) lines.push(`-# ${total - rows.length} older — see /background`);
    return lines.join('\n');
}

const RECENT_CASES_SHOWN = 3;

export async function buildPanel(guild, moderatorId, targetUser) {
    const state = await getTargetState(guild, targetUser.id);
    const [{ rows: recent, total }, appealStatuses] = await Promise.all([
        listCasesForUser(guild.id, targetUser.id, { limit: RECENT_CASES_SHOWN }),
        getLatestAppealStatuses(targetUser.id),
    ]);

    const embed = createEmbed({
        title: `Enforcements — ${truncate(targetUser.username, 200)}`,
        description: truncate(panelSummaryLines(targetUser, state, appealStatuses, getActiveOrdersFor(guild.id, targetUser.id)).join('\n'), 4096),
        fields: [{ name: `Last cases${total ? ` (${Math.min(total, RECENT_CASES_SHOWN)} of ${total})` : ''}`, value: truncate(recentCasesText(recent, total, appealStatuses), 1024) }],
        thumbnail: targetUser.displayAvatarURL(),
        color: 'primary',
    });

    const buttons = availableActions(state).map((action) => new ButtonBuilder()
        .setCustomId(`enf:act:${moderatorId}:${targetUser.id}:${action}`)
        .setLabel(ACTION_LABELS[action])
        .setStyle(ACTION_STYLES[action]));

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    return { embeds: [embed], components: rows };
}

// ── Flow steps ─────────────────────────────────────────────────────────────

function reasonSelect(moderatorId, nonce, action) {
    const options = [
        ...ENFORCEMENT_REASONS.map((reason) => ({
            label: reason.label,
            value: reason.key,
            description: action === 'ban' && reason.severe ? 'Severe — ban is unappealable by default' : undefined,
        })),
        { label: 'Custom…', value: CUSTOM_REASON_KEY, description: 'Type your own reason' },
    ];
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`enfsel:reason:${moderatorId}:${nonce}`)
        .setPlaceholder('Choose a reason')
        .addOptions(options));
}

function cancelRow(moderatorId, nonce, extra = []) {
    return new ActionRowBuilder().addComponents(
        ...extra,
        new ButtonBuilder().setCustomId(`enf:cancel:${moderatorId}:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
}

function stepEmbed(flow, description) {
    return createEmbed({
        title: `${ACTION_LABELS[flow.type]} — ${truncate(flow.targetUsername, 200)}`,
        description,
        color: 'primary',
    });
}

function detailsModal(flow, moderatorId, nonce) {
    const modal = new ModalBuilder()
        .setCustomId(`enfmodal:details:${moderatorId}:${nonce}`)
        .setTitle(truncate(`${ACTION_LABELS[flow.type]} ${flow.targetUsername}`, 45));

    if (flow.reasonKey === CUSTOM_REASON_KEY) {
        modal.addLabelComponents(new LabelBuilder()
            .setLabel('Custom reason')
            .setTextInputComponent(new TextInputBuilder()
                .setCustomId('reason')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(500)
                .setRequired(true)
                .setValue(flow.customReason || '')));
    }

    if (flow.type === 'ban' || flow.type === 'mute') {
        modal.addLabelComponents(new LabelBuilder()
            .setLabel('Duration')
            .setDescription(flow.type === 'ban'
                ? 'e.g. 30m, 24h, 7d, 1mo. Leave blank for a permanent ban.'
                : 'Required. e.g. 30m, 24h, 7d, 1mo.')
            .setTextInputComponent(new TextInputBuilder()
                .setCustomId('duration')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(20)
                .setRequired(flow.type === 'mute')
                .setValue(flow.durationInput || '')));
    }

    modal.addLabelComponents(new LabelBuilder()
        .setLabel('Name (optional)')
        .setDescription(`Default: ${truncate(`${flow.targetUsername} ${flow.type} <n>`, 90)}`)
        .setTextInputComponent(new TextInputBuilder()
            .setCustomId('name')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(false)
            .setValue(flow.nameIsDefault ? '' : (flow.name || ''))));

    // Every record action has room: at most custom reason + duration + name +
    // evidence + unappealable = 5 inputs (a ban), Discord's limit.
    modal.addLabelComponents(new LabelBuilder()
        .setLabel('Evidence (message links, optional)')
        .setDescription(`Up to ${MAX_LINKS_PER_FORM} links, one per line. Add images later with /case evidence add.`)
        .setTextInputComponent(new TextInputBuilder()
            .setCustomId('evidence')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1000)
            .setRequired(false)
            .setValue(flow.evidenceInput || '')));

    if (flow.type === 'ban') {
        modal.addLabelComponents(new LabelBuilder()
            .setLabel('Unappealable')
            .setDescription('Checked: the user cannot appeal this ban.')
            .setCheckboxComponent(new CheckboxBuilder()
                .setCustomId('unappealable')
                .setDefault(Boolean(flow.unappealable))));
    }

    return modal;
}

function liftModal(flow, moderatorId, nonce) {
    return new ModalBuilder()
        .setCustomId(`enfmodal:lift:${moderatorId}:${nonce}`)
        .setTitle(truncate(`${ACTION_LABELS[flow.type]} ${flow.targetUsername}`, 45))
        .addLabelComponents(new LabelBuilder()
            .setLabel('Reason (optional)')
            .setTextInputComponent(new TextInputBuilder()
                .setCustomId('reason')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(500)
                .setRequired(false)));
}

function confirmationPayload(flow, moderatorId, nonce) {
    const summary = flowSummary(flow);
    const lines = summary.rows.map((row) => (row.id
        ? `**${row.label}:** ${row.value} (\`${row.id}\`)`
        : `**${row.label}:** ${row.code ? `\`${row.value}\`` : row.value}`));
    if (summary.evidence.length) {
        lines.push(`**Evidence:** ${summary.evidence.map((item) => (item.excerpt
            ? `${item.url} ("${truncate(item.excerpt.replace(/\s+/g, ' '), 80)}")`
            : `${item.url}${item.unreadable ? ' (message not readable, link only)' : ''}`)).join('\n')}`);
    }
    if (summary.effect) lines.push(`**Effect:** ${summary.effect}`);
    lines.push(...summary.notes);
    if (summary.precedent) lines.push(`-# ${summary.precedent}`);

    return {
        embeds: [createEmbed({
            title: `Confirm: ${ACTION_LABELS[flow.type]}`,
            description: truncate(lines.join('\n'), 4096),
            color: flow.type === 'ban' || flow.type === 'kick' ? 'error' : 'warning',
        })],
        components: [cancelRow(moderatorId, nonce, [
            new ButtonBuilder().setCustomId(`enf:confirm:${moderatorId}:${nonce}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
            ...(RECORD_ACTIONS.has(flow.type)
                ? [new ButtonBuilder().setCustomId(`enf:details:${moderatorId}:${nonce}`).setLabel('Edit details').setStyle(ButtonStyle.Secondary)]
                : []),
        ])],
    };
}

function resultPayload(flow, result) {
    const lines = [];
    if (result.record) {
        lines.push(`**Case code:** \`${result.record.case_code}\``, `**Name:** ${result.record.name}`);
        if (result.record.expires_at) {
            lines.push(`**Ends:** ${stamp(result.record.expires_at)}`);
        }
    }
    if (result.dmDelivered === false) {
        lines.push('⚠️ **The DM could not be delivered** (DMs closed or no shared server). The action still ran.');
    } else if (result.dmDelivered === true) {
        lines.push('DM delivered.');
    }
    lines.push(...result.notes);

    return {
        embeds: [createEmbed({
            title: `${ACTION_LABELS[flow.type]} done — ${truncate(flow.targetUsername, 200)}`,
            description: truncate(lines.join('\n') || 'Done.', 4096),
            color: 'success',
        })],
        components: [],
    };
}

// ── Handlers ───────────────────────────────────────────────────────────────

/** Step 1 of a record action (ban/kick/mute/warn): the reason select. */
function reasonStepPayload(flow, moderatorId, nonce) {
    return {
        embeds: [stepEmbed(flow, flow.sourceMessageUrl
            ? `**Message:** ${flow.sourceMessageUrl} (attached as evidence)\nStep 1: choose a reason.`
            : 'Step 1: choose a reason.')],
        components: [reasonSelect(moderatorId, nonce, flow.type), cancelRow(moderatorId, nonce)],
    };
}

/**
 * "Warn for this message" (message context menu): starts the panel's warn flow in
 * the command's ephemeral reply, with the message link prefilled as evidence and
 * its excerpt captured now (so it survives deletion). The interaction must already
 * be deferred ephemerally; the following steps are ordinary panel components.
 */
export async function startWarnFromMessage(interaction, message, targetUser) {
    const moderatorId = interaction.user.id;
    const url = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
    const flow = {
        type: 'warn',
        moderatorId,
        targetId: targetUser.id,
        targetUsername: targetUser.username,
        nameIsDefault: true,
        sourceMessageUrl: url,
        evidenceInput: url,
        prefetchedExcerpts: new Map([[url, messageExcerpt(message)]]),
    };
    const nonce = createFlow(flow);
    return InteractionHelper.safeEditReply(interaction, reasonStepPayload(flow, moderatorId, nonce));
}

async function startAction(interaction, moderatorId, targetId, action) {
    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    if (!targetUser || !ACTION_LABELS[action]) {
        return expired(interaction);
    }

    const flow = startFlow({ type: action, moderatorId, targetUser });

    if (action === 'unban' || action === 'unmute') {
        const nonce = createFlow(flow);
        return InteractionHelper.safeShowModal(interaction, liftModal(flow, moderatorId, nonce));
    }

    if (action === 'removewarn') {
        await interaction.deferUpdate();
        const warns = await getCountedWarns(interaction.guildId, targetId, (await getTargetState(interaction.guild, targetId)).ladder.level);
        if (warns.length === 0) {
            throw userError('This user has no counted warnings to remove.');
        }
        const nonce = createFlow(flow);
        const select = new StringSelectMenuBuilder()
            .setCustomId(`enfsel:warn:${moderatorId}:${nonce}`)
            .setPlaceholder('Choose the warning to remove')
            .addOptions(warns.map((warn) => ({
                label: truncate(warn.name, 100),
                value: warn.case_code,
                description: truncate(`${warn.case_code} · ${warn.reason}`, 100),
            })));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [stepEmbed(flow, 'Which warning should be removed?')],
            components: [new ActionRowBuilder().addComponents(select), cancelRow(moderatorId, nonce)],
        });
    }

    const nonce = createFlow(flow);
    return interaction.update(reasonStepPayload(flow, moderatorId, nonce));
}

export async function handleEnforcementButton(interaction, client, args) {
    const [step, moderatorId, arg, action] = args;
    if (!(await guard(interaction, moderatorId))) return;

    if (step === 'act') {
        return startAction(interaction, moderatorId, arg, action);
    }

    if (step === 'cancel') {
        takeFlow(arg);
        return interaction.update({
            embeds: [createEmbed({ title: 'Cancelled', description: 'Nothing was changed. Run /enforcements to start again.', color: 'secondary' })],
            components: [],
        });
    }

    if (step === 'details') {
        const flow = getFlow(arg);
        if (!flow) return expired(interaction);
        return InteractionHelper.safeShowModal(interaction, detailsModal(flow, moderatorId, arg));
    }

    if (step === 'confirm') {
        await interaction.deferUpdate();
        const flow = takeFlow(arg);
        if (!flow) return expired(interaction);

        const targetUser = await client.users.fetch(flow.targetId);
        try {
            const result = await executeAction({ guild: interaction.guild, moderator: interaction.member, targetUser, flow });
            result.notes.push(...await attachFlowEvidence(flow, result.record, interaction.user));
            return InteractionHelper.safeEditReply(interaction, resultPayload(flow, result));
        } catch (error) {
            if (!error?.context?.expected) {
                logger.error('Enforcement action failed', { action: flow.type, targetId: flow.targetId, error });
            }
            const message = error.userMessage || 'Something went wrong; nothing may have changed. Check /background before retrying.';
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({ title: `${ACTION_LABELS[flow.type]} failed`, description: truncate(message, 4096), color: 'error' })],
                components: [],
            });
        }
    }

    return expired(interaction);
}

export async function handleEnforcementSelect(interaction, client, args) {
    const [step, moderatorId, nonce] = args;
    if (!(await guard(interaction, moderatorId))) return;

    const flow = getFlow(nonce);
    if (!flow) return expired(interaction);
    const value = interaction.values[0];

    if (step === 'reason') {
        updateFlow(nonce, reasonPatch(flow, value));
        return InteractionHelper.safeShowModal(interaction, detailsModal(getFlow(nonce), moderatorId, nonce));
    }

    if (step === 'warn') {
        updateFlow(nonce, { warnCode: value });
        return InteractionHelper.safeShowModal(interaction, liftModal(flow, moderatorId, nonce));
    }

    return expired(interaction);
}

export async function handleEnforcementModal(interaction, client, args) {
    const [step, moderatorId, nonce] = args;
    if (!(await guard(interaction, moderatorId))) return;

    await interaction.deferUpdate();
    const flow = getFlow(nonce);
    if (!flow) return expired(interaction);

    const guild = interaction.guild;
    const retryRow = cancelRow(moderatorId, nonce, RECORD_ACTIONS.has(flow.type)
        ? [new ButtonBuilder().setCustomId(`enf:details:${moderatorId}:${nonce}`).setLabel('Try again').setStyle(ButtonStyle.Primary)]
        : []);
    const fail = (message) => InteractionHelper.safeEditReply(interaction, {
        embeds: [stepEmbed(flow, `⚠️ ${message}`)],
        components: [retryRow],
    });

    if (step === 'lift') {
        updateFlow(nonce, liftReasonPatch(flow, interaction.fields.getTextInputValue('reason')));
        return InteractionHelper.safeEditReply(interaction, confirmationPayload(getFlow(nonce), moderatorId, nonce));
    }

    if (step !== 'details') return expired(interaction);

    const parsed = parseFlowInput(flow, {
        customReason: flow.reasonKey === CUSTOM_REASON_KEY ? interaction.fields.getTextInputValue('reason') : '',
        durationInput: flow.type === 'ban' || flow.type === 'mute' ? interaction.fields.getTextInputValue('duration') : '',
        unappealable: flow.type === 'ban' ? interaction.fields.getCheckbox('unappealable') : false,
        evidenceInput: interaction.fields.getTextInputValue('evidence'),
    });
    if (parsed.error) {
        const { evidenceEntries, ...keep } = parsed.patch;
        updateFlow(nonce, keep);
        return fail(parsed.error);
    }

    const targetUser = await client.users.fetch(flow.targetId);
    // Name, early hierarchy + bot permission checks (again on Confirm), ladder,
    // evidence excerpts (captured now, so they survive the message being deleted)
    // and the precedent hint.
    const { patch, error, fatal } = await completeFlowDetails({
        guild, moderator: interaction.member, targetUser, flow, patch: parsed.patch,
        customName: interaction.fields.getTextInputValue('name'),
    });
    if (fatal) {
        takeFlow(nonce);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [stepEmbed(flow, `⛔ ${fatal}`)],
            components: [],
        });
    }
    if (error) {
        updateFlow(nonce, patch);
        return fail(error);
    }

    updateFlow(nonce, patch);
    return InteractionHelper.safeEditReply(interaction, confirmationPayload(getFlow(nonce), moderatorId, nonce));
}
