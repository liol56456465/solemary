// quarantineRelease.js — the decision buttons on a quarantine alert (enforcement/quarantineService.js):
//   qdecide:<release|kick|ban|keep>:<guildId>:<userId>   Release / Kick / Ban / Keep in quarantine
//   qdecide:kickok:<guildId>:<userId>                    the Kick confirm (ephemeral)
//   qdecide:cancel:<guildId>:<userId>                    drops the Kick confirm
//   qrelease:<guildId>:<userId>                          the first alerts' Release button (= release)
//   qban:<guildId>:<userId> (modal)                      the Ban reason form; submitting it is the confirm
// The alert sits in the staff alerts channel of the server the quarantine is in (the main server
// for both home servers), so a click must come from that staff server.
//
// Who (owner, 2026-11-13: "only the owner or co-owner can select what to do with them"), re-checked
// on every click: the server owner (live guild.ownerId), OWNER_IDS with owner power in Mewvo's
// servers, or a member holding a decider role (quarantineDeciderRoleIds). Ordinary Administrators
// see the alert but are refused. Never the quarantined member, never a member the staff guard
// acted on recently; a decider by role never gives back saved roles at or above their own highest
// role. Kick and Ban run through executeAction (Administrator, hierarchy, DM before the action,
// case, mod log), as the decider.
// Acks: every step but Ban defers at once (ephemeral); Ban answers with its form within the
// 3 seconds (the checks before it read only caches). Language: the answer in the clicker's
// Discord language; the alert edit and the mod log in the staff server's language.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger } from '../utils/logger.js';
import { textForInteraction } from '../utils/botText.js';
import { truncate } from '../services/enforcement/format.js';
import { isAdministrator } from '../services/enforcement/enforcementService.js';
import { staffGuildId } from '../services/automod/channelRouting.js';
import { isRecentOffender } from '../services/automod/staffGuardService.js';
import { noteOwnerOverride } from '../services/ownerOverride.js';
import {
    BAN_MODAL, DECIDE_BUTTON, decideQuarantine, getQuarantine, isQuarantineDecider, refusalText, releaseRefusal, releaseText, tooHighRoles,
} from '../services/enforcement/quarantineService.js';

const SNOWFLAKE = /^\d{17,20}$/;
const REASON_MAX = 500;

/**
 * The checks every step shares (caches only, so Ban can still open its form in time):
 * { guild, decider } or { refusal } (a text in the clicker's language).
 */
function deciderCheck(interaction, client, guildId, tr) {
    if (!interaction.guildId || staffGuildId(guildId) !== interaction.guildId) return { refusal: tr.t('enforcement.quarantine.release.otherServer') };
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return { refusal: tr.t('enforcement.quarantine.release.otherServer') };
    const decider = isQuarantineDecider({ guild, userId: interaction.user.id, staffMember: interaction.member });
    if (!decider) return { refusal: tr.t('enforcement.quarantine.decide.notDecider') };
    if (decider !== 'owner' && isRecentOffender(guild.id, interaction.user.id)) return { refusal: tr.t('enforcement.quarantine.release.offender') };
    return { guild, decider };
}

/** The decider as a member of the quarantine's own server (kick/ban run there). */
async function memberIn(interaction, guild) {
    return guild.id === interaction.guildId ? interaction.member : guild.members.fetch(interaction.user.id).catch(() => null);
}

function banModal(guildId, userId, tr) {
    return new ModalBuilder()
        .setCustomId(`${BAN_MODAL}:${guildId}:${userId}`)
        .setTitle(truncate(tr.t('enforcement.quarantine.decide.banTitle'), 45))
        .addLabelComponents(new LabelBuilder()
            .setLabel(truncate(tr.t('enforcement.quarantine.decide.banReason'), 45))
            .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setMaxLength(REASON_MAX).setRequired(true)));
}

function kickConfirmRow(guildId, userId, tr) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${DECIDE_BUTTON}:kickok:${guildId}:${userId}`).setLabel(tr.t('enforcement.quarantine.decide.kickConfirm')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${DECIDE_BUTTON}:cancel:${guildId}:${userId}`).setLabel(tr.t('enforcement.quarantine.decide.cancel')).setStyle(ButtonStyle.Secondary),
    );
}

