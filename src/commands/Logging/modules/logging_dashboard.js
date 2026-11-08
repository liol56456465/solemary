import { EmbedBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { getColor } from '../../../config/bot.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { getLoggingStatus } from '../../../services/loggingService.js';
import {
  createLoggingDashboardComponents,
  createLoggingCategoryViewComponents,
  createLoggingFilterComponents,
  DASHBOARD_CATEGORIES,
  DASHBOARD_CATEGORY_LABELS,
  EVENT_TYPES_BY_CATEGORY,
} from '../../../utils/logging/loggingUi.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';

// The sub-view is recognised by its embed title (old titles still accepted for
// panels opened before the rename).
const CATEGORIES_TITLE = 'Event categories';
const FILTERS_TITLE = 'Ignore filters';

export function getCategoryStatus(enabledEvents, category, auditEnabled) {
  if (!auditEnabled) return false;
  const events = enabledEvents || {};
  if (events[`${category}.*`] === false) return false;
  const categoryEvents = EVENT_TYPES_BY_CATEGORY[category] || [];
  if (categoryEvents.length === 0) return true;
  return categoryEvents.every((eventType) => events[eventType] !== false);
}

async function formatChannelMention(guild, id) {
  if (!id) return 'Not set';
  const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
  return channel ? channel.toString() : `Missing (${id})`;
}

function countEnabledCategories(enabledEvents, auditEnabled) {
  const enabled = DASHBOARD_CATEGORIES.filter((key) =>
    getCategoryStatus(enabledEvents, key, auditEnabled),
  ).length;
  return { enabled, total: DASHBOARD_CATEGORIES.length };
}

export async function buildLoggingDashboardView(interaction, client) {
  const guildConfig = await getGuildConfig(client, interaction.guildId);
  const loggingStatus = await getLoggingStatus(client, interaction.guildId);

  const auditEnabled = Boolean(loggingStatus.enabled);
  const channels = loggingStatus.channels || {};

  const auditChannel = await formatChannelMention(interaction.guild, channels.audit);
  const applicationsChannel = await formatChannelMention(interaction.guild, channels.applications);
  const reportsChannel = await formatChannelMention(interaction.guild, channels.reports);
  const lifecycleChannel = await formatChannelMention(interaction.guild, guildConfig.ticketLogsChannelId);
  const transcriptChannel = await formatChannelMention(interaction.guild, guildConfig.ticketTranscriptChannelId);

  const ignore = loggingStatus.ignore || { users: [], channels: [], roles: [] };
  const { enabled: enabledCount, total } = countEnabledCategories(loggingStatus.enabledEvents, auditEnabled);

  const embed = new EmbedBuilder()
    .setTitle('Logging')
    .setDescription(`Logging for **${interaction.guild.name}**. Use the menu below to set channels, categories and filters.`)
    .setColor(auditEnabled ? getColor('success') : getColor('warning'))
    .addFields(
      {
        name: 'Logging',
        value: auditEnabled ? 'On' : 'Off',
        inline: true,
      },
      {
        name: 'Event categories',
        value: auditEnabled ? `${enabledCount}/${total} on` : 'Logging is off',
        inline: true,
      },
      {
        name: 'Ignore filters',
        value: `${ignore.users?.length || 0} users · ${ignore.channels?.length || 0} channels · ${ignore.roles?.length || 0} roles`,
        inline: true,
      },
      {
        name: 'Log channels',
        value: [
          `**Audit:** ${auditChannel}`,
          `**Applications:** ${applicationsChannel}`,
          `**Reports:** ${reportsChannel}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Ticket channels (read-only)',
        value: [
          `**Ticket logs:** ${lifecycleChannel}`,
          `**Transcripts:** ${transcriptChannel}`,
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: 'Ticket channels are set in /ticket dashboard' })
    .setTimestamp();

  const components = createLoggingDashboardComponents(loggingStatus.enabledEvents, auditEnabled);
  return { embed, components };
}

export async function buildLoggingCategoriesView(interaction, client) {
  const loggingStatus = await getLoggingStatus(client, interaction.guildId);
  const auditEnabled = Boolean(loggingStatus.enabled);

  const categoryLines = DASHBOARD_CATEGORIES.map((key) => {
    const on = getCategoryStatus(loggingStatus.enabledEvents, key, auditEnabled);
    const label = DASHBOARD_CATEGORY_LABELS[key] || key;
    return `${label}: ${on ? 'On' : 'Off'}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(CATEGORIES_TITLE)
    .setDescription(
      auditEnabled
        ? 'Pick which kinds of events go to the audit log channel.'
        : 'Logging is off. Turn it on in the main logging panel first.',
    )
    .setColor(getColor('info'))
    .addFields({ name: 'Categories', value: categoryLines, inline: false })
    .setFooter({ text: 'Green button = on · red button = off' })
    .setTimestamp();

  const components = createLoggingCategoryViewComponents(loggingStatus.enabledEvents, auditEnabled);
  return { embed, components };
}

export async function buildLoggingFilterView(interaction, client) {
  const loggingStatus = await getLoggingStatus(client, interaction.guildId);
  const ignore = loggingStatus.ignore || { users: [], channels: [] };

  const userLines = (ignore.users || []).length
    ? ignore.users.map((id) => `• User \`${id}\``).join('\n')
    : 'None';

  const channelLines = (ignore.channels || []).length
    ? ignore.channels.map((id) => `• <#${id}> (\`${id}\`)`).join('\n')
    : 'None';

  const roleLines = (ignore.roles || []).length
    ? ignore.roles.map((id) => `• <@&${id}> (\`${id}\`)`).join('\n')
    : 'None';

  const embed = new EmbedBuilder()
    .setTitle(FILTERS_TITLE)
    .setDescription('Logs about these users, channels (with their threads; a category with its channels) and members with these roles are skipped. Also `/logging ignore`.')
    .setColor(getColor('info'))
    .addFields(
      { name: 'Ignored users', value: userLines.slice(0, 1024), inline: false },
      { name: 'Ignored channels', value: channelLines.slice(0, 1024), inline: false },
      { name: 'Ignored roles', value: roleLines.slice(0, 1024), inline: false },
    )
    .setFooter({ text: 'Use the buttons below to add or remove one' })
    .setTimestamp();

  const components = createLoggingFilterComponents();
  return { embed, components };
}

export function isCategoriesView(interaction) {
  return [CATEGORIES_TITLE, '📋 Event Categories'].includes(interaction.message?.embeds?.[0]?.title);
}

export function isFilterView(interaction) {
  return [FILTERS_TITLE, '🔇 Log Ignore Filters'].includes(interaction.message?.embeds?.[0]?.title);
}

/**
 * Re-render the dashboard the component sits on. The dashboard is ephemeral, and
 * ephemeral messages cannot be edited with message.edit(); when the caller has a
 * modal submission that came from the dashboard, update the message through it.
 * Returns true when `responder` was used to acknowledge (follow up afterwards).
 */
export async function refreshDashboardMessage(interaction, client, responder = null) {
  let view;
  if (isCategoriesView(interaction)) {
    view = await buildLoggingCategoriesView(interaction, client);
  } else if (isFilterView(interaction)) {
    view = await buildLoggingFilterView(interaction, client);
  } else {
    view = await buildLoggingDashboardView(interaction, client);
  }

  const payload = {
    embeds: [view.embed],
    components: view.components,
    content: null,
  };

  if (responder?.isFromMessage?.() && !responder.deferred && !responder.replied) {
    await responder.update(payload);
    return true;
  }

  await interaction.message.edit(payload).catch(() => {});
  return false;
}

export default {
  prefixOnly: false,
  async execute(interaction, config, client) {
    try {
      if (!hasAdminAccess(interaction)) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Administrator** permission to view the logging dashboard.' });
      }

      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      const { embed, components } = await buildLoggingDashboardView(interaction, client);
      await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components });
    } catch (error) {
      logger.error('logging_dashboard error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to load the logging dashboard.' });
    }
  },
};
