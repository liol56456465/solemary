// invreset:<confirm|cancel>:<invokerId>:<target> — the /invites reset confirmation.
// target: a user id (that inviter) or 'all' (the whole server: setting inviteTracking.resetAt).
// Re-checked on every click: the clicker must be the admin who ran /invites reset AND still pass
// the Administrator gate (hasAdminAccess). Acknowledged first (deferUpdate, 3 s). A reset never
// deletes joins: only joins after it count, and the bonus starts again at 0.

import { MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { replyText } from '../../../utils/commandLocalizations.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';
import { createEmbed } from '../../../utils/embeds.js';
import { INVITE_RESET_BUTTON, NO_MENTIONS } from '../../../commands/Community/invites.js';
import { resetInviter } from '../../../services/invites/inviteStore.js';
import { forgetLeaderboard, INVITE_SETTING_KEY, normalizeInviteSettings } from '../../../services/invites/inviteStats.js';
import { settingGuildId, updateSettings } from '../../../services/settings/guildSettings.js';

const ID = /^\d{17,20}$/;

function done(interaction, description, color) {
    const tr = replyText(interaction);
    return interaction.editReply({ embeds: [createEmbed({ title: tr.t('invites.reset.title'), description, color })], components: [], allowedMentions: NO_MENTIONS });
}

/** The server-wide reset: resetAt = now in the setting (row-locked read-modify-write). */
export async function resetServer(guildId, actor, { update = updateSettings, now = new Date() } = {}) {
    const rowGuild = settingGuildId(guildId, INVITE_SETTING_KEY) || guildId;
    await update(rowGuild, (valueOf) => ({ [INVITE_SETTING_KEY]: { ...normalizeInviteSettings(valueOf(INVITE_SETTING_KEY)), resetAt: now.toISOString() } }),
        { userId: actor.id, username: actor.username, module: 'invites' });
}

/** deps (tests): resetUser, resetAll, isAdmin. */
export async function handleInviteResetButton(interaction, client, args = [], deps = {}) {
    const [action, invokerId, target] = Array.isArray(args) ? args : [];
    const tr = replyText(interaction);
    const isAdmin = deps.isAdmin || hasAdminAccess;
    if (!['confirm', 'cancel'].includes(action) || invokerId !== interaction.user?.id || !(target === 'all' || ID.test(String(target)))) {
        await interaction.reply({ content: tr.t('invites.reset.notYours'), flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS }).catch(() => {});
        return;
    }
    await interaction.deferUpdate();
    if (!isAdmin(interaction)) {
        await done(interaction, tr.t('invites.reset.noAdmin'), 'warning');
        return;
    }
    if (action === 'cancel') {
        await done(interaction, tr.t('invites.reset.cancelled'), 'info');
        return;
    }
    try {
        if (target === 'all') await (deps.resetAll || resetServer)(interaction.guildId, interaction.user);
        else await (deps.resetUser || resetInviter)(interaction.guildId, target, { actorId: interaction.user.id });
    } catch (error) {
        logger.warn(`/invites reset ${target} failed in guild ${interaction.guildId}: ${error.message}`);
        await done(interaction, tr.t('invites.error.dbDown'), 'warning');
        return;
    }
    forgetLeaderboard(interaction.guildId);
    logger.info(`/invites reset: ${interaction.user.id} reset ${target === 'all' ? 'the whole server' : target} in guild ${interaction.guildId}`);
    await done(interaction, target === 'all' ? tr.t('invites.reset.doneAll') : tr.t('invites.reset.doneUser', { user: `<@${target}>` }), 'success');
}

export default {
    name: INVITE_RESET_BUTTON,
    async execute(interaction, client, args) {
        return handleInviteResetButton(interaction, client, args);
    },
};
