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
import { botText, resolveBotLanguage } from '../utils/botText.js';
import { caseStatusCode } from '../services/enforcement/caseService.js';
import { ladderStageShortIn } from '../services/enforcement/precedentService.js';
import { createError, ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import {
    executeAction,
    getTargetState,
    isAdministrator,
} from '../services/enforcement/enforcementService.js';
import {
    getCountedWarns,
    getUncountedWarns,
    listCasesForUser,
    getLatestAppealStatuses,
    caseStatusLabel,
} from '../services/enforcement/caseService.js';
import { warmPrecedent } from '../services/enforcement/precedentService.js';
import { createFlow, getFlow, takeFlow, updateFlow, PANEL_EXPIRED_MESSAGE } from '../services/enforcement/panelState.js';
import { MAX_LINKS_PER_FORM, messageExcerpt } from '../services/enforcement/evidenceService.js';
import { dateStamp, stamp, truncate } from '../services/enforcement/format.js';
import { getActiveOrdersFor, noContactLines } from '../services/enforcement/noContactService.js';
import { templateLabel, templatePatch, usableTemplates } from '../services/enforcement/templateService.js';
import { resolveSetting } from '../services/settings/guildSettings.js';
import {
    ACTION_LABELS, RECORD_ACTIONS, actionLabelIn, attachFlowEvidence, availableActions, completeFlowDetails, countedWarnsText,
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

/** The panel's language: the moderator's Discord language (ephemeral replies, utils/botText.js). */
function langOf(interaction) {
    return resolveBotLanguage({ interaction, guildId: interaction.guildId, userId: interaction.user?.id, purpose: 'reply' });
}

/** A case's status in a language (caseService.caseStatusLabel is the English words). */
function statusIn(row, appealStatus, lang) {
    if (lang === 'en') return caseStatusLabel(row, appealStatus);
    const tr = botText(lang);
    switch (caseStatusCode(row, appealStatus)) {
        case 'voided': return tr.t('staff.panel.status.voided');
        case 'liftedByAppeal': return tr.t('staff.panel.status.liftedByAppeal');
        case 'reversed': return tr.t('staff.panel.status.reversed');
        case 'lifted': return tr.t('staff.panel.status.lifted');
        case 'appealPending': return tr.t('staff.panel.status.appealPending');
        case 'activeAppealDenied': return tr.t('staff.panel.status.activeAppealDenied');
        case 'expired': return tr.t('staff.panel.status.expired');
        case 'active': return tr.t('staff.panel.status.active');
        default: return caseStatusLabel(row, appealStatus);
    }
}

/** A case type ("ban", "warn") in a language; anything else as stored. */
function typeIn(type, lang) {
    if (lang === 'en') return type;
    const tr = botText(lang);
    switch (type) {
        case 'ban': return tr.t('staff.panel.type.ban');
        case 'kick': return tr.t('staff.panel.type.kick');
        case 'mute': return tr.t('staff.panel.type.mute');
        case 'warn': return tr.t('staff.panel.type.warn');
        default: return type;
    }
}

// ── Guards ─────────────────────────────────────────────────────────────────

/** Returns true when the clicker may use this component; otherwise replies and returns false. */
async function guard(interaction, moderatorId) {
    // Ephemeral refusals: the clicker's Discord language (utils/botText.js).
    const tr = botText(langOf(interaction));
    if (interaction.user.id !== moderatorId) {
        await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: tr.t('errors.panel.otherModerator'),
        });
        return false;
    }
    // Any server (multi-server B1): the panel acts in the server it was opened in (interaction.guild).
    if (!interaction.inGuild()) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('errors.panel.serverOnly') });
        return false;
    }
    if (!isAdministrator(interaction.member)) {
        await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: tr.t('errors.panel.noAdmin'),
        });
        return false;
    }
    return true;
}

