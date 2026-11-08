import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
  getBotMessage,
  isBotOwner,
  isCommandCategoryEnabled,
  isMaintenanceMode,
} from '../config/bot.js';
import botConfig from '../config/bot.js';
import { handleApplicationModal } from '../commands/Community/apply.js';
import { handleInteractionError, createError, ErrorTypes, ErrorCodes } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { createInteractionTraceContext, runWithTraceContext } from '../utils/logger.js';
import { validateChatInputPayloadOrThrow } from '../utils/commandInputValidation.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { resolveSlashAccessKey } from '../utils/messageAdapter.js';
import { isCollectorManagedComponent } from '../utils/collectorComponents.js';
import { ResponseCoordinator } from '../utils/responseCoordinator.js';
import { checkCommandAccess } from '../utils/commandGate.js';
import { botText, resolveBotLanguage } from '../utils/botText.js';
import { BLACKLIST_MESSAGE, blacklistHit } from '../services/owner/blacklistCache.js';
import { noteOwnerOverride } from '../services/ownerOverride.js';
import { skipIfArrivedTooLate, noticeIfHandlerMissedDeadline } from '../utils/lateInteractionNotice.js';
import { armAckSafetyNet, opensModal, interactionsAreWarm, waitForStartupCaches } from '../utils/ackSafetyNet.js';
import { runAutocompleteWithDeadline } from '../utils/autocompleteDeadline.js';

const COMMAND_ERROR_SUBTYPES = {
  ticket: 'ticket_failed',
  serverstats: 'serverstats_failed',
  giveaway: 'giveaway_failed',
};

// Components without a registered handler are answered by message collectors. Those
// live in memory for at most 15 minutes and die with the process, so a press on a
// message that has been idle longer (or predates this process) reaches nobody and
// Discord shows "This interaction failed". Answer those presses instead.
const PROCESS_STARTED_AT = Date.now();
const MAX_COLLECTOR_LIFETIME_MS = 15 * 60 * 1000;
const EXPIRED_COMPONENT_MESSAGE = 'This menu has expired. Run the command again to get a fresh one.';

function isExpiredCollectorMessage(message) {
  if (!message) return false;
  const lastActivity = Math.max(message.createdTimestamp || 0, message.editedTimestamp || 0);
  if (!lastActivity) return false;
  return lastActivity < PROCESS_STARTED_AT || Date.now() - lastActivity > MAX_COLLECTOR_LIFETIME_MS;
}

async function replyExpiredComponent(interaction) {
  if (!isExpiredCollectorMessage(interaction.message)) return;
  await InteractionHelper.safeReply(interaction, {
    content: EXPIRED_COMPONENT_MESSAGE,
    flags: MessageFlags.Ephemeral,
  });
}

