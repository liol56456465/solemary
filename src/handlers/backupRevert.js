// backupRevert.js — "undo the nuke" buttons, in every server where the staff guard runs.
//
// On a staff-guard nuke alert (alertPost.nukeAlertRow; the alert is posted in that server's staff
// guild: the main server for the home servers, else the server itself):
//   nukediff:<epochSeconds>[:<guildId>[:<offenderId>]]  "Show what changed": the last snapshot of
//       the server the nuke happened in (old buttons without a guild id: the main server) taken
//       before the alert vs that server now. The server's Administrators and its owner.
//   nukerevert:ask:<epochSeconds>:<guildId>:<offenderId>  "Revert…": the same diff as a confirm
//       step (what would be recreated, what is left alone) with Confirm / Cancel.
//   nukerevert:confirm|cancel:<guildId>:<snapshotId>:<offenderId>[:<epochSeconds>]  runs (or drops) it.
//   nukepanic:<guildId>:<offenderId>  "Lock down (panic)": a lockdown with invites and DMs paused.
// Who (nukeAccess): only clicks in the alert's own staff guild, never by the member the guard
// acted on (the offender in the customId, or anyone it acted on there within 7 days). Revert and
// lockdown: the server's owner, or an Administrator who is not the offender. An Administrator's
// revert is limited (structureBackupService.revertSteps, scope 'admin'): it only recreates
// deleted channels and categories (no dangerous allow bits) and roles without dangerous
// permissions; every permission grant or restore needs the owner. An Administrator also cannot
// revert from a snapshot more than 24 h older than the alert (or an alert of unknown time). Every click
// re-checks; the confirm re-reads the snapshot by (guild, id), so another server's snapshot ids
// are refused. A revert never deletes a role or a channel.
//
//   backuprevert:<confirm|cancel>:<snapshotId>   the confirm step of /backup revert. Owners only.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger } from '../utils/logger.js';
import { isAdministrator, postModLog } from '../services/enforcement/enforcementService.js';
import { isMewvoServer } from '../utils/ownerPower.js';
import { dateStamp } from '../services/enforcement/format.js';
import { staffGuildId } from '../services/automod/channelRouting.js';
import { isRecentOffender } from '../services/automod/staffGuardService.js';
import { describePanic } from '../services/automod/incidentActions.js';
import { startManualLockdown } from '../services/automod/raidService.js';
import { botText, textForGuild, textForInteraction } from '../utils/botText.js';
import {
    diffAgainstLive, diffHasChanges, formatDiff, formatRevertPlan, formatRevertSummary, getSnapshot, getSnapshotBefore,
    isBackupOwner, revertPlan, revertToSnapshot,
} from '../services/structureBackupService.js';

const SNOWFLAKE = /^\d{17,20}$/;

// Language (docs/bot-i18n.md): every answer here is ephemeral (the clicker's Discord language), and
// so is the DM about the revert the clicker started; the mod log entry is the server's language.
// The diff, plan and summary text (structureBackupService.js) and describePanic stay English.
const snapshotFooter = (tr, snapshot) => tr.t('automod.revert.footer', {
    time: new Date(snapshot.created_at).toISOString().slice(0, 16).replace('T', ' '),
    summary: snapshot.summary,
});

/**
 * The diff embed, with Revert / Cancel buttons when `withButtons` and there is something to revert.
 * `lang`: the reader's language (default English).
 */
export function diffPayload(snapshot, diff, { withButtons = false, lang = 'en' } = {}) {
    const tr = botText(lang);
    const changes = diffHasChanges(diff);
    const embed = createEmbed({
        title: tr.t('automod.revert.diffTitle', { id: snapshot.id }),
        description: changes
            ? formatDiff(diff)
            : `${formatDiff(diff)}\n${tr.t('automod.revert.olderHint')}`,
        footer: { text: snapshotFooter(tr, snapshot) },
        color: changes ? 'warning' : 'success',
    });
    const components = withButtons && changes ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`backuprevert:confirm:${snapshot.id}`).setLabel(tr.t('automod.revert.button.revertTo')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`backuprevert:cancel:${snapshot.id}`).setLabel(tr.t('automod.revert.button.cancel')).setStyle(ButtonStyle.Secondary),
    )] : [];
    return { embeds: [embed], components };
}

/** The server a nuke diff button is about: its guildId part, else (older buttons) the main server. */
export function nukeDiffGuildId(args) {
    const id = String(args?.[1] || '');
    return SNOWFLAKE.test(id) ? id : enforcementConfig.mainGuildId;
}

