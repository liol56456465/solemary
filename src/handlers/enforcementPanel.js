// enforcementPanel.js — the /enforcements panel and its components.
//
// custom_id layout: <handler>:<step>:<moderatorId>:<arg>
//   enf:act:<mod>:<target>:<action>   action buttons on the panel
//   enf:confirm|cancel|details:<mod>:<nonce>
//   enfsel:reason|warn:<mod>:<nonce>
//   enfmodal:details|lift:<mod>:<nonce>
//   enf:act:<mod>:<target>:unban:ladder   Unban of an automatic ladder ban (asks: unban only / remove the warn)
//   enf:final:<mod>:<nonce>              second confirm (permanent ban the member cannot appeal)
//   enf:unbanonly:<mod>:<nonce>          "Unban only (stage stays)" → the unban form
//   enf:undo|undook:<mod>:<nonce>        "Undo (mistake)" → its confirm → voidCase
// Every component re-checks that the clicker is that moderator and still may use the panel
// (Administrator; in servers that are not Mewvo's own also the Moderator role, for Warn, Mute,
// Kick, Unmute and Remove warn only: services/enforcement/panelAccess.js) before doing anything.

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
import { botText, resolveBotLanguage } from '../utils/botText.js';
import { caseStatusCode } from '../services/enforcement/caseService.js';
import { formatPrecedent } from '../services/enforcement/precedentService.js';
import { createError, ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import {
    assertBotPermissions,
    assertCanTarget,
    executeAction,
    getLadder,
    getTargetState,
    previewWarn,
} from '../services/enforcement/enforcementService.js';
import { voidCase } from '../services/enforcement/caseEditService.js';
import { ALL_PANEL_ACTIONS, panelAccessFor, panelActionAllowed, refusalKey, staffRoleFor } from '../services/enforcement/panelAccess.js';
import {
    getCaseByCode,
    getCountedWarns,
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
    ACTION_LABELS, LIFT_ACTIONS, RECORD_ACTIONS, actionLabelIn, attachFlowEvidence, availableActions, completeFlowDetails,
    flowSummary, liftReasonPatch, needsSecondConfirm, nextWarnText, parseFlowInput, reasonPatch, startFlow, warnStatusText,
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
// Panel replies are ephemeral embeds, but no user-supplied text may ping anyone (CLAUDE.md).
const NO_PINGS = Object.freeze({ parse: [] });

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

/**
 * Returns the clicker's panel access (panelAccess.js) when they may use this component for
 * `action` (null: cancel, or a step whose flow is gone); otherwise replies and returns null.
 * `checkBot`: also check Mewvo's permissions for `action` now (the action buttons, before any
 * form is filled in). The refusal must answer within 3 s: the role read has a budget.
 */
async function guard(interaction, moderatorId, { action = null, checkBot = false } = {}) {
    // Ephemeral refusals: the clicker's Discord language (utils/botText.js).
    const tr = botText(langOf(interaction));
    if (interaction.user.id !== moderatorId) {
        await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: tr.t('errors.panel.otherModerator'),
        });
        return null;
    }
    // Any server (multi-server B1): the panel acts in the server it was opened in (interaction.guild).
    if (!interaction.inGuild()) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('errors.panel.serverOnly') });
        return null;
    }
    const access = await panelAccessFor(interaction.member, interaction.guildId, { client: interaction.client });
    if (!access.level) {
        await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: tr.t(refusalKey(access, interaction.guildId, { closed: true })),
        });
        return null;
    }
    if (!panelActionAllowed(access, action)) {
        await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: tr.t('staff.enforcements.modNotAllowed', { action: actionLabelIn(action, { lang: tr.lang }) }),
        });
        return null;
    }
    if (checkBot && action) {
        try {
            assertBotPermissions(interaction.guild, action, { lang: tr.lang });
        } catch (error) {
            await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: error.userMessage || error.message });
            return null;
        }
    }
    return access;
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
        // One plain line (audit 3.7): the count and what the next warning does, not two "of 3" numbers.
        warnStatusText(state.ladder, { lang }),
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

/**
 * The panel for one member. `lang`: the moderator's language (the panel is an ephemeral reply).
 * `actions`: what the moderator may run (panelAccess.js; a Moderator-role user gets no Ban/Unban
 * buttons or templates); every action by default.
 */
