import { EmbedBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { getColor } from '../../../config/bot.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { getLoggingStatus } from '../../../services/loggingService.js';
import {
  createLoggingDashboardComponents,
  createLoggingCategoryViewComponents,
  createLoggingFilterComponents,
  DASHBOARD_CATEGORIES,
  EVENT_TYPES_BY_CATEGORY,
  categoryLabel,
} from '../../../utils/logging/loggingUi.js';
import { LANG_CODES, botText, textForInteraction } from '../../../utils/botText.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { hasAdminAccess } from '../../../utils/commandGate.js';

// The sub-view is recognised by its embed title, in any of the 8 languages (the panel is in
// the language of whoever opened it; old titles still accepted for panels opened before the rename).
// Every view is ephemeral: the admin's Discord language (interaction.locale).
let viewTitles = null;
function titlesOf() {
  viewTitles ??= {
    categories: new Set([...LANG_CODES.map((lang) => botText(lang).t('logging.categories.title')), '📋 Event Categories']),
    filters: new Set([...LANG_CODES.map((lang) => botText(lang).t('logging.filters.title')), '🔇 Log Ignore Filters']),
  };
  return viewTitles;
}

export function getCategoryStatus(enabledEvents, category, auditEnabled) {
  if (!auditEnabled) return false;
  const events = enabledEvents || {};
  if (events[`${category}.*`] === false) return false;
  const categoryEvents = EVENT_TYPES_BY_CATEGORY[category] || [];
  if (categoryEvents.length === 0) return true;
  return categoryEvents.every((eventType) => events[eventType] !== false);
}

async function formatChannelMention(guild, id, tr) {
  if (!id) return tr.t('logging.dashboard.notSet');
  const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
  return channel ? channel.toString() : tr.t('logging.dashboard.missing', { id });
}

function countEnabledCategories(enabledEvents, auditEnabled) {
  const enabled = DASHBOARD_CATEGORIES.filter((key) =>
    getCategoryStatus(enabledEvents, key, auditEnabled),
  ).length;
  return { enabled, total: DASHBOARD_CATEGORIES.length };
}

export async function buildLoggingDashboardView(interaction, client) {
  const tr = textForInteraction(interaction);
  const guildConfig = await getGuildConfig(client, interaction.guildId);
  const loggingStatus = await getLoggingStatus(client, interaction.guildId);

  const auditEnabled = Boolean(loggingStatus.enabled);
  const channels = loggingStatus.channels || {};

  const auditChannel = await formatChannelMention(interaction.guild, channels.audit, tr);
  const applicationsChannel = await formatChannelMention(interaction.guild, channels.applications, tr);
  const reportsChannel = await formatChannelMention(interaction.guild, channels.reports, tr);
  const lifecycleChannel = await formatChannelMention(interaction.guild, guildConfig.ticketLogsChannelId, tr);
  const transcriptChannel = await formatChannelMention(interaction.guild, guildConfig.ticketTranscriptChannelId, tr);

  const ignore = loggingStatus.ignore || { users: [], channels: [], roles: [] };
  const { enabled: enabledCount, total } = countEnabledCategories(loggingStatus.enabledEvents, auditEnabled);

  const embed = new EmbedBuilder()
    .setTitle(tr.t('logging.dashboard.title'))
    .setDescription(tr.t('logging.dashboard.description', { server: interaction.guild.name }))
    .setColor(auditEnabled ? getColor('success') : getColor('warning'))
    .addFields(
      {
        name: tr.t('logging.dashboard.fieldLogging'),
        value: auditEnabled ? tr.t('logging.dashboard.on') : tr.t('logging.dashboard.off'),
        inline: true,
      },
      {
        name: tr.t('logging.dashboard.fieldCategories'),
        value: auditEnabled ? tr.t('logging.dashboard.categoriesOn', { enabled: enabledCount, total }) : tr.t('logging.dashboard.loggingOff'),
        inline: true,
      },
      {
        name: tr.t('logging.dashboard.fieldFilters'),
        value: tr.t('logging.dashboard.filterCounts', { users: ignore.users?.length || 0, channels: ignore.channels?.length || 0, roles: ignore.roles?.length || 0 }),
        inline: true,
      },
      {
        name: tr.t('logging.dashboard.fieldChannels'),
        value: [
          tr.t('logging.dashboard.lineAudit', { channel: auditChannel }),
          tr.t('logging.dashboard.lineApplications', { channel: applicationsChannel }),
          tr.t('logging.dashboard.lineReports', { channel: reportsChannel }),
        ].join('\n').slice(0, 1024),
        inline: false,
      },
      {
        name: tr.t('logging.dashboard.fieldTickets'),
        value: [
          tr.t('logging.dashboard.lineTicketLogs', { channel: lifecycleChannel }),
          tr.t('logging.dashboard.lineTranscripts', { channel: transcriptChannel }),
        ].join('\n').slice(0, 1024),
        inline: false,
      },
    )
    .setFooter({ text: tr.t('logging.dashboard.footer') })
    .setTimestamp();

  const components = createLoggingDashboardComponents(loggingStatus.enabledEvents, auditEnabled, { lang: tr.lang });
  return { embed, components };
}

export async function buildLoggingCategoriesView(interaction, client) {
  const tr = textForInteraction(interaction);
  const loggingStatus = await getLoggingStatus(client, interaction.guildId);
  const auditEnabled = Boolean(loggingStatus.enabled);

  const categoryLines = DASHBOARD_CATEGORIES.map((key) => {
    const on = getCategoryStatus(loggingStatus.enabledEvents, key, auditEnabled);
    const label = categoryLabel(key, { lang: tr.lang });
    return tr.t('logging.categories.line', { label, state: on ? tr.t('logging.dashboard.on') : tr.t('logging.dashboard.off') });
  }).join('\n').slice(0, 1024);

  const embed = new EmbedBuilder()
    .setTitle(tr.t('logging.categories.title'))
    .setDescription(
      auditEnabled
        ? tr.t('logging.categories.descriptionOn')
        : tr.t('logging.categories.descriptionOff'),
    )
    .setColor(getColor('info'))
    .addFields({ name: tr.t('logging.categories.field'), value: categoryLines, inline: false })
    .setFooter({ text: tr.t('logging.categories.footer') })
    .setTimestamp();

  const components = createLoggingCategoryViewComponents(loggingStatus.enabledEvents, auditEnabled, { lang: tr.lang });
  return { embed, components };
}

export async function buildLoggingFilterView(interaction, client) {
  const tr = textForInteraction(interaction);
  const loggingStatus = await getLoggingStatus(client, interaction.guildId);
  const ignore = loggingStatus.ignore || { users: [], channels: [] };

  const userLines = (ignore.users || []).length
    ? ignore.users.map((id) => tr.t('logging.filters.userLine', { id })).join('\n')
    : tr.t('logging.filters.none');

  const channelLines = (ignore.channels || []).length
    ? ignore.channels.map((id) => `• <#${id}> (\`${id}\`)`).join('\n')
    : tr.t('logging.filters.none');

  const roleLines = (ignore.roles || []).length
    ? ignore.roles.map((id) => `• <@&${id}> (\`${id}\`)`).join('\n')
    : tr.t('logging.filters.none');

  const embed = new EmbedBuilder()
    .setTitle(tr.t('logging.filters.title'))
    .setDescription(tr.t('logging.filters.description'))
    .setColor(getColor('info'))
    .addFields(
      { name: tr.t('logging.filters.fieldUsers'), value: userLines.slice(0, 1024), inline: false },
      { name: tr.t('logging.filters.fieldChannels'), value: channelLines.slice(0, 1024), inline: false },
      { name: tr.t('logging.filters.fieldRoles'), value: roleLines.slice(0, 1024), inline: false },
    )
    .setFooter({ text: tr.t('logging.filters.footer') })
    .setTimestamp();

  const components = createLoggingFilterComponents({ lang: tr.lang });
  return { embed, components };
}

export function isCategoriesView(interaction) {
  return titlesOf().categories.has(interaction.message?.embeds?.[0]?.title);
}

export function isFilterView(interaction) {
  return titlesOf().filters.has(interaction.message?.embeds?.[0]?.title);
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
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: textForInteraction(interaction).t('logging.dashboard.noAdmin') });
      }

      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      const { embed, components } = await buildLoggingDashboardView(interaction, client);
      await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components });
    } catch (error) {
      logger.error('logging_dashboard error:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: textForInteraction(interaction).t('logging.dashboard.failed') });
    }
  },
};
