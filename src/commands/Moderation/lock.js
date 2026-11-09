import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { lockChannel } from '../../services/channelToolsService.js';
import { LOCK_MAX_MS, LOCK_MIN_MS } from '../../services/moderation/channelLock.js';
import { parseDuration } from '../../services/enforcement/format.js';

const NO_MENTIONS = Object.freeze({ parse: [] });

/** A lock/unlock refusal (error.code from channelLock.js / channelToolsService.js) → { type, message }, translated. */
export function lockRefusal(tr, error, channel, ns = 'lock') {
    const params = { channel: String(channel), perms: error?.params?.perms || '', done: error?.params?.done ?? 0, total: error?.params?.total ?? 0 };
    const shared = { dbDown: ['dbDown', ErrorTypes.DATABASE], botMissing: ['botMissing', ErrorTypes.PERMISSION] };
    const keys = ns === 'unlock'
        ? { ...shared, notLocked: ['notLocked', ErrorTypes.VALIDATION], notOverwrite: ['notOverwrite', ErrorTypes.VALIDATION], partialUnlock: ['partial', ErrorTypes.PERMISSION] }
        : { ...shared, alreadyLocked: ['already', ErrorTypes.VALIDATION], badDuration: ['badDuration', ErrorTypes.VALIDATION], partial: ['partial', ErrorTypes.PERMISSION] };
    const [key, type] = (Object.hasOwn(keys, error?.code) && keys[error.code]) || ['failed', ErrorTypes.PERMISSION];
    return { type, message: tr.t(`moderation.${ns}.${key}`, params) };
}

/** Role mentions for the moderator's note (never pinged: allowedMentions none). */
const roleList = (ids) => ids.slice(0, 15).map((id) => `<@&${id}>`).join(', ') + (ids.length > 15 ? ` +${ids.length - 15}` : '');

export default {
    data: new SlashCommandBuilder()
    .setName("lock")
    .setDescription(
      "Locks the current channel (prevents @everyone from sending messages).",
    )
    .setDescriptionLocalizations(descriptionLocalizations('moderation.lock.cmd.description'))
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('Unlock automatically after this time, e.g. 30m, 2h, 1d (up to 30 days)')
        .setDescriptionLocalizations(descriptionLocalizations('moderation.lock.cmd.duration'))
        .setMaxLength(20)
        .setRequired(false),
    )
.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  category: "moderation",

  async execute(interaction, config, client, deps = {}) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`Lock interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'lock'
      });
      return;
    }

    // Errors and the role note: the moderator's language; the lock notice is posted in the channel: the server's language.
    const tr = textForInteraction(interaction);
    const pub = textForInteraction(interaction, { purpose: 'public' });
    const channel = interaction.channel;

    const durationText = interaction.options?.getString?.('duration')?.trim() || '';
    let durationMs = null;
    if (durationText) {
      durationMs = parseDuration(durationText);
      if (!durationMs || durationMs < LOCK_MIN_MS || durationMs > LOCK_MAX_MS) {
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('moderation.lock.badDuration') });
      }
    }

    let result;
    try {
      result = await (deps.lockChannel || lockChannel)({
        client, guild: interaction.guild, channel, moderator: interaction.user, durationMs, via: 'command',
        auditReason: `Channel locked by ${interaction.user.tag}`.slice(0, 512),
        ...(deps.lockStore ? { lockStore: deps.lockStore } : {}), ...(deps.log ? { log: deps.log } : {}),
      });
    } catch (error) {
      if (!error?.code) logger.error('Lock command error:', error);
      return await replyUserError(interaction, lockRefusal(tr, error, channel));
    }

    const unlockAt = result.unlockAt ? Math.floor(new Date(result.unlockAt).getTime() / 1000) : null;
    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        successEmbed(
          pub.t('moderation.lock.title'),
          unlockAt
            ? pub.t('moderation.lock.doneUntil', { channel: String(channel), time: `<t:${unlockAt}:F>`, relative: `<t:${unlockAt}:R>` })
            : pub.t('moderation.lock.done', { channel: String(channel) }),
        ),
      ],
      allowedMentions: NO_MENTIONS,
    });

    // What happened to roles with their own allow: only for the moderator (a slash command; a
    // prefix answer has no private follow-up).
    const notes = [];
    if (result.changed?.length) notes.push(tr.tp('moderation.lock.rolesLocked', result.changed.length, { roles: roleList(result.changed) }));
    if (result.kept?.length) notes.push(tr.tp('moderation.lock.rolesKept', result.kept.length, { roles: roleList(result.kept) }));
    if (notes.length && !interaction._isPrefixCommand && typeof interaction.followUp === 'function') {
      await interaction.followUp({ content: notes.join('\n'), flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS })
        .catch((error) => logger.debug(`Lock note not sent: ${error.message}`));
    }
  }
};