async function expired(interaction) {
    const tr = botText(langOf(interaction));
    const description = tr.lang === 'en' ? PANEL_EXPIRED_MESSAGE : tr.t('staff.panel.expired');
    const payload = { embeds: [createEmbed({ title: tr.t('staff.panel.expiredTitle'), description, color: 'warning' })], components: [] };
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
export function panelSummaryLines(targetUser, state, appealStatuses = new Map(), noContact = [], { lang = 'en' } = {}) {
    const tr = botText(lang);
    const member = state.member;
    const roleCount = member ? Math.max(0, (member.roles?.cache?.size ?? 1) - 1) : null; // minus @everyone
    const lines = [
        tr.t('staff.panel.info.user', { username: targetUser.username, id: targetUser.id }),
        tr.t('staff.panel.info.accountCreated', { date: dateStamp(targetUser.createdAt), relative: relative(targetUser.createdAt) }),
        member
            ? tr.t('staff.panel.info.inServerYes', {
                joined: member.joinedAt ? tr.t('staff.panel.info.joinedAt', { date: dateStamp(member.joinedAt), relative: relative(member.joinedAt) }) : tr.t('staff.panel.info.joinedUnknown'),
                roles: tr.tp('staff.panel.info.roles', roleCount),
            })
            : tr.t('staff.panel.info.inServerNo'),
        tr.t('staff.panel.info.warns', { warns: countedWarnsText(state.ladder, { lang }), stage: ladderStageShortIn(state.ladder.level, { lang }) }),
        ...(state.uncountedWarns > 0 ? [tr.tp('staff.panel.info.uncountedWarns', state.uncountedWarns)] : []),
    ];

    const active = [];
    if (state.activeBan) {
        active.push(state.activeBan.expires_at
            ? tr.t('staff.panel.info.activeBanEnds', { code: state.activeBan.case_code, date: stamp(state.activeBan.expires_at) })
            : tr.t('staff.panel.info.activeBanPermanent', { code: state.activeBan.case_code }));
    } else if (state.banned) {
        active.push(tr.t('staff.panel.info.bannedNoRecord'));
    }
    if (state.activeMute) {
        active.push(tr.t('staff.panel.info.activeMute', { code: state.activeMute.case_code, date: stamp(state.activeMute.expires_at) }));
    } else if (state.muted) {
        active.push(tr.t('staff.panel.info.mutedNoRecord'));
    }
    lines.push(tr.t('staff.panel.info.active', { list: active.length ? active.join('; ') : tr.t('staff.panel.info.activeNone') }));

    const pendingAppeals = [...appealStatuses].filter(([, status]) => status === 'pending').map(([code]) => `\`${code}\``);
    if (pendingAppeals.length) {
        lines.push(tr.t('staff.panel.info.pendingAppeal', { codes: pendingAppeals.join(', ') }));
    }
    if (noContact.length) {
        lines.push(tr.t('staff.panel.info.keepApart', { list: noContactLines(noContact, { lang }).join('; ') }));
    }
    return lines;
}

/** "Last cases" field: type, name, date and status of the newest few. */
export function recentCasesText(rows, total, appealStatuses = new Map(), { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!rows.length) return tr.t('staff.panel.recent.none');
    const lines = rows.map((row) => tr.t('staff.panel.recent.line', {
        code: row.case_code,
        type: typeIn(row.type, lang),
        test: row.is_test ? tr.t('staff.panel.recent.test') : '',
        name: truncate(row.name, 60),
        date: `<t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:d>`,
        status: statusIn(row, appealStatuses.get(row.case_code), lang),
        imported: row.is_imported ? tr.t('staff.panel.recent.imported') : '',
    }));
    if (total > rows.length) lines.push(tr.tp('staff.panel.recent.older', total - rows.length));
    return lines.join('\n');
}

const RECENT_CASES_SHOWN = 3;

/** The panel for one member. `lang`: the moderator's language (the panel is an ephemeral reply). */
export async function buildPanel(guild, moderatorId, targetUser, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const state = await getTargetState(guild, targetUser.id);
    const [{ rows: recent, total }, appealStatuses] = await Promise.all([
        listCasesForUser(guild.id, targetUser.id, { limit: RECENT_CASES_SHOWN }),
        getLatestAppealStatuses(targetUser.id, guild.id),
    ]);

    const embed = createEmbed({
        title: tr.t('staff.panel.title', { name: truncate(targetUser.username, 200) }),
        description: truncate(panelSummaryLines(targetUser, state, appealStatuses, getActiveOrdersFor(guild.id, targetUser.id), { lang }).join('\n'), 4096),
        fields: [{
            name: total ? tr.t('staff.panel.recent.titleCount', { shown: Math.min(total, RECENT_CASES_SHOWN), total }) : tr.t('staff.panel.recent.title'),
            value: truncate(recentCasesText(recent, total, appealStatuses, { lang }), 1024),
        }],
        thumbnail: targetUser.displayAvatarURL(),
        color: 'primary',
    });

    const buttons = availableActions(state).map((action) => new ButtonBuilder()
        .setCustomId(`enf:act:${moderatorId}:${targetUser.id}:${action}`)
        .setLabel(actionLabelIn(action, { lang }))
        .setStyle(ACTION_STYLES[action]));

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    const templates = usableTemplates(readTemplates(guild.id), availableActions(state));
    if (templates.length) {
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`enfsel:tpl:${moderatorId}:${targetUser.id}`)
            .setPlaceholder(tr.t('staff.panel.templatePlaceholder'))
            .addOptions(templates.map(({ index, template }) => ({
                label: truncate(template.name, 100),
                value: String(index),
                description: truncate(`${templateLabel(template, { lang })} · ${ENFORCEMENT_REASONS.find((r) => r.key === template.reasonKey)?.label || template.reasonKey}`, 100),
            })))));
    }
    return { embeds: [embed], components: rows };
}