/** True when a component / modal interaction was refused by the blacklist (answered or ignored). */
export async function refuseBlacklistedComponent(interaction) {
  const isComponent = interaction.isMessageComponent?.() || interaction.isModalSubmit?.();
  if (!isComponent) return false;
  const blocked = blacklistHit({ userId: interaction.user?.id, guildId: interaction.guildId || null });
  if (!blocked) return false;
  if (blocked.kind === 'user') {
    await InteractionHelper.safeReply(interaction, {
      content: BLACKLIST_MESSAGE,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  return true;
}

// While the bot is starting (or the database is known down) an interaction is acknowledged at
// once, then the handler waits up to this long for the startup caches.
const STARTUP_CACHE_WAIT_MS = 10 * 1000;

/**
 * Arms the 3-second safety net (utils/ackSafetyNet.js) for a registered handler. Modal paths
 * (`opensModal` on the handler or command) are exempt from the 2-second auto-defer (a modal must
 * be the first response); they only get the last-moment "please try again" fallback.
 * When the bot is not warm yet, acknowledges at once and waits for the startup caches.
 */
async function armSafetyNet(interaction, client, handler, args = []) {
  const net = armAckSafetyNet(interaction, {
    exempt: opensModal(handler, interaction, args),
    ephemeral: handler?.ackEphemeral !== false,
  });
  if (!net.exempt && !interactionsAreWarm(client)) {
    await net.fireNow('startup');
    await waitForStartupCaches(STARTUP_CACHE_WAIT_MS);
  }
  return net;
}

/** The autocomplete answer: the command's own handler, or the application-name lists below. */
async function answerAutocomplete(interaction, client, command) {
  if (command?.autocomplete) {
    await command.autocomplete(interaction, client);
    return;
  }
  const focusedOption = interaction.options.getFocused(true);
  const isApply = interaction.commandName === 'apply';
  if ((isApply || interaction.commandName === 'app-admin') && focusedOption.name === 'application') {
    const { getApplicationRoles } = await import('../utils/database.js');
    const roles = await getApplicationRoles(client, interaction.guildId);
    const typed = interaction.options.getString('application', false)?.toLowerCase() || '';
    const filtered = roles.filter((role) => (!isApply || role.enabled !== false) && role.name.toLowerCase().startsWith(typed));
    await interaction.respond(filtered.slice(0, 25).map((role) => ({
      name: `${role.name}${role.enabled === false ? ' (disabled)' : ''}`,
      value: role.name,
    })));
  }
}

function withTraceContext(context = {}, traceContext = {}) {
  return {
    traceId: traceContext.traceId,
    guildId: context.guildId || traceContext.guildId,
    userId: context.userId || traceContext.userId,
    command: context.commandName || traceContext.command,
    ...context
  };
}

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    const interactionTraceContext = createInteractionTraceContext(interaction);
    interaction.traceContext = interactionTraceContext;
    interaction.traceId = interactionTraceContext.traceId;

    return runWithTraceContext(interactionTraceContext, async () => {
      // Set once a registered handler runs, so the late check below skips
      // collector-managed and inline-awaited interactions.
      let dispatched = false;
      // The 3-second safety net, armed once the handler is known; disarmed when it finishes.
      let net = null;
      try {
        InteractionHelper.patchInteractionResponses(interaction);
        ResponseCoordinator.attach(interaction);

        // Global blacklist (dashboard Owner area) for buttons, select menus and modals; commands
        // are checked by the command gate. A blacklisted server is ignored without an answer.
        if (await refuseBlacklistedComponent(interaction)) return;

        if (interaction.isChatInputCommand()) {
          try {
            logger.debug(`Command received: /${interaction.commandName}`, {
              event: 'interaction.command.received',
              traceId: interactionTraceContext.traceId,
              guildId: interaction.guildId,
              userId: interaction.user?.id,
              command: interaction.commandName
            });

            validateChatInputPayloadOrThrow(interaction, withTraceContext({
              type: 'command_input_validation',
              commandName: interaction.commandName
            }, interactionTraceContext));

            const command = client.commands.get(interaction.commandName);
            // Ephemeral refusals below: the user's Discord language (utils/botText.js).
            const replyText = botText(resolveBotLanguage({ interaction, guildId: interaction.guildId, member: interaction.member, userId: interaction.user.id, purpose: 'reply' }));

            if (!command) {
              throw createError(
                `No command matching ${interaction.commandName} was found.`,
                ErrorTypes.CONFIGURATION,
                replyText.t('errors.dispatch.unknownCommand'),
                withTraceContext({ commandName: interaction.commandName }, interactionTraceContext)
              );
            }

            // Armed before the gate: its config reads (guild config, command toggles,
            // cooldown store) count towards the 3 seconds too.
            net = await armSafetyNet(interaction, client, command);

            const access = checkCommandAccess({
              command,
              accessKey: resolveSlashAccessKey(interaction),
              guild: interaction.guild,
              userId: interaction.user.id,
              permissions: interaction.memberPermissions,
              // An ephemeral refusal: the user's Discord language.
              lang: resolveBotLanguage({ interaction, guildId: interaction.guildId, member: interaction.member, userId: interaction.user.id, purpose: 'reply' }),
            });
            if (!access.allowed) {
              // A blacklisted server is ignored (no answer at all).
              if (access.silent) return;
              await InteractionHelper.safeReply(interaction, {
                content: access.message,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
              });
              return;
            }
            if (access.ownerOverride) {
              noteOwnerOverride({ client, guildId: interaction.guildId, userId: interaction.user.id, username: interaction.user.username,
                action: `/${resolveSlashAccessKey(interaction) || interaction.commandName}`, via: 'slash' });
            }

            if (isMaintenanceMode() && !isBotOwner(interaction.user.id)) {
              throw createError(
                'Bot is in maintenance mode',
                ErrorTypes.CONFIGURATION,
                getBotMessage('maintenanceMode'),
                withTraceContext({ commandName: interaction.commandName }, interactionTraceContext)
              );
            }

            if (!isCommandCategoryEnabled(command.category)) {
              throw createError(
                `Feature disabled for category ${command.category}`,
                ErrorTypes.CONFIGURATION,
                getBotMessage('commandDisabled'),
                withTraceContext({ commandName: interaction.commandName, category: command.category }, interactionTraceContext)
              );
            }

            const defaultCooldownSec = Number(botConfig.commands?.defaultCooldown) || 0;
            if (defaultCooldownSec > 0 && !isBotOwner(interaction.user.id)) {
              const cooldownKey = `${interaction.user.id}:${interaction.commandName}`;
              const expiresAt = client.cooldowns.get(cooldownKey);

              if (expiresAt && Date.now() < expiresAt) {
                const remainingSec = Math.ceil((expiresAt - Date.now()) / 1000);
                throw createError(
                  `Default command cooldown active for ${interaction.commandName}`,
                  ErrorTypes.RATE_LIMIT,
                  getBotMessage('cooldownActive', { time: `${remainingSec}s` }),
                  withTraceContext({ commandName: interaction.commandName, remainingSec }, interactionTraceContext)
                );
              }

              client.cooldowns.set(cooldownKey, Date.now() + defaultCooldownSec * 1000);
            }

            const abuseProtection = await enforceAbuseProtection(interaction, command, interaction.commandName);
            if (!abuseProtection.allowed) {
              const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
              throw createError(
                `Risky command cooldown active for ${interaction.commandName}`,
                ErrorTypes.RATE_LIMIT,
                replyText.t('errors.dispatch.cooldown', { time: formattedCooldown }),
                withTraceContext({
                  commandName: interaction.commandName,
                  subtype: 'command_cooldown',
                  expected: true,
                  cooldownMs: abuseProtection.remainingMs,
                  cooldownWindowMs: abuseProtection.policy?.windowMs,
                  cooldownMaxAttempts: abuseProtection.policy?.maxAttempts
                }, interactionTraceContext)
              );
            }

            let guildConfig = null;
            if (interaction.guild) {
              guildConfig = await getGuildConfig(client, interaction.guild.id, interactionTraceContext);
              const accessKey = resolveSlashAccessKey(interaction);
              if (!(await isCommandEnabled(client, interaction.guild.id, accessKey, command.category))) {
                throw createError(
                  `Command ${accessKey} is disabled in this guild`,
                  ErrorTypes.CONFIGURATION,
                  replyText.t('errors.dispatch.disabledHere'),
                  withTraceContext({ commandName: accessKey, guildId: interaction.guild.id }, interactionTraceContext)
                );
              }
            }

            // Access was decided by checkCommandAccess above (the single source of truth); a
            // command's setDefaultMemberPermissions is not enforced again here (it is stripped at
            // registration, commandLoader.js collectCommandPayloads).

            if (await skipIfArrivedTooLate(interaction)) return;
            dispatched = true;
            await command.execute(interaction, guildConfig, client);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'command',
              commandName: interaction.commandName,
              subtype: COMMAND_ERROR_SUBTYPES[interaction.commandName] || error?.context?.subtype,
            }, interactionTraceContext));
          }
        } else if (interaction.isContextMenuCommand()) {
          // Right-click commands ("Report message"): same access rules, no options to validate.
          const command = client.commands.get(interaction.commandName);
          try {
            if (!command) {
              throw createError(`No context menu command ${interaction.commandName}`, ErrorTypes.CONFIGURATION,
                botText(resolveBotLanguage({ interaction, guildId: interaction.guildId, userId: interaction.user.id, purpose: 'reply' })).t('errors.dispatch.unknownCommand'),
                withTraceContext({ commandName: interaction.commandName }, interactionTraceContext));
            }
            net = await armSafetyNet(interaction, client, command);
            const access = checkCommandAccess({
              command,
              accessKey: interaction.commandName,
              guild: interaction.guild,
              userId: interaction.user.id,
              permissions: interaction.memberPermissions,
              lang: resolveBotLanguage({ interaction, guildId: interaction.guildId, member: interaction.member, userId: interaction.user.id, purpose: 'reply' }),
            });
            if (!access.allowed) {
              if (access.silent) return;
              await InteractionHelper.safeReply(interaction, { content: access.message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
              return;
            }
            if (access.ownerOverride) {
              noteOwnerOverride({ client, guildId: interaction.guildId, userId: interaction.user.id, username: interaction.user.username,
                action: interaction.commandName, via: 'context menu' });
            }
            if (await skipIfArrivedTooLate(interaction)) return;
            dispatched = true;
            await command.execute(interaction, null, client);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'context_menu',
              commandName: interaction.commandName,
            }, interactionTraceContext));
          }
        } else if (interaction.isAutocomplete()) {
          const autocompleteCommand = client.commands.get(interaction.commandName);
          const autocompleteAccess = checkCommandAccess({
            command: autocompleteCommand,
            accessKey: resolveSlashAccessKey(interaction),
            guild: interaction.guild,
            userId: interaction.user.id,
            permissions: interaction.memberPermissions,
          });
          if (!autocompleteAccess.allowed) {
            await interaction.respond([]).catch(() => {});
            return;
          }

          // Autocomplete can't be deferred: answered within the deadline, with the last
          // choices (or an empty list) when the handler is too slow.
          await runAutocompleteWithDeadline(interaction, (i) => answerAutocomplete(i, client, autocompleteCommand));
        } else if (interaction.isButton()) {
          if (interaction.customId.startsWith('shared_todo_')) {
            const parts = interaction.customId.split('_');
            const buttonType = parts.slice(0, 3).join('_');
            const listId = parts[3];
            const button = client.buttons.get(buttonType);

            if (button) {
              try {
                net = await armSafetyNet(interaction, client, button, [listId]);
                if (await skipIfArrivedTooLate(interaction)) return;
                dispatched = true;
                await button.execute(interaction, client, [listId]);
              } catch (error) {
                await handleInteractionError(interaction, error, withTraceContext({
                  type: 'button',
                  customId: interaction.customId,
                  handler: 'todo'
                }, interactionTraceContext));
              }
            } else {
              throw createError(
                `No button handler found for ${buttonType}`,
                ErrorTypes.CONFIGURATION,
                'This button is not available.',
                withTraceContext({ buttonType }, interactionTraceContext)
              );
            }
            return;
          }

          const [customId, ...args] = interaction.customId.split(':');
          const button = client.buttons.get(customId);

          if (!button) {
            if (!interaction.customId.includes(':') || isCollectorManagedComponent(customId)) {
              await replyExpiredComponent(interaction);
              return;
            }

            throw createError(
              `No button handler found for ${customId}`,
              ErrorTypes.CONFIGURATION,
              'This button is not available.',
              withTraceContext({ customId }, interactionTraceContext)
            );
          }

          try {
            net = await armSafetyNet(interaction, client, button, args);
            if (await skipIfArrivedTooLate(interaction)) return;
            dispatched = true;
            await button.execute(interaction, client, args);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'button',
              customId: interaction.customId,
              handler: 'general'
            }, interactionTraceContext));
          }
        } else if (interaction.isStringSelectMenu()) {
          const [customId, ...args] = interaction.customId.split(':');
          const selectMenu = client.selectMenus.get(customId);

          if (!selectMenu) {
            if (!interaction.customId.includes(':') || isCollectorManagedComponent(customId)) {
              await replyExpiredComponent(interaction);
              return;
            }

            throw createError(
              `No select menu handler found for ${customId}`,
              ErrorTypes.CONFIGURATION,
              'This select menu is not available.',
              withTraceContext({ customId }, interactionTraceContext)
            );
          }

          try {
            net = await armSafetyNet(interaction, client, selectMenu, args);
            if (await skipIfArrivedTooLate(interaction)) return;
            dispatched = true;
            await selectMenu.execute(interaction, client, args);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'select_menu',
              customId: interaction.customId
            }, interactionTraceContext));
          }
        } else if (interaction.isAnySelectMenu?.()) {
          // User/role/channel select menus only ever belong to collectors.
          await replyExpiredComponent(interaction);
        } else if (interaction.isModalSubmit()) {
          if (interaction.customId.startsWith('app_modal_')) {
            try {
              net = await armSafetyNet(interaction, client, null);
              if (await skipIfArrivedTooLate(interaction)) return;
              dispatched = true;
              await handleApplicationModal(interaction);
            } catch (error) {
              await handleInteractionError(interaction, error, withTraceContext({
                type: 'modal',
                customId: interaction.customId,
                handler: 'application'
              }, interactionTraceContext));
            }
            return;
          }

          if (
            interaction.customId.startsWith('app_review_')
            || interaction.customId.startsWith('jtc_')
            || interaction.customId.startsWith('config_wizard_modal:')
            || interaction.customId.startsWith('log_dash_channel_modal:')
            || interaction.customId.startsWith('log_dash_filter_modal:')
          ) {
            logger.debug(`Skipping modal handler lookup for inline-awaited modal: ${interaction.customId}`, {
              event: 'interaction.modal.inline_skipped',
              traceId: interactionTraceContext.traceId
            });
            return;
          }

          const [customId, ...args] = interaction.customId.split(':');
          const modal = client.modals.get(customId);

          if (!modal) {
            if (!interaction.customId.includes(':')) {

              return;
            }

            throw createError(
              `No modal handler found for ${customId}`,
              ErrorTypes.CONFIGURATION,
              'This form is not available.',
              withTraceContext({ customId }, interactionTraceContext)
            );
          }

          try {
            net = await armSafetyNet(interaction, client, modal, args);
            if (await skipIfArrivedTooLate(interaction)) return;
            dispatched = true;
            await modal.execute(interaction, client, args);
          } catch (error) {
            await handleInteractionError(interaction, error, withTraceContext({
              type: 'modal',
              customId: interaction.customId,
              handler: 'general'
            }, interactionTraceContext));
          }
        }
      } catch (error) {
        logger.error('Unhandled error in interactionCreate:', {
          event: 'interaction.unhandled_error',
          errorCode: ErrorCodes.INTERACTION_UNHANDLED,
          error,
          traceId: interactionTraceContext.traceId,
          interactionId: interaction.id,
          guildId: interaction.guildId,
          userId: interaction.user?.id
        });

        try {
          await handleInteractionError(interaction, error, withTraceContext({
            type: 'interaction',
            commandName: interaction.commandName,
            customId: interaction.customId,
            source: 'interactionCreate.unhandled'
          }, interactionTraceContext));
        } catch (replyError) {
          logger.error('Failed to send fallback error response:', {
            event: 'interaction.error_response_failed',
            errorCode: ErrorCodes.INTERACTION_RESPONSE_FAILED,
            error: replyError,
            traceId: interactionTraceContext.traceId
          });
        }
      } finally {
        net?.disarm();
        if (dispatched) {
          await noticeIfHandlerMissedDeadline(interaction).catch(() => {});
        }
      }
    });
  }
};