export async function buildPanel(guild, moderatorId, targetUser, { lang = 'en', actions = ALL_PANEL_ACTIONS } = {}) {
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

    // Unban of an automatic ladder ban first asks "unban only" or "remove the warn" (audit 1.2).
    const ladderBan = Boolean(state.banned && state.activeBan?.is_auto);
    const offered = availableActions(state).filter((action) => actions.includes(action));
    const buttons = offered.map((action) => new ButtonBuilder()
        .setCustomId(`enf:act:${moderatorId}:${targetUser.id}:${action}${action === 'unban' && ladderBan ? ':ladder' : ''}`)
        .setLabel(actionLabelIn(action, { lang }))
        .setStyle(ACTION_STYLES[action]));

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    const templates = usableTemplates(readTemplates(guild.id), offered);
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
 * Early role-order check (audit 3.5): when no action could pass the hierarchy check on Confirm
 * (the member is the moderator, the owner, Mewvo, or at/above the moderator's or Mewvo's role),
 * the panel is shown read-only with the reason, so no reason is typed for nothing. Changes
 * `panel` in place. `targetMember` undefined: fetched here (null = not in the server).
 */
export async function readOnlyIfUntargetable(panel, { guild, moderator, targetUser, targetMember, lang = 'en' }) {
    const member = targetMember !== undefined ? targetMember : await guild.members.fetch(targetUser.id).catch(() => null);
    try {
        assertCanTarget(guild, moderator, targetUser.id, member, 'moderate', { lang });
    } catch (error) {
        panel.content = botText(lang).t('staff.moderateuser.readOnly', { reason: error.userMessage || error.message });
        panel.components = [];
    }
    return panel;
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
            // A ban needs a typed length or the word "permanent" (audit 3.4: blank is no longer permanent).
            .setTextInputComponent(new TextInputBuilder()
                .setCustomId('duration')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(20)
                .setRequired(true)
                .setValue(flow.durationInput
                    || (flow.type === 'ban' && flow.durationMs === null ? tr.t('enforcement.duration.permanent').toLowerCase() : ''))));
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

/**
 * The Confirm button's colour (audit 3.4): red only for what removes the member (ban, kick, and
 * a warn that reaches the limit and bans); blue for mute/warn; green for unban/unmute/remove warn.
 */
export function confirmStyle(flow) {
    if (flow.type === 'ban' || flow.type === 'kick') return ButtonStyle.Danger;
    if (flow.type === 'warn') return flow.ladder && previewWarn(flow.ladder).escalates ? ButtonStyle.Danger : ButtonStyle.Primary;
    if (LIFT_ACTIONS.has(flow.type)) return ButtonStyle.Success;
    return ButtonStyle.Primary;
}

/** True for the "Similar cases (…): No similar cases yet." line (formatPrecedent with no rows). */
function isNoPrecedent(flow, text, lang) {
    if (!flow.reasonKey || flow.reasonKey === CUSTOM_REASON_KEY) return false;
    const label = getReason(flow.reasonKey)?.label || flow.reasonKey;
    return text === formatPrecedent(label, [], { lang });
}

/** The second confirm of a permanent ban the member cannot appeal (exported for tests). */
export function secondConfirmPayload(flow, moderatorId, nonce, { lang = 'en' } = {}) {
    const tr = botText(lang);
    return {
        allowedMentions: NO_PINGS,
        embeds: [createEmbed({
            title: tr.t('staff.panel.confirm.permanentTitle'),
            description: truncate(tr.t('staff.panel.confirm.permanentBody', { name: truncate(flow.targetUsername, 200) }), 4096),
            color: 'error',
        })],
        components: [cancelRow(moderatorId, nonce, [
            new ButtonBuilder().setCustomId(`enf:final:${moderatorId}:${nonce}`).setLabel(tr.t('staff.panel.button.confirmPermanent')).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`enf:details:${moderatorId}:${nonce}`).setLabel(tr.t('staff.panel.button.editDetails')).setStyle(ButtonStyle.Secondary),
        ], { lang })],
    };
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
    // "No similar cases yet" is noise on the panel (audit 3.7): only a real comparison is shown.
    if (summary.precedent && !isNoPrecedent(flow, summary.precedent, lang)) lines.push(`-# ${summary.precedent}`);
    if (summary.memberHint) lines.push(`-# ${summary.memberHint}`);
    if (summary.ruleHint) lines.push(`-# ${summary.ruleHint}`);

    return {
        allowedMentions: NO_PINGS,
        embeds: [createEmbed({
            title: tr.t('staff.panel.confirm.title', { action: actionLabelIn(flow.type, { lang }) }),
            description: truncate(lines.join('\n'), 4096),
            color: flow.type === 'ban' || flow.type === 'kick' ? 'error' : 'warning',
        })],
        components: [cancelRow(moderatorId, nonce, [
            new ButtonBuilder().setCustomId(`enf:confirm:${moderatorId}:${nonce}`).setLabel(tr.t('staff.panel.button.confirm')).setStyle(confirmStyle(flow)),
            ...(RECORD_ACTIONS.has(flow.type)
                ? [new ButtonBuilder().setCustomId(`enf:details:${moderatorId}:${nonce}`).setLabel(tr.t('staff.panel.button.editDetails')).setStyle(ButtonStyle.Secondary)]
                : []),
        ], { lang })],
    };
}