/** Runs a decision after the shared checks; answers the (deferred) interaction. */
async function runDecision(interaction, client, { guild, decider, decision, userId, reason = '', tr, alertMessage = null }) {
    const answer = (content) => InteractionHelper.safeEditReply(interaction, { content: truncate(content, 2000), components: [], allowedMentions: { parse: [] } });
    let record;
    try {
        record = await getQuarantine(guild.id, userId);
    } catch (error) {
        logger.warn(`Quarantine decision: record of ${userId} not readable: ${error.message}`);
        return answer(tr.t('enforcement.quarantine.refuse.database'));
    }
    if (!record) return answer(tr.t('enforcement.quarantine.release.none'));
    const moderator = await memberIn(interaction, guild);
    if (decision === 'release') {
        const refusal = releaseRefusal({ guild, record, targetId: userId, actorId: interaction.user.id, actorMember: moderator, isOwner: decider === 'owner' });
        if (refusal === 'tooHigh') return answer(releaseText('tooHigh', tr, { roles: truncate(tooHighRoles(guild, record, moderator).map((r) => r.name).join(', '), 1000) }));
        if (refusal) return answer(releaseText(refusal, tr));
    } else if (interaction.user.id === userId) {
        return answer(releaseText('notYourself', tr));
    }
    if ((decision === 'kick' || decision === 'ban') && !moderator) return answer(tr.t('enforcement.quarantine.decide.notMember'));
    const admin = isAdministrator(moderator);
    // A decider by role must also be an Administrator there; Kick and Ban need Administrator for
    // everyone (they run through executeAction), OWNER_IDS included.
    if (!admin && (decider === 'role' || decision === 'kick' || decision === 'ban')) return answer(tr.t('enforcement.quarantine.decide.needsAdmin'));
    const ownerOverride = decider === 'owner' && guild.ownerId !== interaction.user.id && !admin;
    let result;
    try {
        result = await decideQuarantine(guild, userId, {
            decision, reason, ownerOverride, moderator, lang: tr.lang, actorIsOwner: decider === 'owner',
            by: { id: interaction.user.id, username: interaction.user.username }, message: alertMessage,
        });
    } catch (error) {
        logger.warn(`Quarantine ${decision} of ${userId} in ${guild.id} failed: ${error.message}`);
        if (error.userMessage) return answer(error.userMessage);
        if (error.partial) return answer(releaseText('partial', tr, { error: truncate(error.message || 'unknown error', 300) }));
        return answer(releaseText('failed', tr, { error: truncate(error.message || 'unknown error', 300) }));
    }
    if (result.code === 'tooHigh') return answer(releaseText('tooHigh', tr, { roles: truncate(result.roles.map((r) => r.name).join(', '), 1000) }));
    if (result.code === 'ownerOnly') return answer(releaseText('ownerOnly', tr));
    if (!result.ok) return answer(refusalText(result.code, tr));
    if (ownerOverride) {
        noteOwnerOverride({ client, guildId: guild.id, userId: interaction.user.id, username: interaction.user.username, action: `quarantine ${decision} of ${userId}`, via: 'button' });
    }
    if (decision === 'release') {
        if (result.left) return answer(releaseText('left', tr));
        return answer(releaseText('done', tr, { name: `<@${userId}>`, roles: result.restored.map((role) => role.name).join(', ') || tr.t('enforcement.quarantine.alert.none') }));
    }
    const code = result.result?.record?.case_code;
    const done = tr.t(`enforcement.quarantine.decide.reply.${decision}`, { name: `<@${userId}>`, code: code || '-' });
    return answer(result.recordCleared === false ? `${done} ${tr.t('enforcement.quarantine.decide.recordNotCleared')}` : done);
}

export async function handleQuarantineRelease(interaction, client, args) {
    // qrelease:<guildId>:<userId> (first alerts) → the release decision.
    return handleQuarantineDecision(interaction, client, ['release', ...args]);
}

export async function handleQuarantineDecision(interaction, client, args) {
    const [step, guildId, userId] = args;
    if (!SNOWFLAKE.test(guildId || '') || !SNOWFLAKE.test(userId || '')) return;
    if (!['release', 'kick', 'kickok', 'cancel', 'ban', 'keep'].includes(step)) return;
    const tr = textForInteraction(interaction);
    if (step === 'ban') {
        // The form is the first answer (no defer before a modal); the checks read caches only.
        const check = deciderCheck(interaction, client, guildId, tr);
        if (check.refusal) return InteractionHelper.safeReply(interaction, { content: check.refusal, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return InteractionHelper.safeShowModal(interaction, banModal(guildId, userId, tr));
    }
    if (step === 'cancel') {
        return interaction.update({ content: tr.t('enforcement.quarantine.decide.cancelled'), components: [], allowedMentions: { parse: [] } }).catch(() => {});
    }
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const check = deciderCheck(interaction, client, guildId, tr);
    if (check.refusal) return InteractionHelper.safeEditReply(interaction, { content: check.refusal, allowedMentions: { parse: [] } });
    if (step === 'kick') {
        // Confirm first (an ephemeral step), then kickok runs it.
        return InteractionHelper.safeEditReply(interaction, {
            content: tr.t('enforcement.quarantine.decide.kickAsk', { name: `<@${userId}>` }),
            components: [kickConfirmRow(guildId, userId, tr)],
            allowedMentions: { parse: [] },
        });
    }
    const decision = step === 'kickok' ? 'kick' : step;
    // kickok comes from the ephemeral confirm: the alert itself is fetched from the record.
    return runDecision(interaction, client, { ...check, decision, userId, tr, alertMessage: step === 'kickok' ? null : interaction.message || null });
}

/** The Ban form (qban:<guildId>:<userId>): its submit is the confirm. */
export async function handleQuarantineBanModal(interaction, client, args) {
    const [guildId, userId] = args;
    if (!SNOWFLAKE.test(guildId || '') || !SNOWFLAKE.test(userId || '')) return;
    const tr = textForInteraction(interaction);
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const check = deciderCheck(interaction, client, guildId, tr);
    if (check.refusal) return InteractionHelper.safeEditReply(interaction, { content: check.refusal, allowedMentions: { parse: [] } });
    const reason = String(interaction.fields.getTextInputValue('reason') || '').trim();
    if (!reason) return InteractionHelper.safeEditReply(interaction, { content: tr.t('enforcement.quarantine.decide.banNeedsReason'), allowedMentions: { parse: [] } });
    // A modal opened from the alert carries it as interaction.message.
    return runDecision(interaction, client, { ...check, decision: 'ban', userId, reason, tr, alertMessage: interaction.message || null });
}