/** An Administrator may not revert from a snapshot this much older than the alert. */
export const ADMIN_MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

/** True when `snapshot` is too old for a non-owner: over 24 h before the alert (`seconds`), or no alert time. */
export function snapshotTooOldForAdmin(snapshot, seconds) {
    const alertMs = Number(seconds) * 1000;
    if (!Number.isFinite(alertMs) || alertMs <= 0) return true;
    return alertMs - new Date(snapshot.created_at).getTime() > ADMIN_MAX_SNAPSHOT_AGE_MS;
}

const tooOld = (tr) => tr.t('automod.revert.tooOld');

const offenderOf = (value) => (SNOWFLAKE.test(String(value || '')) ? String(value) : null);

/**
 * Who may use a nuke button (pure apart from the caches). Returns
 * { ok: false, message } or { ok: true, canRevert, owner, scope } (scope 'owner' | 'admin': what a
 * revert may do, structureBackupService.revertSteps).
 *   - the click must come from the staff guild of `targetGuildId` (where its alerts go);
 *   - the offender (`offenderId`, or anyone the guard acted on there lately) is refused;
 *   - the target server's owner (and, for Mewvo's own servers, the bot owners) may do everything;
 *   - an Administrator of the staff guild may see the diff, revert and lock down.
 */
export function nukeAccess(interaction, client, targetGuildId, offenderId = null) {
    const tr = textForInteraction(interaction);
    if (!SNOWFLAKE.test(String(targetGuildId || ''))) return { ok: false, message: tr.t('automod.revert.access.broken') };
    if (interaction.guildId !== staffGuildId(targetGuildId)) {
        return { ok: false, message: tr.t('automod.revert.access.otherServer') };
    }
    const userId = interaction.user.id;
    if ((offenderId && offenderId === userId) || isRecentOffender(targetGuildId, userId)) {
        return { ok: false, message: tr.t('automod.revert.access.offender') };
    }
    const target = client.guilds.cache.get(targetGuildId);
    const owner = target?.ownerId === userId || (isMewvoServer(targetGuildId) && isBackupOwner(client, userId));
    if (owner) return { ok: true, canRevert: true, owner: true, scope: 'owner' };
    if (isAdministrator(interaction.member)) return { ok: true, canRevert: true, owner: false, scope: 'admin' };
    return { ok: false, message: tr.t('automod.revert.access.adminsOnly') };
}

function refuse(interaction, message) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message });
}

/**
 * The nuke diff as a confirm step for `scope`: what the revert would do (and what needs the
 * owner), with Confirm / Cancel when something can run. `seconds`: the alert time, carried to
 * the confirm (the 24 h limit is checked again there). `lang`: the clicker's language (default English).
 */
export function revertConfirmPayload(guild, snapshot, diff, offenderId, { scope = 'owner', seconds = null, lang = 'en' } = {}) {
    const tr = botText(lang);
    const plan = revertPlan(diff, { scope });
    const embed = createEmbed({
        title: plan.empty ? tr.t('automod.revert.nothingTitle') : tr.t('automod.revert.confirmTitle', { server: guild.name, id: snapshot.id }).slice(0, 256),
        description: `${formatRevertPlan(plan)}\n\n${formatDiff(diff, { max: 8 })}`.slice(0, 4000),
        footer: { text: snapshotFooter(tr, snapshot).slice(0, 2048) },
        color: plan.empty ? 'success' : 'warning',
    });
    const alertSeconds = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Math.floor(Number(seconds)) : 0;
    const tail = `${guild.id}:${snapshot.id}:${offenderId || '0'}:${alertSeconds}`;
    const components = !plan.runnable ? [] : [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`nukerevert:confirm:${tail}`).setLabel(tr.t('automod.revert.button.confirm')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`nukerevert:cancel:${tail}`).setLabel(tr.t('automod.revert.button.cancel')).setStyle(ButtonStyle.Secondary),
    )];
    return { embeds: [embed], components };
}

/** Looks up the target server and the last snapshot before `seconds`; replies itself when one is missing. */
async function loadNukeContext(interaction, client, targetGuildId, seconds) {
    const tr = textForInteraction(interaction);
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) {
        await InteractionHelper.safeEditReply(interaction, { content: tr.t('automod.revert.unreachable') });
        return null;
    }
    const before = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
    const snapshot = await getSnapshotBefore(guild.id, before);
    if (!snapshot) {
        await InteractionHelper.safeEditReply(interaction, { content: tr.t('automod.revert.noSnapshot') });
        return null;
    }
    return { guild, snapshot, diff: diffAgainstLive(guild, snapshot) };
}