/**
 * The result step (exported for tests). Notes from executeAction stay as the service wrote them.
 * `ladderAfter`: the member's ladder read after a warn (the "Next warn" line, audit 3.2).
 * `undoNonce`: the undo flow for this case; adds "Undo (mistake)", or "Mistake? Remove the warn"
 * when the warn triggered an automatic ladder ban (audit 1.2 / 3.3).
 */
export function resultPayload(flow, result, { lang = 'en', moderatorId = null, undoNonce = null, ladderAfter = null } = {}) {
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
    // Before the service notes, so a long note list can't truncate it away.
    if (flow.type === 'warn' && ladderAfter) lines.push(nextWarnText(ladderAfter, { lang }));
    lines.push(...result.notes);

    const components = [];
    if (undoNonce && moderatorId && result.record?.case_code) {
        const ladderBan = flow.type === 'warn' && Boolean(result.banRecord);
        components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
            .setCustomId(`enf:undo:${moderatorId}:${undoNonce}`)
            .setLabel(tr.t(ladderBan ? 'staff.panel.button.removeWarnMistake' : 'staff.panel.button.undo'))
            .setStyle(ButtonStyle.Secondary)));
    }
    return {
        allowedMentions: NO_PINGS,
        embeds: [createEmbed({
            title: tr.t('staff.panel.result.title', { action: actionLabelIn(flow.type, { lang }), name: truncate(flow.targetUsername, 200) }),
            description: truncate(lines.join('\n') || tr.t('staff.panel.result.done'), 4096),
            color: 'success',
        })],
        components,
    };
}

/** The undo flow kept for a result card (panel state, same TTL as every panel step). */
export function undoFlowFor(flow, result, guildId) {
    if (!result?.record?.case_code) return null;
    // A warn that reached the limit but whose automatic ban failed: voiding it would not step the
    // ladder back (no ban to lift), so "undo" would promise the wrong thing. Not offered.
    if (flow.type === 'warn' && !result.banRecord && flow.ladder && previewWarn(flow.ladder).escalates) return null;
    return {
        kind: 'undo',
        type: flow.type,
        moderatorId: flow.moderatorId,
        guildId,
        targetId: flow.targetId,
        targetUsername: flow.targetUsername,
        caseCode: result.record.case_code,
        // A warn that triggered an automatic ladder ban: voiding the warn also lifts that ban
        // and steps the ladder back (appealService.liftCase → liftLadderBanForWarn).
        ladderBanCode: flow.type === 'warn' ? result.banRecord?.case_code || null : null,
        // An automatic ladder ban itself (the Unban choice): voiding it removes its trigger warn.
        isLadderBan: false,
    };
}