/**
 * This server's saved templates (enforcementTemplates; resolveSetting, so never another
 * server's). A non-home server whose settings could not be read throws
 * SettingsUnavailableError, which reaches the interaction error handler.
 */
export function readTemplates(guildId) {
    const list = resolveSetting(guildId, 'enforcementTemplates');
    return Array.isArray(list) ? list : [];
}

/** A template from the panel: same flow as the buttons, with reason and duration filled in. */
async function startTemplate(interaction, client, moderatorId, targetId, index) {
    const lang = langOf(interaction);
    const tr = botText(lang);
    const template = readTemplates(interaction.guildId)[Number(index)];
    await interaction.deferUpdate();
    const targetUser = await client.users.fetch(targetId).catch(() => null);
    const state = targetUser ? await getTargetState(interaction.guild, targetId) : null;
    if (!template || !targetUser || !availableActions(state).includes(template.action)) {
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({ title: tr.t('staff.panel.templateGoneTitle'), description: tr.t('staff.panel.templateGone'), color: 'warning' })],
            components: [],
        });
    }
    const flow = { ...startFlow({ type: template.action, moderatorId, targetUser }), ...templatePatch(template) };
    const nonce = createFlow(flow);
    if (RECORD_ACTIONS.has(flow.type)) warmPrecedent(interaction.guildId, flow.reasonKey);
    const { patch, error, fatal } = await completeFlowDetails({
        guild: interaction.guild, moderator: interaction.member, targetUser, flow,
        patch: { durationInput: flow.durationInput, durationMs: flow.durationMs, unappealable: flow.unappealable, evidenceInput: '', evidenceEntries: [] },
        lang,
    });
    if (fatal || error) {
        takeFlow(nonce);
        return InteractionHelper.safeEditReply(interaction, { embeds: [stepEmbed(flow, fatal || error, { lang })], components: [] });
    }
    updateFlow(nonce, patch);
    return InteractionHelper.safeEditReply(interaction, confirmationPayload(getFlow(nonce), moderatorId, nonce, { guildId: interaction.guildId, lang }));
}

// ── Flow steps ─────────────────────────────────────────────────────────────

function reasonSelect(moderatorId, nonce, action, { lang = 'en' } = {}) {
    const tr = botText(lang);
    // The prebuilt reason labels stay as configured (config/enforcement.js): they are stored on the case.
    const options = [
        ...ENFORCEMENT_REASONS.map((reason) => ({
            label: reason.label,
            value: reason.key,
            description: action === 'ban' && reason.severe ? tr.t('staff.panel.reason.severe') : undefined,
        })),
        { label: tr.t('staff.panel.reason.custom'), value: CUSTOM_REASON_KEY, description: tr.t('staff.panel.reason.customHint') },
    ];
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`enfsel:reason:${moderatorId}:${nonce}`)
        .setPlaceholder(tr.t('staff.panel.reason.placeholder'))
        .addOptions(options));
}