export async function handleNukeDiff(interaction, client, args) {
    const seconds = Number(args[0]);
    const targetGuildId = nukeDiffGuildId(args);
    const offenderId = offenderOf(args[2]);
    const access = nukeAccess(interaction, client, targetGuildId, offenderId);
    if (!access.ok) return refuse(interaction, access.message);
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const tr = textForInteraction(interaction);
    const context = await loadNukeContext(interaction, client, targetGuildId, seconds);
    if (!context) return;
    const { guild, snapshot, diff } = context;
    const isTooOld = !access.owner && snapshotTooOldForAdmin(snapshot, seconds);
    if (access.canRevert && !isTooOld && diffHasChanges(diff)) {
        return InteractionHelper.safeEditReply(interaction, revertConfirmPayload(guild, snapshot, diff, offenderId, { scope: access.scope, seconds, lang: tr.lang }));
    }
    const payload = diffPayload(snapshot, diff, { lang: tr.lang });
    if (isTooOld) payload.embeds[0].setFooter({ text: tooOld(tr) });
    else if (!access.canRevert) payload.embeds[0].setFooter({ text: tr.t('automod.revert.ownerOrAdmin') });
    return InteractionHelper.safeEditReply(interaction, payload);
}

export async function handleNukeRevert(interaction, client, args) {
    const [step] = args;
    const tr = textForInteraction(interaction);
    if (step === 'ask') {
        const [, secondsText, targetGuildId, offenderText] = args;
        const offenderId = offenderOf(offenderText);
        const access = nukeAccess(interaction, client, targetGuildId, offenderId);
        if (!access.ok) return refuse(interaction, access.message);
        if (!access.canRevert) return refuse(interaction, tr.t('automod.revert.ownerOrAdmin'));
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        const seconds = Number(secondsText);
        const context = await loadNukeContext(interaction, client, targetGuildId, seconds);
        if (!context) return;
        if (!access.owner && snapshotTooOldForAdmin(context.snapshot, seconds)) {
            return InteractionHelper.safeEditReply(interaction, { content: tooOld(tr) });
        }
        return InteractionHelper.safeEditReply(interaction, revertConfirmPayload(context.guild, context.snapshot, context.diff, offenderId, { scope: access.scope, seconds, lang: tr.lang }));
    }

    const [, targetGuildId, snapshotIdText, offenderText, alertSecondsText] = args;
    if (step === 'cancel') {
        return interaction.update({ embeds: [createEmbed({ title: tr.t('automod.revert.cancelled'), description: tr.t('automod.revert.nothingChanged'), color: 'secondary' })], components: [] });
    }
    if (step !== 'confirm' || !/^\d{1,18}$/.test(snapshotIdText || '')) return;
    const access = nukeAccess(interaction, client, targetGuildId, offenderOf(offenderText));
    if (!access.ok) return refuse(interaction, access.message);
    if (!access.canRevert) return refuse(interaction, tr.t('automod.revert.ownerOrAdmin'));

    await interaction.deferUpdate();
    const guild = client.guilds.cache.get(targetGuildId);
    // Read by (guild, id): a snapshot id of another server finds nothing.
    const snapshot = guild ? await getSnapshot(guild.id, snapshotIdText) : null;
    if (!snapshot) {
        return interaction.editReply({ embeds: [createEmbed({ title: tr.t('automod.revert.notStarted'), description: tr.t('automod.revert.gone'), color: 'error' })], components: [] });
    }
    if (!access.owner && snapshotTooOldForAdmin(snapshot, alertSecondsText)) {
        return interaction.editReply({ embeds: [createEmbed({ title: tr.t('automod.revert.notStarted'), description: tooOld(tr), color: 'error' })], components: [] });
    }
    // Re-planned now, for this clicker: an admin's confirm never runs the owner-only steps.
    const plan = revertPlan(diffAgainstLive(guild, snapshot), { scope: access.scope });
    if (!plan.runnable) {
        const text = plan.empty ? tr.t('automod.revert.alreadyMatches') : tr.t('automod.revert.needsOwner');
        return interaction.editReply({ embeds: [successEmbed(tr.t('automod.revert.nothingTitle'), text)], components: [] });
    }
    await interaction.editReply({
        embeds: [successEmbed(tr.t('automod.revert.running'), tr.t('automod.revert.runningText', { server: guild.name, id: snapshot.id, date: dateStamp(snapshot.created_at) }))],
        components: [],
    });
    runRevert(interaction, client, guild, snapshot, access.scope);
}