/** What undoing does, before it runs (exported for tests). */
export function undoConfirmPayload(undo, moderatorId, nonce, { lang = 'en' } = {}) {
    const tr = botText(lang);
    let what;
    if (undo.type === 'warn') {
        what = undo.ladderBanCode
            ? tr.t('staff.panel.undo.what.warnLadder', { code: undo.caseCode, ban: undo.ladderBanCode })
            : tr.t('staff.panel.undo.what.warn', { code: undo.caseCode });
    } else if (undo.type === 'ban') {
        what = undo.isLadderBan ? tr.t('staff.panel.undo.what.banLadder', { code: undo.caseCode }) : tr.t('staff.panel.undo.what.ban', { code: undo.caseCode });
    } else if (undo.type === 'mute') {
        what = tr.t('staff.panel.undo.what.mute', { code: undo.caseCode });
    } else {
        what = tr.t('staff.panel.undo.what.kick', { code: undo.caseCode });
    }
    return {
        allowedMentions: NO_PINGS,
        embeds: [createEmbed({
            title: truncate(tr.t('staff.panel.undo.title', { name: truncate(undo.targetUsername, 200) }), 256),
            description: truncate(`${what}\n${tr.t('staff.panel.undo.dm')}`, 4096),
            color: 'warning',
        })],
        components: [cancelRow(moderatorId, nonce, [
            new ButtonBuilder().setCustomId(`enf:undook:${moderatorId}:${nonce}`).setLabel(tr.t('staff.panel.button.confirmUndo')).setStyle(ButtonStyle.Primary),
        ], { lang })],
    };
}

/** After an undo ran (exported for tests). `ladderAfter`: the ladder read afterwards, or null. */
export function undoResultPayload(undo, voided, { lang = 'en', ladderAfter = null } = {}) {
    const tr = botText(lang);
    const lines = [tr.t('staff.panel.undo.done', { code: voided.record?.case_code || undo.caseCode })];
    if (ladderAfter && (undo.type === 'warn' || undo.isLadderBan)) lines.push(warnStatusText(ladderAfter, { lang }));
    lines.push(...(voided.notes || []));
    lines.push(voided.dmDelivered ? tr.t('staff.case.remove.dmDelivered') : tr.t('staff.case.remove.dmNotDelivered'));
    return {
        allowedMentions: NO_PINGS,
        embeds: [createEmbed({
            title: truncate(tr.t('staff.panel.undo.doneTitle', { name: truncate(undo.targetUsername, 200) }), 256),
            description: truncate(lines.join('\n'), 4096),
            color: 'success',
        })],
        components: [],
    };
}

/** Unban of an automatic ladder ban: unban only, or remove the warn (exported for tests). */
export function unbanChoicePayload(flow, moderatorId, unbanNonce, undoNonce, banCode, { lang = 'en' } = {}) {
    const tr = botText(lang);
    return {
        allowedMentions: NO_PINGS,
        embeds: [stepEmbed(flow, tr.t('staff.panel.unbanChoice', { code: banCode }), { lang })],
        components: [cancelRow(moderatorId, unbanNonce, [
            new ButtonBuilder().setCustomId(`enf:unbanonly:${moderatorId}:${unbanNonce}`).setLabel(tr.t('staff.panel.button.unbanOnly')).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`enf:undo:${moderatorId}:${undoNonce}`).setLabel(tr.t('staff.panel.button.removeWarnStage')).setStyle(ButtonStyle.Primary),
        ], { lang })],
    };
}

/**
 * After an unexpected failure: did the action happen anyway? Reads the member's state again and
 * says so (audit 3.7): 'happened' (+ case code), 'notHappened', or 'unknown' when the check itself
 * fails. Never says "nothing changed" unless the check showed it. `deps` for tests.
 */
