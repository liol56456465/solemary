// /serverdata delete buttons. customId serverdata:<confirm|leave|dismiss|cancel>:<ownerId>.
// Re-checked on every click: the clicker must be the user the panel was opened for AND still the
// server's owner (fresh from Discord); Mewvo's own servers are refused. Deferred first (3 s).

import { MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { replyText } from '../../../commands/Core/modules/commandText.js';
import {
    SERVERDATA_BUTTON, plainMessage, refusalText, scheduledMessage,
} from '../../../commands/Utility/serverdata.js';
import {
    cancelServerDeletion, checkServerOwner, requestServerDeletion,
} from '../../../services/privacy/serverDataDeletion.js';

const ACTIONS = new Set(['confirm', 'leave', 'dismiss', 'cancel']);

export async function handleServerDataButton(interaction, client, args, {
    check = checkServerOwner, request = requestServerDeletion, cancel = cancelServerDeletion,
} = {}) {
    const [action, ownerId] = Array.isArray(args) ? args : [];
    const tr = replyText(interaction);
    const userId = interaction.user?.id;
    if (!ACTIONS.has(action) || !ownerId || ownerId !== userId) {
        await interaction.reply({ content: tr.t('serverdata.refuse.notYours'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
        return;
    }
    await interaction.deferUpdate();
    if (action === 'dismiss') {
        await interaction.editReply(plainMessage(tr.t('serverdata.dismissed')));
        return;
    }
    const guildId = interaction.guildId;
    const ok = await check({ client, guildId, userId });
    if (!ok.allowed) {
        logger.info(`/serverdata ${action} refused for ${userId} in ${guildId}: ${ok.reason}`);
        await interaction.editReply(plainMessage(refusalText(ok.reason, tr)));
        return;
    }
    try {
        if (action === 'cancel') {
            const { cancelled, record } = await cancel({ guildId, userId });
            if (cancelled) await interaction.editReply(plainMessage(tr.t('serverdata.cancelled')));
            else if (record?.status === 'running') await interaction.editReply(scheduledMessage(record, userId, tr));
            else await interaction.editReply(plainMessage(tr.t('serverdata.notScheduled')));
            return;
        }
        const { record, created } = await request({
            guildId, userId, removeBot: action === 'leave', source: 'command', lang: tr.lang, guildName: interaction.guild?.name || null,
        });
        await interaction.editReply(scheduledMessage(record, userId, tr, { already: !created }));
    } catch (error) {
        logger.error(`/serverdata ${action} in ${guildId}: ${error.message}`);
        await interaction.editReply(plainMessage(tr.t('serverdata.refuse.database')));
    }
}

export default {
    name: SERVERDATA_BUTTON,
    async execute(interaction, client, args) {
        return handleServerDataButton(interaction, client, args);
    },
};