/** Runs the revert in the background (it can take minutes): progress edits, DM and mod log at the end. */
function runRevert(interaction, client, guild, snapshot, scope = 'owner') {
    const by = interaction.user;
    const tr = textForInteraction(interaction); // the progress message and the clicker's DM
    revertToSnapshot(guild, snapshot, (text) => interaction.editReply({ embeds: [successEmbed(tr.t('automod.revert.running'), text)] }), { scope })
        .then(async (counts) => {
            const summary = formatRevertSummary(counts);
            await interaction.editReply({ embeds: [successEmbed(tr.t('automod.revert.finished'), summary.slice(0, 4000))] }).catch(() => {});
            await by.send({ content: tr.t('automod.revert.dmFinished', { server: guild.name, summary }).slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
            const logTr = textForGuild(guild.id, { purpose: 'public' }); // the mod log
            await postModLog(client, 'revert', [
                { name: logTr.t('automod.revert.log.snapshot'), value: logTr.t('automod.revert.log.snapshotValue', { id: snapshot.id, date: dateStamp(snapshot.created_at) }) },
                { name: logTr.t('automod.revert.log.by'), value: `${by.username} (${by.id})${scope === 'admin' ? logTr.t('automod.revert.log.adminNote') : ''}` },
                { name: logTr.t('automod.revert.log.result'), value: summary.slice(0, 1024) },
            ], { guildId: guild.id, title: logTr.t('automod.revert.log.title') });
        })
        .catch(async (error) => {
            logger.error(`Revert of ${guild.id} stopped: ${error.message}`);
            await interaction.editReply({ embeds: [createEmbed({ title: tr.t('automod.revert.stopped'), description: error.message.slice(0, 4000), color: 'error' })] }).catch(() => {});
            await by.send({ content: tr.t('automod.revert.dmStopped', { server: guild.name, error: error.message }).slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
        });
}

export async function handleNukePanic(interaction, client, args) {
    const [targetGuildId, offenderText] = args;
    const access = nukeAccess(interaction, client, targetGuildId, offenderOf(offenderText));
    if (!access.ok) return refuse(interaction, access.message);
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const tr = textForInteraction(interaction);
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return InteractionHelper.safeEditReply(interaction, { content: tr.t('automod.revert.unreachable') });
    const lockdown = await startManualLockdown(guild, interaction.user);
    if (!lockdown) {
        return InteractionHelper.safeEditReply(interaction, { content: tr.t('automod.revert.panic.already', { server: guild.name }), allowedMentions: { parse: [] } });
    }
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(tr.t('automod.revert.panic.started'), [
            tr.t('automod.revert.panic.verification', { value: lockdown.raised ? tr.t('automod.revert.panic.raised') : tr.t('automod.revert.panic.notChanged') }),
            tr.t('automod.revert.panic.invites', { value: describePanic(lockdown.panic) }),
            guild.id === interaction.guildId ? tr.t('automod.revert.panic.end') : tr.t('automod.revert.panic.endIn', { server: guild.name }),
        ].join('\n'))],
        allowedMentions: { parse: [] },
    });
}

export async function handleBackupRevert(interaction, client, args) {
    const [decision, idText] = args;
    const tr = textForInteraction(interaction);
    if (!isBackupOwner(client, interaction.user.id)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('automod.revert.backupOwnerOnly') });
    }
    if (decision === 'cancel') {
        return interaction.update({ embeds: [createEmbed({ title: tr.t('automod.revert.cancelled'), description: tr.t('automod.revert.nothingChanged'), color: 'secondary' })], components: [] });
    }
    if (decision !== 'confirm' || !/^\d+$/.test(idText || '')) return;

    // Acknowledge before the snapshot read; the panel is then edited (deferUpdate + editReply).
    await interaction.deferUpdate();
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    const snapshot = guild ? await getSnapshot(guild.id, idText) : null;
    if (!snapshot) {
        return interaction.editReply({ embeds: [createEmbed({ title: tr.t('automod.revert.notStarted'), description: tr.t('automod.revert.goneMain'), color: 'error' })], components: [] });
    }
    await interaction.editReply({
        embeds: [successEmbed(tr.t('automod.revert.running'), tr.t('automod.revert.runningMain', { id: snapshot.id, date: dateStamp(snapshot.created_at) }))],
        components: [],
    });
    runRevert(interaction, client, guild, snapshot);
}