export async function failureOutcome({ guild, flow, moderatorId, startedAt, lastIdBefore = null, deps = {} }) {
    const d = { listCasesForUser, getTargetState, getCaseByCode, ...deps };
    try {
        if (flow.kind === 'undo') {
            // voidCase lifts first (unban/unmute) and marks the case last, so "not voided" alone
            // does not prove nothing happened: the case must still be open and still in effect.
            const row = await d.getCaseByCode(flow.caseCode, guild.id);
            if (row?.voided_at) return { outcome: 'happened', code: flow.caseCode };
            if (!row || !['active', 'appeal_pending'].includes(row.status)) return { outcome: 'unknown' };
            if (flow.type === 'ban' || flow.type === 'mute' || flow.ladderBanCode) {
                const state = await d.getTargetState(guild, flow.targetId);
                const still = flow.type === 'mute' ? state.muted : state.banned;
                return still ? { outcome: 'notHappened' } : { outcome: 'unknown' };
            }
            return { outcome: 'notHappened' };
        }
        if (RECORD_ACTIONS.has(flow.type)) {
            const { rows } = await d.listCasesForUser(guild.id, flow.targetId, { limit: 5 });
            // Only a case newer than the member's newest case before the click (lastIdBefore); without
            // that snapshot, a minute of slack for clock differences between the bot and the database.
            const isNew = (row) => (lastIdBefore != null
                ? Number(row.id) > Number(lastIdBefore)
                : new Date(row.created_at).getTime() >= startedAt - 60_000);
            const made = rows.find((row) => row.type === flow.type && row.moderator_id === moderatorId && isNew(row));
            return made ? { outcome: 'happened', code: made.case_code } : { outcome: 'notHappened' };
        }
        if (flow.type === 'removewarn') {
            const row = await d.getCaseByCode(flow.warnCode, guild.id);
            return row && row.status === 'revoked' ? { outcome: 'happened', code: null } : { outcome: 'notHappened' };
        }
        const state = await d.getTargetState(guild, flow.targetId);
        if (flow.type === 'unban') {
            // The ban lookup reads "not banned" on any Discord error too: only "not banned AND its
            // case lifted" counts as done (doUnban unbans first, then lifts the case).
            if (state.banned) return { outcome: 'notHappened' };
            return state.activeBan ? { outcome: 'unknown' } : { outcome: 'happened', code: null };
        }
        return state.muted ? { outcome: 'notHappened' } : { outcome: 'happened', code: null };
    } catch {
        return { outcome: 'unknown' };
    }
}

/** The failure text for failureOutcome's answer. */
export function failureText(outcome, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (outcome.outcome === 'happened') {
        return outcome.code ? tr.t('staff.panel.failed.happened', { code: outcome.code }) : tr.t('staff.panel.failed.happenedNoCase');
    }
    if (outcome.outcome === 'notHappened') return tr.t('staff.panel.failed.notHappened');
    return tr.t('staff.panel.failed.unknown');
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

/**
 * Unban of an automatic ladder ban (audit 1.2): a plain unban keeps the warning stage, so the
 * moderator chooses "Unban only (stage stays)" or "Remove the warn (stage goes back)" (voidCase on
 * the ladder ban, which removes its trigger warn and steps the ladder back). No form yet, so this
 * step acknowledges first. If the ban is no longer automatic/active, only "Unban only" is left.
 */
async function startLadderUnban(interaction, moderatorId, targetId) {
    const lang = langOf(interaction);
    await interaction.deferUpdate();
    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    if (!targetUser) return expired(interaction);
    const state = await getTargetState(interaction.guild, targetId);
    const flow = startFlow({ type: 'unban', moderatorId, targetUser });
    const unbanNonce = createFlow(flow);
    const ban = state.banned && state.activeBan?.is_auto ? state.activeBan : null;
    if (!ban) {
        return InteractionHelper.safeEditReply(interaction, {
            allowedMentions: NO_PINGS,
            embeds: [stepEmbed(flow, botText(lang).t('staff.panel.step.unbanOnly'), { lang })],
            components: [cancelRow(moderatorId, unbanNonce, [
                new ButtonBuilder().setCustomId(`enf:unbanonly:${moderatorId}:${unbanNonce}`).setLabel(actionLabelIn('unban', { lang })).setStyle(ButtonStyle.Success),
            ], { lang })],
        });
    }
    const undoNonce = createFlow({
        kind: 'undo', type: 'ban', moderatorId, guildId: interaction.guildId, targetId, targetUsername: targetUser.username,
        caseCode: ban.case_code, ladderBanCode: null, isLadderBan: true,
    });
    return InteractionHelper.safeEditReply(interaction, unbanChoicePayload(flow, moderatorId, unbanNonce, undoNonce, ban.case_code, { lang }));
}

async function startAction(interaction, moderatorId, targetId, action, extra = null) {
    if (action === 'unban' && extra === 'ladder') return startLadderUnban(interaction, moderatorId, targetId);
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
        const warns = await getCountedWarns(interaction.guildId, targetId, (await getTargetState(interaction.guild, targetId)).ladder.level);
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
                description: truncate(`${warn.case_code} · ${warn.reason}`, 100),
            })));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [stepEmbed(flow, tr.t('staff.panel.removeWarn.which'), { lang })],
            components: [new ActionRowBuilder().addComponents(select), cancelRow(moderatorId, nonce, [], { lang })],
        });
    }

    const nonce = createFlow(flow);
    return InteractionHelper.safeEditReply(interaction, reasonStepPayload(flow, moderatorId, nonce, { lang }));
}

