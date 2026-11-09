import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import {
  getCommandAccessSnapshot,
  disableCategory,
  enableCategory,
  disableCommand,
  enableCommand,
  resetCategoryCommands,
} from '../../../services/commandAccessService.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { botText } from '../../../utils/botText.js';
import { replyText } from '../../../utils/commandLocalizations.js';

export const DASHBOARD_CATEGORY_SELECT = 'cmdaccess_category';
export const DASHBOARD_COMMAND_SELECT = 'cmdaccess_command';
export const DASHBOARD_TOGGLE_CATEGORY = 'cmdaccess_toggle_category';
export const DASHBOARD_ENABLE_ALL = 'cmdaccess_enable_all';
export const DASHBOARD_DISABLE_ALL = 'cmdaccess_disable_all';
export const DASHBOARD_RESET_COMMANDS = 'cmdaccess_reset_commands';
export const DASHBOARD_REFRESH = 'cmdaccess_refresh';
export const DASHBOARD_HOME = 'cmdaccess_home';

// The panel is ephemeral: every text is in the viewer's language (`tr`, default English).
const STATUS = {
  enabled: 'core.commands.dashboard.status.on',
  partial: 'core.commands.dashboard.status.partial',
  disabled: 'core.commands.dashboard.status.off',
};

function customId(base, guildId, suffix = '') {
  return suffix ? `${base}:${guildId}:${suffix}` : `${base}:${guildId}`;
}

function getCategoryStatus(category, tr) {
  if (category.categoryDisabled) {
    return tr.t(STATUS.disabled);
  }
  if (category.disabledCount === 0) {
    return tr.t(STATUS.enabled);
  }
  return tr.t(STATUS.partial);
}

function formatCommandLabel(command) {
  if (command.isSubcommand) {
    return `\`${command.name.replace(/ /g, ' ')}\``;
  }
  return `\`${command.name}\``;
}

