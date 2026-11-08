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
import {
    diffAgainstLive, diffHasChanges, formatDiff, formatRevertPlan, formatRevertSummary, getSnapshot, getSnapshotBefore,
    isBackupOwner, revertPlan, revertToSnapshot,
} from '../services/structureBackupService.js';

const SNOWFLAKE = /^\d{17,20}$/;

/** The diff embed, with Revert / Cancel buttons when `withButtons` and there is something to revert. */
export function diffPayload(snapshot, diff, { withButtons = false } = {}) {
    const changes = diffHasChanges(diff);
    const embed = createEmbed({
        title: `Snapshot #${snapshot.id} vs the server now`,
        description: changes
            ? formatDiff(diff)
            : `${formatDiff(diff)}\nIf this snapshot was taken after the damage, pick an older one from \`/backup snapshots\`.`,
        footer: { text: `Snapshot taken ${new Date(snapshot.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${snapshot.summary}` },
        color: changes ? 'warning' : 'success',
    });
    const components = withButtons && changes ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`backuprevert:confirm:${snapshot.id}`).setLabel('Revert to this snapshot').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`backuprevert:cancel:${snapshot.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
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

const TOO_OLD = 'This snapshot is more than 24 hours older than the alert, so only the server owner can revert from it.';

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
    if (!SNOWFLAKE.test(String(targetGuildId || ''))) return { ok: false, message: 'This button is broken. Use the newest alert.' };
    if (interaction.guildId !== staffGuildId(targetGuildId)) {
        return { ok: false, message: 'This button belongs to another server.' };
    }
    const userId = interaction.user.id;
    if ((offenderId && offenderId === userId) || isRecentOffender(targetGuildId, userId)) {
        return { ok: false, message: 'The staff guard acted on you in this server, so you cannot use these buttons. Ask the server owner.' };
    }
    const target = client.guilds.cache.get(targetGuildId);
    const owner = target?.ownerId === userId || (isMewvoServer(targetGuildId) && isBackupOwner(client, userId));
    if (owner) return { ok: true, canRevert: true, owner: true, scope: 'owner' };
    if (isAdministrator(interaction.member)) return { ok: true, canRevert: true, owner: false, scope: 'admin' };
    return { ok: false, message: 'Only administrators can use this.' };
}

function refuse(interaction, message) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message });
}

/**
 * The nuke diff as a confirm step for `scope`: what the revert would do (and what needs the
 * owner), with Confirm / Cancel when something can run. `seconds`: the alert time, carried to
 * the confirm (the 24 h limit is checked again there).
 */
export function revertConfirmPayload(guild, snapshot, diff, offenderId, { scope = 'owner', seconds = null } = {}) {
    const plan = revertPlan(diff, { scope });
    const embed = createEmbed({
        title: plan.empty ? 'Nothing to revert' : `Revert ${guild.name} to snapshot #${snapshot.id}?`.slice(0, 256),
        description: `${formatRevertPlan(plan)}\n\n${formatDiff(diff, { max: 8 })}`.slice(0, 4000),
        footer: { text: `Snapshot taken ${new Date(snapshot.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${snapshot.summary}`.slice(0, 2048) },
        color: plan.empty ? 'success' : 'warning',
    });
    const alertSeconds = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Math.floor(Number(seconds)) : 0;
    const tail = `${guild.id}:${snapshot.id}:${offenderId || '0'}:${alertSeconds}`;
    const components = !plan.runnable ? [] : [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`nukerevert:confirm:${tail}`).setLabel('Confirm revert').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`nukerevert:cancel:${tail}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )];
    return { embeds: [embed], components };
}

/** Looks up the target server and the last snapshot before `seconds`; replies itself when one is missing. */
async function loadNukeContext(interaction, client, targetGuildId, seconds) {
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) {
        await InteractionHelper.safeEditReply(interaction, { content: 'I cannot reach the server this alert is about.' });
        return null;
    }
    const before = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
    const snapshot = await getSnapshotBefore(guild.id, before);
    if (!snapshot) {
        await InteractionHelper.safeEditReply(interaction, { content: 'There is no snapshot from before this alert, so there is nothing to compare with.' });
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
    const context = await loadNukeContext(interaction, client, targetGuildId, seconds);
    if (!context) return;
    const { guild, snapshot, diff } = context;
    const tooOld = !access.owner && snapshotTooOldForAdmin(snapshot, seconds);
    if (access.canRevert && !tooOld && diffHasChanges(diff)) {
        return InteractionHelper.safeEditReply(interaction, revertConfirmPayload(guild, snapshot, diff, offenderId, { scope: access.scope, seconds }));
    }
    const payload = diffPayload(snapshot, diff);
    if (tooOld) payload.embeds[0].setFooter({ text: TOO_OLD });
    else if (!access.canRevert) payload.embeds[0].setFooter({ text: 'Only the server owner or an administrator can revert.' });
    return InteractionHelper.safeEditReply(interaction, payload);
}

export async function handleNukeRevert(interaction, client, args) {
    const [step] = args;
    if (step === 'ask') {
        const [, secondsText, targetGuildId, offenderText] = args;
        const offenderId = offenderOf(offenderText);
        const access = nukeAccess(interaction, client, targetGuildId, offenderId);
        if (!access.ok) return refuse(interaction, access.message);
        if (!access.canRevert) return refuse(interaction, 'Only the server owner or an administrator can revert.');
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        const seconds = Number(secondsText);
        const context = await loadNukeContext(interaction, client, targetGuildId, seconds);
        if (!context) return;
        if (!access.owner && snapshotTooOldForAdmin(context.snapshot, seconds)) {
            return InteractionHelper.safeEditReply(interaction, { content: TOO_OLD });
        }
        return InteractionHelper.safeEditReply(interaction, revertConfirmPayload(context.guild, context.snapshot, context.diff, offenderId, { scope: access.scope, seconds }));
    }

    const [, targetGuildId, snapshotIdText, offenderText, alertSecondsText] = args;
    if (step === 'cancel') {
        return interaction.update({ embeds: [createEmbed({ title: 'Revert cancelled', description: 'Nothing was changed.', color: 'secondary' })], components: [] });
    }
    if (step !== 'confirm' || !/^\d{1,18}$/.test(snapshotIdText || '')) return;
    const access = nukeAccess(interaction, client, targetGuildId, offenderOf(offenderText));
    if (!access.ok) return refuse(interaction, access.message);
    if (!access.canRevert) return refuse(interaction, 'Only the server owner or an administrator can revert.');

    await interaction.deferUpdate();
    const guild = client.guilds.cache.get(targetGuildId);
    // Read by (guild, id): a snapshot id of another server finds nothing.
    const snapshot = guild ? await getSnapshot(guild.id, snapshotIdText) : null;
    if (!snapshot) {
        return interaction.editReply({ embeds: [createEmbed({ title: 'Revert not started', description: 'That snapshot (or the server) is gone.', color: 'error' })], components: [] });
    }
    if (!access.owner && snapshotTooOldForAdmin(snapshot, alertSecondsText)) {
        return interaction.editReply({ embeds: [createEmbed({ title: 'Revert not started', description: TOO_OLD, color: 'error' })], components: [] });
    }
    // Re-planned now, for this clicker: an admin's confirm never runs the owner-only steps.
    const plan = revertPlan(diffAgainstLive(guild, snapshot), { scope: access.scope });
    if (!plan.runnable) {
        const text = plan.empty ? 'The server already matches the snapshot.' : 'What is left needs the server owner.';
        return interaction.editReply({ embeds: [successEmbed('Nothing to revert', text)], components: [] });
    }
    await interaction.editReply({
        embeds: [successEmbed('Revert running', `Restoring ${guild.name} from snapshot #${snapshot.id} (${dateStamp(snapshot.created_at)}). This message updates as it goes, and you get a DM when it is done. Nothing is deleted.`)],
        components: [],
    });
    runRevert(interaction, client, guild, snapshot, access.scope);
}