/** Runs a confirmed record/lift flow and shows the result card (with its undo button). */
async function runConfirmedFlow(interaction, client, moderatorId, flow, lang, access = null) {
    const tr = botText(lang);
    const targetUser = await client.users.fetch(flow.targetId);
    const startedAt = Date.now();
    // The member's newest case before this action, so a failure check never credits an older case.
    const lastIdBefore = RECORD_ACTIONS.has(flow.type)
        ? await listCasesForUser(interaction.guildId, flow.targetId, { limit: 1 }).then(({ rows }) => rows[0]?.id ?? 0).catch(() => null)
        : null;
    try {
        const result = await executeAction({ guild: interaction.guild, moderator: interaction.member, targetUser, flow, lang, staffRole: staffRoleFor(access) });
        result.notes.push(...await attachFlowEvidence(flow, result.record, interaction.user, { lang }));
        // The "Next warn" line reads the ladder as the warn left it; a failed read only drops the line.
        const ladderAfter = flow.type === 'warn' ? await getLadder(interaction.guildId, flow.targetId).catch(() => null) : null;
        const undo = undoFlowFor(flow, result, interaction.guildId);
        const undoNonce = undo ? createFlow(undo) : null;
        return InteractionHelper.safeEditReply(interaction, resultPayload(flow, result, { lang, moderatorId, undoNonce, ladderAfter }));
    } catch (error) {
        const expectedError = Boolean(error?.context?.expected);
        if (!expectedError) {
            logger.error('Enforcement action failed', { action: flow.type, targetId: flow.targetId, error });
        }
        // An expected error is a refusal before anything ran; otherwise check what actually happened.
        const message = expectedError && error.userMessage
            ? error.userMessage
            : failureText(await failureOutcome({ guild: interaction.guild, flow, moderatorId, startedAt, lastIdBefore }), { lang });
        return InteractionHelper.safeEditReply(interaction, {
            allowedMentions: NO_PINGS,
            embeds: [createEmbed({ title: tr.t('staff.panel.failedTitle', { action: actionLabelIn(flow.type, { lang }) }), description: truncate(message, 4096), color: 'error' })],
            components: [],
        });
    }
}

/** "Yes, remove the case" on an undo: voidCase (lifts, steps the ladder back, DMs the member). */
async function runUndo(interaction, client, moderatorId, undo, lang) {
    const tr = botText(lang);
    const startedAt = Date.now();
    try {
        const voided = await voidCase(client, {
            guildId: interaction.guildId,
            caseCode: undo.caseCode,
            admin: { id: interaction.user.id, username: interaction.user.username },
            // Stored on the case: stays English, like the panel's other default reasons.
            reason: 'Mistake: undone from the /enforcements panel',
            lang,
        });
        const ladderAfter = undo.type === 'warn' || undo.isLadderBan
            ? await getLadder(interaction.guildId, undo.targetId).catch(() => null)
            : null;
        return InteractionHelper.safeEditReply(interaction, undoResultPayload(undo, voided, { lang, ladderAfter }));
    } catch (error) {
        const expectedError = Boolean(error?.context?.expected);
        if (!expectedError) logger.error('Enforcement undo failed', { caseCode: undo.caseCode, targetId: undo.targetId, error });
        let message;
        if (expectedError && error.i18n?.code === 'alreadyRemoved') message = tr.t('staff.case.error.alreadyRemoved', error.i18n.params);
        else if (expectedError && error.i18n?.code === 'noCase') message = tr.t('staff.case.error.noCase', error.i18n.params);
        else if (expectedError && error.userMessage) message = error.userMessage;
        else message = failureText(await failureOutcome({ guild: interaction.guild, flow: undo, moderatorId, startedAt }), { lang });
        return InteractionHelper.safeEditReply(interaction, {
            allowedMentions: NO_PINGS,
            embeds: [createEmbed({ title: tr.t('staff.panel.undo.failedTitle'), description: truncate(message, 4096), color: 'error' })],
            components: [],
        });
    }
}