function cancelRow(moderatorId, nonce, extra = [], { lang = 'en' } = {}) {
    return new ActionRowBuilder().addComponents(
        ...extra,
        new ButtonBuilder().setCustomId(`enf:cancel:${moderatorId}:${nonce}`).setLabel(botText(lang).t('staff.panel.button.cancel')).setStyle(ButtonStyle.Secondary),
    );
}

function stepEmbed(flow, description, { lang = 'en' } = {}) {
    return createEmbed({
        title: botText(lang).t('staff.panel.stepTitle', { action: actionLabelIn(flow.type, { lang }), name: truncate(flow.targetUsername, 200) }),
        description,
        color: 'primary',
    });
}

function detailsModal(flow, moderatorId, nonce, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const modal = new ModalBuilder()
        .setCustomId(`enfmodal:details:${moderatorId}:${nonce}`)
        .setTitle(truncate(`${actionLabelIn(flow.type, { lang })} ${flow.targetUsername}`, 45));

    if (flow.reasonKey === CUSTOM_REASON_KEY) {
        modal.addLabelComponents(new LabelBuilder()
            .setLabel(tr.t('staff.panel.modal.customReason'))
            .setTextInputComponent(new TextInputBuilder()
                .setCustomId('reason')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(500)
                .setRequired(true)
                .setValue(flow.customReason || '')));
    }

    if (flow.type === 'ban' || flow.type === 'mute') {
        modal.addLabelComponents(new LabelBuilder()
            .setLabel(tr.t('staff.panel.modal.duration'))
            .setDescription(flow.type === 'ban'
                ? tr.t('staff.panel.modal.durationBan')
                : tr.t('staff.panel.modal.durationMute'))
            .setTextInputComponent(new TextInputBuilder()
                .setCustomId('duration')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(20)
                .setRequired(flow.type === 'mute')
                .setValue(flow.durationInput || '')));
    }

    modal.addLabelComponents(new LabelBuilder()
        .setLabel(tr.t('staff.panel.modal.name'))
        .setDescription(truncate(tr.t('staff.panel.modal.nameDefault', { name: truncate(`${flow.targetUsername} ${flow.type} <n>`, 90) }), 100))
        .setTextInputComponent(new TextInputBuilder()
            .setCustomId('name')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(false)
            .setValue(flow.nameIsDefault ? '' : (flow.name || ''))));

    // Every record action has room: at most custom reason + duration + name +
    // evidence + unappealable = 5 inputs (a ban), Discord's limit.
    modal.addLabelComponents(new LabelBuilder()
        .setLabel(tr.t('staff.panel.modal.evidence'))
        .setDescription(tr.t('staff.panel.modal.evidenceHint', { max: MAX_LINKS_PER_FORM }))
        .setTextInputComponent(new TextInputBuilder()
            .setCustomId('evidence')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1000)
            .setRequired(false)
            .setValue(flow.evidenceInput || '')));

    if (flow.type === 'ban') {
        modal.addLabelComponents(new LabelBuilder()
            .setLabel(tr.t('staff.panel.modal.unappealable'))
            .setDescription(tr.t('staff.panel.modal.unappealableHint'))
            .setCheckboxComponent(new CheckboxBuilder()
                .setCustomId('unappealable')
                .setDefault(Boolean(flow.unappealable))));
    }

    return modal;
}

function liftModal(flow, moderatorId, nonce, { lang = 'en' } = {}) {
    return new ModalBuilder()
        .setCustomId(`enfmodal:lift:${moderatorId}:${nonce}`)
        .setTitle(truncate(`${actionLabelIn(flow.type, { lang })} ${flow.targetUsername}`, 45))
        .addLabelComponents(new LabelBuilder()
            .setLabel(botText(lang).t('staff.panel.modal.reasonOptional'))
            .setTextInputComponent(new TextInputBuilder()
                .setCustomId('reason')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(500)
                .setRequired(false)));
}