function chunkLines(lines, maxLength = 980) {
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function buildOverviewEmbed(snapshot, guild, tr = botText('en')) {
  const fullyEnabled = snapshot.categories.filter((c) => !c.categoryDisabled && c.disabledCount === 0).length;
  const partial = snapshot.categories.filter((c) => !c.categoryDisabled && c.disabledCount > 0).length;
  const disabled = snapshot.categories.filter((c) => c.categoryDisabled).length;

  const categoryLines = snapshot.categories.map((category) => {
    const status = getCategoryStatus(category, tr);
    return `**${category.displayName}**: ${status} (${category.enabledCount}/${category.totalCount})`;
  });

  const fields = [
    {
      name: tr.t('core.commands.dashboard.summary'),
      value: [
        tr.t('core.commands.dashboard.summaryCommands', { on: snapshot.enabledTotal, total: snapshot.totalCommands }),
        tr.t('core.commands.dashboard.summaryCategories', { full: fullyEnabled, partial, off: disabled }),
      ].join('\n'),
      inline: false,
    },
  ];

  const chunks = chunkLines(categoryLines);
  chunks.forEach((chunk, index) => {
    fields.push({
      name: index === 0 ? tr.t('core.commands.dashboard.categories') : tr.t('core.commands.dashboard.categoriesCont'),
      value: chunk,
      inline: false,
    });
  });

  fields.push({
    name: tr.t('core.commands.dashboard.howTo'),
    value: tr.t('core.commands.dashboard.howToOverview'),
  });

  return createEmbed({
    title: tr.t('core.commands.dashboard.title'),
    description: tr.t('core.commands.dashboard.description', { server: guild.name }),
    color: 'info',
    fields,
    footer: tr.t('core.commands.dashboard.footer'),
  });
}

export function buildCategoryEmbed(category, guild, tr = botText('en')) {
  const statusText = category.categoryDisabled
    ? tr.t('core.commands.dashboard.categoryOff')
    : category.disabledCount === 0
      ? tr.t('core.commands.dashboard.everythingOn')
      : tr.t('core.commands.dashboard.someOff', { off: category.disabledCount, total: category.totalCount });

  const commandLines = category.commands.map((command) => {
    const enabled = category.enabledCommands.includes(command.name);
    const state = tr.t(command.protected ? 'core.commands.dashboard.status.always' : enabled ? STATUS.enabled : STATUS.disabled);
    return `${formatCommandLabel(command)}: ${state}`;
  });

  const fields = [
    {
      name: tr.t('core.commands.dashboard.statusField'),
      value: statusText,
      inline: true,
    },
    {
      name: tr.t('core.commands.dashboard.countField'),
      value: tr.t('core.commands.dashboard.countValue', { on: category.enabledCount, total: category.totalCount }),
      inline: true,
    },
  ];

  const chunks = chunkLines(commandLines);
  chunks.forEach((chunk, index) => {
    fields.push({
      name: index === 0 ? tr.t('core.commands.dashboard.commands') : tr.t('core.commands.dashboard.commandsCont'),
      value: chunk,
      inline: false,
    });
  });

  fields.push({
    name: tr.t('core.commands.dashboard.howTo'),
    value: tr.t('core.commands.dashboard.howToCategory'),
  });

  return createEmbed({
    title: category.displayName,
    description: tr.t('core.commands.dashboard.categoryDescription', { server: guild.name }),
    color: category.categoryDisabled ? 'error' : category.disabledCount > 0 ? 'warning' : 'success',
    fields,
    footer: tr.t('core.commands.dashboard.categoryFooter'),
  });
}

export function buildOverviewComponents(guildId, snapshot, tr = botText('en')) {
  const categoryOptions = snapshot.categories.slice(0, 25).map((category) => {
    const status = getCategoryStatus(category, tr);
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${category.displayName}`.slice(0, 100))
      .setDescription(`${status} · ${category.enabledCount}/${category.totalCount}`.slice(0, 100))
      .setValue(category.key);
  });

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId(DASHBOARD_CATEGORY_SELECT, guildId))
        .setPlaceholder(tr.t('core.commands.dashboard.pickCategory'))
        .addOptions(categoryOptions),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_REFRESH, guildId))
        .setLabel(tr.t('core.commands.dashboard.refresh'))
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildCategoryComponents(guildId, category, tr = botText('en')) {
  const toggleableCommands = category.commands.filter((command) => !command.protected);
  const commandOptions = toggleableCommands.slice(0, 25).map((command) => {
    const enabled = category.enabledCommands.includes(command.name);
    const label = command.isSubcommand
      ? command.name.replace(' ', ' · ').slice(0, 100)
      : command.name.slice(0, 100);

    return new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setDescription(tr.t(enabled ? 'core.commands.dashboard.pickToOff' : 'core.commands.dashboard.pickToOn').slice(0, 100))
      .setValue(command.name);
  });

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_HOME, guildId))
        .setLabel(tr.t('core.commands.dashboard.back'))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_TOGGLE_CATEGORY, guildId, category.key))
        .setLabel(tr.t(category.categoryDisabled ? 'core.commands.dashboard.turnCategoryOn' : 'core.commands.dashboard.turnCategoryOff'))
        .setStyle(category.categoryDisabled ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_ENABLE_ALL, guildId, category.key))
        .setLabel(tr.t('core.commands.dashboard.enableAll'))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_DISABLE_ALL, guildId, category.key))
        .setLabel(tr.t('core.commands.dashboard.disableAll'))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(customId(DASHBOARD_RESET_COMMANDS, guildId, category.key))
        .setLabel(tr.t('core.commands.dashboard.clearOverrides'))
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  if (commandOptions.length > 0) {
    rows.unshift(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId(DASHBOARD_COMMAND_SELECT, guildId, category.key))
          .setPlaceholder(tr.t('core.commands.dashboard.pickCommand'))
          .addOptions(commandOptions),
      ),
    );
  }

  return rows;
}

export async function buildDashboardView(client, guildId, guild, view = 'overview', categoryKey = null, tr = botText('en')) {
  const config = await getGuildConfig(client, guildId);
  const snapshot = getCommandAccessSnapshot(client, config);

  if (view === 'category' && categoryKey) {
    const category = snapshot.categories.find((entry) => entry.key === categoryKey);
    if (!category) {
      return {
        embed: buildOverviewEmbed(snapshot, guild, tr),
        components: buildOverviewComponents(guildId, snapshot, tr),
      };
    }

    return {
      embed: buildCategoryEmbed(category, guild, tr),
      components: buildCategoryComponents(guildId, category, tr),
      categoryKey,
    };
  }

  return {
    embed: buildOverviewEmbed(snapshot, guild, tr),
    components: buildOverviewComponents(guildId, snapshot, tr),
  };
}

export async function handleDashboardComponent(interaction, client) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const guildId = parts[1];
  const suffix = parts[2] || null;
  const tr = replyText(interaction);

  if (guildId !== interaction.guildId) {
    return interaction.reply({
      content: tr.t('core.commands.dashboard.otherServer'),
      ephemeral: true,
    });
  }

  if (action === DASHBOARD_COMMAND_SELECT) {
    const categoryKey = suffix;
    const commandName = interaction.values[0];
    const config = await getGuildConfig(client, guildId);
    const snapshot = getCommandAccessSnapshot(client, config);
    const category = snapshot.categories.find((entry) => entry.key === categoryKey);
    const enabled = category?.enabledCommands.includes(commandName);

    if (enabled) {
      await disableCommand(client, guildId, commandName);
    } else {
      await enableCommand(client, guildId, commandName);
    }

    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', categoryKey, tr);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_CATEGORY_SELECT) {
    const categoryKey = interaction.values[0];
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', categoryKey, tr);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  await interaction.deferUpdate();

  if (action === DASHBOARD_REFRESH || action === DASHBOARD_HOME) {
    const view = await buildDashboardView(client, guildId, interaction.guild, 'overview', null, tr);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_TOGGLE_CATEGORY) {
    const categoryKey = suffix;
    const config = await getGuildConfig(client, guildId);
    const snapshot = getCommandAccessSnapshot(client, config);
    const category = snapshot.categories.find((entry) => entry.key === categoryKey);

    if (category?.categoryDisabled) {
      await enableCategory(client, guildId, categoryKey);
    } else {
      await disableCategory(client, guildId, categoryKey);
    }

    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', categoryKey, tr);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_ENABLE_ALL) {
    await enableCategory(client, guildId, suffix);
    await resetCategoryCommands(client, guildId, suffix);
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', suffix, tr);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_DISABLE_ALL) {
    await disableCategory(client, guildId, suffix);
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', suffix, tr);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  if (action === DASHBOARD_RESET_COMMANDS) {
    await enableCategory(client, guildId, suffix);
    await resetCategoryCommands(client, guildId, suffix);
    const view = await buildDashboardView(client, guildId, interaction.guild, 'category', suffix, tr);
    return interaction.editReply({ embeds: [view.embed], components: view.components });
  }

  return interaction.editReply({ content: tr.t('core.commands.dashboard.unknownAction'), embeds: [], components: [] });
}

export function isCommandAccessCustomId(customIdValue) {
  return customIdValue.startsWith('cmdaccess_');
}

export function createDashboardCollectorFilter(userId, guildId) {
  return (componentInteraction) =>
    componentInteraction.user.id === userId &&
    componentInteraction.customId.includes(`:${guildId}`);
}
