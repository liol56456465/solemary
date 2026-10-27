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
import { enforcementConfig, ENFORCEMENT_REASONS, CUSTOM_REASON_KEY, getReason } from '../config/enforcement.js';
import { createEmbed } from '../utils/embeds.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger } from '../utils/logger.js';
import { createError, ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import {
    executeAction,
    getTargetState,
    isAdministrator,
    assertBotPermissions,
    assertCanTarget,
    previewWarn,
} from '../services/enforcement/enforcementService.js';
import {
    getCountedWarns,
    isNameTaken,
    listCasesForUser,
    getLatestAppealStatuses,
    caseStatusLabel,
    nextDefaultName,
} from '../services/enforcement/caseService.js';
import { createFlow, getFlow, takeFlow, updateFlow, PANEL_EXPIRED_MESSAGE } from '../services/enforcement/panelState.js';
import {
    addEvidence, captureLinks, MAX_LINKS_PER_FORM, messageExcerpt, parseEvidenceUrls,
} from '../services/enforcement/evidenceService.js';
import { dateStamp, formatDuration, parseDuration, stamp, truncate } from '../services/enforcement/format.js';
import { precedentHint } from '../services/enforcement/precedentService.js';

const ACTION_LABELS = {
    ban: 'Ban',
    kick: 'Kick',
    mute: 'Mute',
    warn: 'Warn',
    unban: 'Unban',
    unmute: 'Unmute',
    removewarn: 'Remove warn',
};
const ACTION_STYLES = {
    ban: ButtonStyle.Danger,
    kick: ButtonStyle.Danger,
    mute: ButtonStyle.Primary,
    warn: ButtonStyle.Primary,
    unban: ButtonStyle.Success,
    unmute: ButtonStyle.Success,
    removewarn: ButtonStyle.Secondary,
};
const RECORD_ACTIONS = new Set(['ban', 'kick', 'mute', 'warn']);

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

export function availableActions(state) {
    const actions = [];
    if (!state.banned) actions.push('ban');
    if (state.member) actions.push('kick');
    if (state.member && !state.muted) actions.push('mute');
    if (state.member) actions.push('warn');
    if (state.banned) actions.push('unban');
    if (state.muted) actions.push('unmute');
    if (state.ladder.warns_since_level > 0) actions.push('removewarn');
    return actions;
}

function relative(date) {
    return `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;
}

/**
 * The member summary at the top of the panel, so a moderator sees the history
 * before acting: account age, time in server, roles, warns and ladder, any active
 * punishment, pending appeals. (No message counts: member messages are not stored.)
 */
export function panelSummaryLines(targetUser, state, appealStatuses = new Map()) {
    const member = state.member;
    const roleCount = member ? Math.max(0, (member.roles?.cache?.size ?? 1) - 1) : null; // minus @everyone
    const lines = [
        `**User:** ${targetUser.username} (<@${targetUser.id}>) · \`${targetUser.id}\``,
        `**Account created:** ${dateStamp(targetUser.createdAt)} (${relative(targetUser.createdAt)})`,
        member
            ? `**In server:** yes, joined ${member.joinedAt ? `${dateStamp(member.joinedAt)} (${relative(member.joinedAt)})` : 'at an unknown time'} · ${roleCount} role${roleCount === 1 ? '' : 's'}`
            : '**In server:** no',
        `**Counted warns:** ${state.ladder.warns_since_level}${state.ladder.level === 0 ? ` of ${enforcementConfig.warnsPerLevel}` : ' (next warn bans)'} · **Ladder level:** ${state.ladder.level}`,
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
        description: truncate(panelSummaryLines(targetUser, state, appealStatuses).join('\n'), 4096),
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
    const lines = [`**User:** ${flow.targetUsername} (\`${flow.targetId}\`)`];

    if (RECORD_ACTIONS.has(flow.type)) {
        lines.push(`**Reason:** ${flow.reason}`);
        if (flow.type === 'ban') {
            lines.push(`**Duration:** ${flow.durationMs ? formatDuration(flow.durationMs) : 'Permanent'}`);
            lines.push(`**Appealable:** ${flow.unappealable ? 'No' : 'Yes'}`);
        }
        if (flow.type === 'mute') {
            lines.push(`**Duration:** ${formatDuration(flow.durationMs)}`);
        }
        lines.push(`**Name:** ${flow.nameIsDefault ? `${flow.name} (default)` : flow.name}`);
        if (flow.evidence?.length) {
            lines.push(`**Evidence:** ${flow.evidence.map((item) => (item.excerpt
                ? `${item.url} ("${truncate(item.excerpt.replace(/\s+/g, ' '), 80)}")`
                : `${item.url}${item.sourceMessageUrl ? ' (message not readable, link only)' : ''}`)).join('\n')}`);
        }
        if (flow.type === 'warn') {
            const step = previewWarn(flow.ladder);
            lines.push(step.escalates
                ? `**Effect:** reaches the warning limit → automatic ${step.banDurationMs ? formatDuration(step.banDurationMs) : 'permanent'} ban (ladder level ${step.nextLevel}).`
                : `**Effect:** warning ${step.warnNumber} of ${step.threshold}.`);
        }
        if (flow.type === 'ban' || flow.type === 'kick') {
            lines.push('The user is DMed before the action runs.');
        }
        if (flow.precedent) {
            lines.push(`-# ${flow.precedent}`);
        }
    } else {
        if (flow.type === 'removewarn') {
            lines.push(`**Warning:** \`${flow.warnCode}\``);
        }
        lines.push(`**Reason:** ${flow.reason}`);
    }

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

/**
 * Stores the links captured in the details form on the new case. Never throws: the
 * action already ran, so a failure only becomes a note for the moderator.
 */
export async function attachFlowEvidence(flow, record, moderatorUser) {
    if (!record || !flow.evidence?.length) return [];
    const addedBy = { id: moderatorUser.id, username: moderatorUser.username };
    let saved = 0;
    const notes = [];
    for (const item of flow.evidence) {
        try {
            await addEvidence(record.case_code, { kind: 'link', url: item.url, sourceMessageUrl: item.sourceMessageUrl, excerpt: item.excerpt, addedBy });
            saved += 1;
        } catch (error) {
            if (!error?.context?.expected) logger.error('Could not attach evidence', { caseCode: record.case_code, error });
            notes.push(`⚠️ Evidence ${item.url} was not saved: ${error.userMessage || error.message}`);
        }
    }
    if (saved) notes.unshift(`Evidence attached: ${saved} link${saved === 1 ? '' : 's'}.`);
    return notes;
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

    const flow = {
        type: action,
        moderatorId,
        targetId,
        targetUsername: targetUser.username,
        nameIsDefault: true,
    };

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
        const reason = getReason(value);
        updateFlow(nonce, {
            reasonKey: value,
            reasonSource: reason ? 'prebuilt' : 'custom',
            reason: reason ? reason.label : flow.customReason,
            // Severe reasons pre-check "Unappealable"; the moderator can still untick it.
            unappealable: flow.type === 'ban' ? Boolean(reason?.severe) : false,
        });
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
        const reason = interaction.fields.getTextInputValue('reason')?.trim();
        updateFlow(nonce, { reason: reason || `${ACTION_LABELS[flow.type]} via /enforcements` });
        return InteractionHelper.safeEditReply(interaction, confirmationPayload(getFlow(nonce), moderatorId, nonce));
    }

    if (step !== 'details') return expired(interaction);

    const patch = {};
    if (flow.reasonKey === CUSTOM_REASON_KEY) {
        patch.customReason = interaction.fields.getTextInputValue('reason').trim();
        patch.reason = patch.customReason;
        if (!patch.reason) return fail('A custom reason is required.');
    }

    if (flow.type === 'ban' || flow.type === 'mute') {
        const raw = interaction.fields.getTextInputValue('duration')?.trim() || '';
        patch.durationInput = raw;
        if (!raw && flow.type === 'mute') {
            updateFlow(nonce, patch);
            return fail('A mute needs a duration, e.g. 30m, 24h, 7d or 1mo.');
        }
        patch.durationMs = raw ? parseDuration(raw) : null;
        if (raw && patch.durationMs == null) {
            updateFlow(nonce, patch);
            return fail(`"${truncate(raw, 20)}" is not a valid duration. Use formats like 30m, 24h, 7d or 1mo.`);
        }
    }

    if (flow.type === 'ban') {
        patch.unappealable = interaction.fields.getCheckbox('unappealable');
    }

    const evidenceRaw = interaction.fields.getTextInputValue('evidence')?.trim() || '';
    patch.evidenceInput = evidenceRaw;
    const evidenceEntries = parseEvidenceUrls(evidenceRaw);
    if (evidenceRaw && evidenceEntries.length === 0) {
        updateFlow(nonce, patch);
        return fail('Evidence must be links (e.g. a Discord message link: right-click a message → Copy Message Link).');
    }
    if (evidenceEntries.length > MAX_LINKS_PER_FORM) {
        updateFlow(nonce, patch);
        return fail(`At most ${MAX_LINKS_PER_FORM} evidence links here; add more afterwards with /case evidence add.`);
    }

    const targetUser = await client.users.fetch(flow.targetId);
    const customName = interaction.fields.getTextInputValue('name')?.trim();
    if (customName) {
        patch.name = customName;
        patch.nameIsDefault = false;
        if (await isNameTaken(guild.id, customName)) {
            updateFlow(nonce, { ...patch, name: undefined, nameIsDefault: true });
            return fail(`A record named **${truncate(customName, 100)}** already exists in this server. Pick another name.`);
        }
    } else {
        patch.name = await nextDefaultName(guild.id, targetUser.id, targetUser.username, flow.type);
        patch.nameIsDefault = true;
    }

    // Fail early on hierarchy and bot permissions; both are checked again on Confirm.
    try {
        assertBotPermissions(guild);
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        assertCanTarget(guild, interaction.member, targetUser.id, targetMember, flow.type);
    } catch (error) {
        takeFlow(nonce);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [stepEmbed(flow, `⛔ ${error.userMessage || error.message}`)],
            components: [],
        });
    }

    if (flow.type === 'warn') {
        patch.ladder = (await getTargetState(guild, targetUser.id)).ladder;
    }

    // Excerpts are captured now, so the evidence survives the message being deleted
    // before Confirm.
    // The precedent hint waits briefly at most and is left out on any problem.
    [patch.evidence, patch.precedent] = await Promise.all([
        captureLinks(guild, evidenceEntries, { prefetched: flow.prefetchedExcerpts }),
        precedentHint(guild.id, flow.reasonKey, getReason(flow.reasonKey)?.label || flow.reasonKey),
    ]);

    updateFlow(nonce, patch);
    return InteractionHelper.safeEditReply(interaction, confirmationPayload(getFlow(nonce), moderatorId, nonce));
}