/** An undo flow usable by this click: same moderator, same server (the guard checked the rest). */
/** The access action an undo needs (exported for tests): a lifted ban is an unban (Administrator only). */
export function undoAccessAction(undo) {
    if (!undo || undo.kind !== 'undo') return null;
    if (undo.type === 'ban' || undo.isLadderBan || undo.ladderBanCode) return 'unban';
    if (undo.type === 'mute') return 'unmute';
    if (undo.type === 'warn') return 'removewarn';
    return undo.type;
}

function undoFlowOf(nonce, moderatorId, guildId, { take = false } = {}) {
    const flow = take ? takeFlow(nonce) : getFlow(nonce);
    if (!flow || flow.kind !== 'undo' || flow.moderatorId !== moderatorId || flow.guildId !== guildId) return null;
    return flow;
}

export async function handleEnforcementButton(interaction, client, args) {
    const [step, moderatorId, arg, action, extra] = args;
    // Every step, the undo ones included: the clicker must be this moderator and may still run
    // the action (Administrator; outside Mewvo's servers also the Moderator role for its actions).
    // The action: the button's own (act), an undo's lifting action, else the open flow's.
    const guardedAction = step === 'act' ? action
        : step === 'cancel' ? null
            : (step === 'undo' || step === 'undook') ? undoAccessAction(getFlow(arg))
                : getFlow(arg)?.type ?? null;
    const access = await guard(interaction, moderatorId, { action: guardedAction, checkBot: step === 'act' });
    if (!access) return;

    if (step === 'act') {
        return startAction(interaction, moderatorId, arg, action, extra);
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

    if (step === 'confirm' || step === 'final') {
        await interaction.deferUpdate();
        const pending = getFlow(arg);
        if (!pending || pending.kind) return expired(interaction);
        // A permanent ban the member cannot appeal asks once more (audit 3.4); "final" is that answer.
        if (step === 'confirm' && needsSecondConfirm(pending)) {
            return InteractionHelper.safeEditReply(interaction, secondConfirmPayload(pending, moderatorId, arg, { lang }));
        }
        const flow = takeFlow(arg);
        if (!flow) return expired(interaction);
        return runConfirmedFlow(interaction, client, moderatorId, flow, lang, access);
    }

    if (step === 'unbanonly') {
        // Answers with the unban form (the first response, within 3 s; no awaits before it).
        const flow = getFlow(arg);
        if (!flow || flow.kind || flow.type !== 'unban') return expired(interaction);
        return InteractionHelper.safeShowModal(interaction, liftModal(flow, moderatorId, arg, { lang }));
    }

    if (step === 'undo') {
        const undo = undoFlowOf(arg, moderatorId, interaction.guildId);
        if (!undo) return expired(interaction);
        return interaction.update(undoConfirmPayload(undo, moderatorId, arg, { lang }));
    }

    if (step === 'undook') {
        await interaction.deferUpdate();
        const undo = undoFlowOf(arg, moderatorId, interaction.guildId, { take: true });
        if (!undo) return expired(interaction);
        return runUndo(interaction, client, moderatorId, undo, lang);
    }

    return expired(interaction);
}

export async function handleEnforcementSelect(interaction, client, args) {
    const [step, moderatorId, nonce] = args;
    const guardedAction = step === 'tpl'
        ? readTemplates(interaction.guildId)[Number(interaction.values?.[0])]?.action ?? null
        : getFlow(nonce)?.type ?? null;
    if (!(await guard(interaction, moderatorId, { action: guardedAction, checkBot: step === 'tpl' }))) return;
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
    if (!(await guard(interaction, moderatorId, { action: getFlow(nonce)?.type ?? null }))) return;

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
    }, { lang, explicitPermanent: true });
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