/** The confirm step (exported for tests). `guildId`: the server acting (its rule hint). */
export function confirmationPayload(flow, moderatorId, nonce, { guildId = null, lang = 'en' } = {}) {
    const tr = botText(lang);
    const summary = flowSummary(flow, { guildId, lang });
    const lines = summary.rows.map((row) => (row.id
        ? `**${row.label}:** ${row.value} (\`${row.id}\`)`
        : `**${row.label}:** ${row.code ? `\`${row.value}\`` : row.value}`));
    if (summary.evidence.length) {
        lines.push(tr.t('staff.panel.confirm.evidence', { list: summary.evidence.map((item) => (item.excerpt
            ? `${item.url} ("${truncate(item.excerpt.replace(/\s+/g, ' '), 80)}")`
            : `${item.url}${item.unreadable ? tr.t('staff.panel.confirm.unreadable') : ''}`)).join('\n') }));
    }
    if (flow.templateName) lines.unshift(tr.t('staff.panel.confirm.template', { name: truncate(flow.templateName, 60) }));
    if (summary.effect) lines.push(tr.t('staff.panel.confirm.effect', { effect: summary.effect }));
    lines.push(...summary.notes);
    // Consistency hints (read-only): similar cases for this reason + the target's ladder.
    if (summary.precedent) lines.push(`-# ${summary.precedent}`);
    if (summary.memberHint) lines.push(`-# ${summary.memberHint}`);
    if (summary.ruleHint) lines.push(`-# ${summary.ruleHint}`);

    return {
        embeds: [createEmbed({
            title: tr.t('staff.panel.confirm.title', { action: actionLabelIn(flow.type, { lang }) }),
            description: truncate(lines.join('\n'), 4096),
            color: flow.type === 'ban' || flow.type === 'kick' ? 'error' : 'warning',
        })],
        components: [cancelRow(moderatorId, nonce, [
            new ButtonBuilder().setCustomId(`enf:confirm:${moderatorId}:${nonce}`).setLabel(tr.t('staff.panel.button.confirm')).setStyle(ButtonStyle.Danger),
            ...(RECORD_ACTIONS.has(flow.type)
                ? [new ButtonBuilder().setCustomId(`enf:details:${moderatorId}:${nonce}`).setLabel(tr.t('staff.panel.button.editDetails')).setStyle(ButtonStyle.Secondary)]
                : []),
        ], { lang })],
    };
}

/** The result step (exported for tests). Notes from executeAction stay as the service wrote them. */
export function resultPayload(flow, result, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const lines = [];
    if (result.record) {
        lines.push(tr.t('staff.panel.result.caseCode', { code: result.record.case_code }), tr.t('staff.panel.result.name', { name: result.record.name }));
        if (result.record.expires_at) {
            lines.push(tr.t('staff.panel.result.ends', { date: stamp(result.record.expires_at) }));
        }
    }
    if (result.dmDelivered === false) {
        lines.push(tr.t('staff.panel.result.dmFailed'));
    } else if (result.dmDelivered === true) {
        lines.push(tr.t('staff.panel.result.dmDelivered'));
    }
    lines.push(...result.notes);

    return {
        embeds: [createEmbed({
            title: tr.t('staff.panel.result.title', { action: actionLabelIn(flow.type, { lang }), name: truncate(flow.targetUsername, 200) }),
            description: truncate(lines.join('\n') || tr.t('staff.panel.result.done'), 4096),
            color: 'success',
        })],
        components: [],
    };
}

// ── Handlers ───────────────────────────────────────────────────────────────

/** Step 1 of a record action (ban/kick/mute/warn): the reason select. */
function reasonStepPayload(flow, moderatorId, nonce, { lang = 'en' } = {}) {
    const tr = botText(lang);
    return {
        embeds: [stepEmbed(flow, flow.sourceMessageUrl
            ? tr.t('staff.panel.step.reasonWithMessage', { url: flow.sourceMessageUrl })
            : tr.t('staff.panel.step.reason'), { lang })],
        components: [reasonSelect(moderatorId, nonce, flow.type, { lang }), cancelRow(moderatorId, nonce, [], { lang })],
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
    return InteractionHelper.safeEditReply(interaction, reasonStepPayload(flow, moderatorId, nonce, { lang: langOf(interaction) }));
}

// Unban/unmute answer with a form, which must be the first response within 3 s: the target
// comes from the user cache (the panel just fetched it) or a REST fetch with this budget.
const MODAL_USER_FETCH_BUDGET_MS = 1200;

async function fetchUserWithin(client, userId, ms) {
    const cached = client.users.cache.get(userId);
    if (cached) return cached;
    let timer;
    const fetching = client.users.fetch(userId).catch(() => null);
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    try {
        return await Promise.race([fetching, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function startAction(interaction, moderatorId, targetId, action) {
    const lang = langOf(interaction);
    const tr = botText(lang);
    const opensForm = action === 'unban' || action === 'unmute';
    // Steps without a form acknowledge first (the user fetch may be a REST call).
    if (!opensForm && ACTION_LABELS[action]) await interaction.deferUpdate();
    const targetUser = opensForm
        ? await fetchUserWithin(interaction.client, targetId, MODAL_USER_FETCH_BUDGET_MS)
        : await interaction.client.users.fetch(targetId).catch(() => null);
    if (!targetUser || !ACTION_LABELS[action]) {
        return expired(interaction);
    }

    const flow = startFlow({ type: action, moderatorId, targetUser });

    if (opensForm) {
        const nonce = createFlow(flow);
        return InteractionHelper.safeShowModal(interaction, liftModal(flow, moderatorId, nonce, { lang }));
    }

    if (action === 'removewarn') {
        const level = (await getTargetState(interaction.guild, targetId)).ladder.level;
        // Counted warns first, then the ones that never counted toward the ladder (labelled; D4).
        const [counted, uncounted] = await Promise.all([
            getCountedWarns(interaction.guildId, targetId, level),
            getUncountedWarns(interaction.guildId, targetId),
        ]);
        const uncountedTag = tr.t('staff.panel.removeWarn.uncountedTag');
        const warns = [...counted, ...uncounted.map((warn) => ({ ...warn, tag: uncountedTag }))].slice(0, 25);
        if (warns.length === 0) {
            throw userError(tr.t('staff.panel.removeWarn.none'));
        }
        const nonce = createFlow(flow);
        const select = new StringSelectMenuBuilder()
            .setCustomId(`enfsel:warn:${moderatorId}:${nonce}`)
            .setPlaceholder(tr.t('staff.panel.removeWarn.placeholder'))
            .addOptions(warns.map((warn) => ({
                label: truncate(warn.name, 100),
                value: warn.case_code,
                description: truncate(`${warn.case_code} · ${warn.tag ? `${warn.tag} · ` : ''}${warn.reason}`, 100),
            })));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [stepEmbed(flow, tr.t('staff.panel.removeWarn.which'), { lang })],
            components: [new ActionRowBuilder().addComponents(select), cancelRow(moderatorId, nonce, [], { lang })],
        });
    }

    const nonce = createFlow(flow);
    return InteractionHelper.safeEditReply(interaction, reasonStepPayload(flow, moderatorId, nonce, { lang }));
}

export async function handleEnforcementButton(interaction, client, args) {
    const [step, moderatorId, arg, action] = args;
    if (!(await guard(interaction, moderatorId))) return;

    if (step === 'act') {
        return startAction(interaction, moderatorId, arg, action);
    }

    const lang = langOf(interaction);
    const tr = botText(lang);
    if (step === 'cancel') {
        takeFlow(arg);
        return interaction.update({
            embeds: [createEmbed({ title: tr.t('staff.panel.cancelledTitle'), description: tr.t('staff.panel.cancelled'), color: 'secondary' })],
            components: [],
        });
    }

    if (step === 'details') {
        const flow = getFlow(arg);
        if (!flow) return expired(interaction);
        return InteractionHelper.safeShowModal(interaction, detailsModal(flow, moderatorId, arg, { lang }));
    }

    if (step === 'confirm') {
        await interaction.deferUpdate();
        const flow = takeFlow(arg);
        if (!flow) return expired(interaction);

        const targetUser = await client.users.fetch(flow.targetId);
        try {
            const result = await executeAction({ guild: interaction.guild, moderator: interaction.member, targetUser, flow, lang });
            result.notes.push(...await attachFlowEvidence(flow, result.record, interaction.user, { lang }));
            return InteractionHelper.safeEditReply(interaction, resultPayload(flow, result, { lang }));
        } catch (error) {
            if (!error?.context?.expected) {
                logger.error('Enforcement action failed', { action: flow.type, targetId: flow.targetId, error });
            }
            const message = error.userMessage || tr.t('staff.panel.failedGeneric');
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({ title: tr.t('staff.panel.failedTitle', { action: actionLabelIn(flow.type, { lang }) }), description: truncate(message, 4096), color: 'error' })],
                components: [],
            });
        }
    }

    return expired(interaction);
}

export async function handleEnforcementSelect(interaction, client, args) {
    const [step, moderatorId, nonce] = args;
    if (!(await guard(interaction, moderatorId))) return;
    // Templates carry the target id (no flow yet).
    if (step === 'tpl') return startTemplate(interaction, client, moderatorId, nonce, interaction.values[0]);

    const flow = getFlow(nonce);
    if (!flow) return expired(interaction);
    const value = interaction.values[0];

    if (step === 'reason') {
        updateFlow(nonce, reasonPatch(flow, value));
        // Start the similar-cases query now (not awaited: the modal must open within 3 s),
        // so the confirm step usually finds it cached.
        if (RECORD_ACTIONS.has(flow.type)) warmPrecedent(interaction.guildId, value);
        return InteractionHelper.safeShowModal(interaction, detailsModal(getFlow(nonce), moderatorId, nonce, { lang: langOf(interaction) }));
    }

    if (step === 'warn') {
        updateFlow(nonce, { warnCode: value });
        return InteractionHelper.safeShowModal(interaction, liftModal(flow, moderatorId, nonce, { lang: langOf(interaction) }));
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
    const lang = langOf(interaction);
    const retryRow = cancelRow(moderatorId, nonce, RECORD_ACTIONS.has(flow.type)
        ? [new ButtonBuilder().setCustomId(`enf:details:${moderatorId}:${nonce}`).setLabel(botText(lang).t('staff.panel.button.tryAgain')).setStyle(ButtonStyle.Primary)]
        : [], { lang });
    const fail = (message) => InteractionHelper.safeEditReply(interaction, {
        embeds: [stepEmbed(flow, message, { lang })],
        components: [retryRow],
    });

    if (step === 'lift') {
        // The default reason ("Unban via /enforcements") is stored on the case: it stays English.
        updateFlow(nonce, liftReasonPatch(flow, interaction.fields.getTextInputValue('reason')));
        return InteractionHelper.safeEditReply(interaction, confirmationPayload(getFlow(nonce), moderatorId, nonce, { guildId: interaction.guildId, lang }));
    }

    if (step !== 'details') return expired(interaction);

    const parsed = parseFlowInput(flow, {
        customReason: flow.reasonKey === CUSTOM_REASON_KEY ? interaction.fields.getTextInputValue('reason') : '',
        durationInput: flow.type === 'ban' || flow.type === 'mute' ? interaction.fields.getTextInputValue('duration') : '',
        unappealable: flow.type === 'ban' ? interaction.fields.getCheckbox('unappealable') : false,
        evidenceInput: interaction.fields.getTextInputValue('evidence'),
    }, { lang });
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
        lang,
    });
    if (fatal) {
        takeFlow(nonce);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [stepEmbed(flow, fatal, { lang })],
            components: [],
        });
    }
    if (error) {
        updateFlow(nonce, patch);
        return fail(error);
    }

    updateFlow(nonce, patch);
    return InteractionHelper.safeEditReply(interaction, confirmationPayload(getFlow(nonce), moderatorId, nonce, { guildId: interaction.guildId, lang }));
}