/** Runs the revert in the background (it can take minutes): progress edits, DM and mod log at the end. */
function runRevert(interaction, client, guild, snapshot, scope = 'owner') {
    const by = interaction.user;
    revertToSnapshot(guild, snapshot, (text) => interaction.editReply({ embeds: [successEmbed('Revert running', text)] }), { scope })
        .then(async (counts) => {
            const summary = formatRevertSummary(counts);
            await interaction.editReply({ embeds: [successEmbed('Revert finished', summary.slice(0, 4000))] }).catch(() => {});
            await by.send({ content: `**Revert of ${guild.name} finished:** ${summary}`.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
            await postModLog(client, 'revert', [
                { name: 'Snapshot', value: `#${snapshot.id} (${dateStamp(snapshot.created_at)})` },
                { name: 'By', value: `${by.username} (${by.id})${scope === 'admin' ? ' · administrator: permission restores left to the owner' : ''}` },
                { name: 'Result', value: summary.slice(0, 1024) },
            ], { guildId: guild.id });
        })
        .catch(async (error) => {
            logger.error(`Revert of ${guild.id} stopped: ${error.message}`);
            await interaction.editReply({ embeds: [createEmbed({ title: 'Revert stopped', description: error.message.slice(0, 4000), color: 'error' })] }).catch(() => {});
            await by.send({ content: `**Revert of ${guild.name} stopped:** ${error.message}`.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
        });
}

export async function handleNukePanic(interaction, client, args) {
    const [targetGuildId, offenderText] = args;
    const access = nukeAccess(interaction, client, targetGuildId, offenderOf(offenderText));
    if (!access.ok) return refuse(interaction, access.message);
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return InteractionHelper.safeEditReply(interaction, { content: 'I cannot reach the server this alert is about.' });
    const lockdown = await startManualLockdown(guild, interaction.user);
    if (!lockdown) {
        return InteractionHelper.safeEditReply(interaction, { content: `${guild.name} is already in lockdown. End it with \`/automod lockdown-end\` there.`, allowedMentions: { parse: [] } });
    }
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Lockdown started', [
            `**Verification level:** ${lockdown.raised ? 'raised to High' : 'not changed (already High, or I lack Manage Server)'}`,
            `**Invites and DMs:** ${describePanic(lockdown.panic)}`,
            `End it with \`/automod lockdown-end\`${guild.id === interaction.guildId ? '' : ` in ${guild.name}`}.`,
        ].join('\n'))],
        allowedMentions: { parse: [] },
    });
}

export async function handleBackupRevert(interaction, client, args) {
    const [decision, idText] = args;
    if (!isBackupOwner(client, interaction.user.id)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only the server owner can revert the server structure.' });
    }
    if (decision === 'cancel') {
        return interaction.update({ embeds: [createEmbed({ title: 'Revert cancelled', description: 'Nothing was changed.', color: 'secondary' })], components: [] });
    }
    if (decision !== 'confirm' || !/^\d+$/.test(idText || '')) return;

    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    const snapshot = guild ? await getSnapshot(guild.id, idText) : null;
    if (!snapshot) {
        return interaction.update({ embeds: [createEmbed({ title: 'Revert not started', description: 'That snapshot (or the main server) is gone.', color: 'error' })], components: [] });
    }
    await interaction.update({
        embeds: [successEmbed('Revert running', `Restoring the main server from snapshot #${snapshot.id} (${dateStamp(snapshot.created_at)}). This message updates as it goes, and you get a DM when it is done.`)],
        components: [],
    });
    runRevert(interaction, client, guild, snapshot);
}
