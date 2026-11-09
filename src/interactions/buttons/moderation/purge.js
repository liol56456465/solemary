// purge:<confirm|cancel>:<nonce> — the /purge preview buttons (services/moderation/purgePreview.js).
// Acknowledged first (deferUpdate, 3 s), then re-checked on every click: the preview must still be
// open, the clicker must be the moderator who ran /purge, and they must still pass the
// Administrator gate (hasAdminAccess, the same rule the command had). The result replaces the
// preview (its buttons go away); the mod log entry is in the server's language.

import { MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { createEmbed, successEmbed } from '../../../utils/embeds.js';
import { hasAdminAccess, getAdminRequiredMessage } from '../../../utils/commandGate.js';
import { textForInteraction } from '../../../utils/botText.js';
import { logEvent } from '../../../utils/moderation.js';
import { TOOL_PERMS, missingBotPerms } from '../../../services/channelToolsService.js';
import { PURGE_BUTTON, deletePreviewed, purgePreviews, resultText } from '../../../services/moderation/purgePreview.js';

const NO_MENTIONS = Object.freeze({ parse: [] });

function done(interaction, embed) {
    return interaction.editReply({ embeds: [embed], components: [], allowedMentions: NO_MENTIONS });
}

/** deps (tests): previews, isAdmin, log, now. */
export async function handlePurgeButton(interaction, client, args = [], deps = {}) {
    const [action, nonce] = Array.isArray(args) ? args : [];
    const previews = deps.previews || purgePreviews;
    const isAdmin = deps.isAdmin || hasAdminAccess;
    const log = deps.log || logEvent;
    const now = deps.now ?? Date.now();
    const tr = textForInteraction(interaction);

    const entry = previews.peek(nonce, now);
    if (entry && entry.userId !== interaction.user?.id) {
        // Someone else's preview (a prefix answer is public): a private note, the preview stays.
        await interaction.reply({ content: tr.t('moderation.purge.notYours'), flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS }).catch(() => {});
        return;
    }
    await interaction.deferUpdate();
    if (!entry || !['confirm', 'cancel'].includes(action) || entry.guildId !== interaction.guildId || entry.channelId !== interaction.channelId) {
        previews.take(nonce, now);
        await done(interaction, createEmbed({ title: tr.t('moderation.purge.previewTitle'), description: tr.t('moderation.purge.expired'), color: 'secondary' }));
        return;
    }
    if (action === 'cancel') {
        previews.take(nonce, now);
        await done(interaction, createEmbed({ title: tr.t('moderation.purge.previewTitle'), description: tr.t('moderation.purge.cancelled'), color: 'info' }));
        return;
    }
    if (!isAdmin(interaction)) {
        previews.take(nonce, now);
        await done(interaction, createEmbed({ title: tr.t('moderation.purge.previewTitle'), description: getAdminRequiredMessage(interaction.guildId, { lang: tr.lang }), color: 'warning' }));
        return;
    }
    const channel = interaction.channel;
    const missing = missingBotPerms(interaction.guild, channel, TOOL_PERMS.purge);
    if (missing.length) {
        previews.take(nonce, now);
        await done(interaction, createEmbed({ title: tr.t('moderation.purge.previewTitle'), description: tr.t('moderation.purge.botMissing', { perms: missing.join(', '), channel: String(channel) }), color: 'error' }));
        return;
    }
    previews.take(nonce, now); // one click wins: a second click finds the preview gone

    let result;
    try {
        result = await deletePreviewed(channel, entry, now);
    } catch (error) {
        logger.error('Purge confirm error:', error);
        await done(interaction, createEmbed({ title: tr.t('moderation.purge.previewTitle'), description: tr.t('moderation.purge.failed'), color: 'error' }));
        return;
    }

    // The mod log is a channel post: the server's language.
    const pub = textForInteraction(interaction, { purpose: 'public' });
    await log({
        client,
        guild: interaction.guild,
        event: {
            action: 'Messages Purged',
            target: `${channel} (${result.deleted})`,
            executor: `${interaction.user.tag} (${interaction.user.id})`,
            reason: resultText(pub, { ...result, channel }),
            metadata: {
                channelId: channel.id,
                messageCount: result.deleted,
                requestedAmount: entry.requested,
                skippedOld: result.skippedOld,
                moderatorId: interaction.user.id,
            },
        },
    });

    await done(interaction, successEmbed(tr.t('moderation.purge.title'), resultText(tr, { ...result, channel })));
}

export default {
    name: PURGE_BUTTON,
    async execute(interaction, client, args) {
        return handlePurgeButton(interaction, client, args);
    },
};
