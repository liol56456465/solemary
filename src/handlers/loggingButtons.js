import {
  PermissionFlagsBits,
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import {
  toggleEventLogging,
  getLoggingStatus,
  EVENT_TYPES,
  setLoggingEnabled,
  setLogChannel,
  updateIgnoreList,
  getIgnoreList,
} from '../services/loggingService.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { successEmbed } from '../utils/embeds.js';
import { replyUserError, ErrorTypes, handleInteractionError } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';
import { textForInteraction } from '../utils/botText.js';
import {
  buildLoggingDashboardView,
  buildLoggingCategoriesView,
  buildLoggingFilterView,
  isCategoriesView,
  isFilterView,
  refreshDashboardMessage,
} from '../commands/Logging/modules/logging_dashboard.js';

const LOGGING_CATEGORIES = [...new Set(Object.values(EVENT_TYPES).map((eventType) => eventType.split('.')[0]))];

// awaitModalSubmit rejects with InteractionCollectorError when the user closes the
// modal or never submits it; that is not an error worth reporting.
function isModalTimeout(error) {
  return error?.code === 'InteractionCollectorError' || error?.code === 'INTERACTION_TIMEOUT';
}

// Refresh the (ephemeral) dashboard through the modal submission, then confirm.
async function confirmAndRefresh(interaction, modalSubmission, successPayload, shouldRefresh = true) {
  const updated = shouldRefresh
    ? await refreshDashboardMessage(interaction, interaction.client, modalSubmission).catch((error) => {
      logger.warn('Could not refresh logging dashboard', { error: error.message });
      return false;
    })
    : false;

  if (updated || modalSubmission.replied || modalSubmission.deferred) {
    await modalSubmission.followUp(successPayload);
  } else {
    await modalSubmission.reply(successPayload);
  }
}

// Every reply and modal here is ephemeral / private: the clicker's Discord language.
// Per destination: [label, modal label/title, modal description] (literal keys).
function destinationTexts(tr, destination) {
  const texts = {
    audit: () => [tr.t('logging.panel.destination.audit'), tr.t('logging.panel.channelModal.audit'), tr.t('logging.panel.channelModalHint.audit')],
    applications: () => [tr.t('logging.panel.destination.applications'), tr.t('logging.panel.channelModal.applications'), tr.t('logging.panel.channelModalHint.applications')],
    reports: () => [tr.t('logging.panel.destination.reports'), tr.t('logging.panel.channelModal.reports'), tr.t('logging.panel.channelModalHint.reports')],
  };
  if (texts[destination]) return texts[destination]();
  return [destination, `${destination} channel`, `Channel where ${String(destination).toLowerCase()} logs will be sent`];
}

export default {
  customIds: [
    'log_dash_toggle',
    'log_dash_refresh',
    'log_dash_back',
    'log_dash_add_filter',
    'log_dash_remove_filter',
  ],

  async execute(interaction) {
    try {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: textForInteraction(interaction).t('logging.panel.needManageServer'),
          ephemeral: true,
        });
      }

      if (interaction.customId === 'log_dash_refresh') {
        return handleRefresh(interaction);
      }

      if (interaction.customId === 'log_dash_back') {
        return handleBackToMain(interaction);
      }

      if (interaction.customId === 'log_dash_remove_filter') {
        return handleRemoveFilterModal(interaction);
      }

      if (interaction.customId.startsWith('log_dash_add_filter:')) {
        return handleAddFilterModal(interaction);
      }

      if (interaction.customId.startsWith('log_dash_toggle')) {
        return handleToggle(interaction);
      }
    } catch (error) {
      await handleInteractionError(interaction, error, {
        type: 'button',
        customId: interaction.customId,
        handler: 'logging',
      });
    }
  },
};

async function handleRefresh(interaction) {
  // Acknowledge first: the view reads the config and may fetch the log channels.
  await interaction.deferUpdate();
  if (isCategoriesView(interaction)) {
    const { embed, components } = await buildLoggingCategoriesView(interaction, interaction.client);
    return interaction.editReply({ embeds: [embed], components, content: null });
  }

  if (isFilterView(interaction)) {
    const { embed, components } = await buildLoggingFilterView(interaction, interaction.client);
    return interaction.editReply({ embeds: [embed], components, content: null });
  }

  const { embed, components } = await buildLoggingDashboardView(interaction, interaction.client);
  await interaction.editReply({ embeds: [embed], components, content: null });
}

async function handleBackToMain(interaction) {
  await interaction.deferUpdate();
  const { embed, components } = await buildLoggingDashboardView(interaction, interaction.client);
  await interaction.editReply({ embeds: [embed], components, content: null });
}

async function handleToggle(interaction) {
  const eventType = interaction.customId.replace('log_dash_toggle:', '');
  if (!eventType) {
    return interaction.reply({ content: textForInteraction(interaction).t('logging.panel.unknownEvent'), ephemeral: true });
  }

  // Acknowledge before the status read, the write and the view rebuild.
  await interaction.deferUpdate();

  const status = await getLoggingStatus(interaction.client, interaction.guildId);
  const onCategoriesView = isCategoriesView(interaction);

  if (eventType === 'audit_enabled') {
    await setLoggingEnabled(interaction.client, interaction.guildId, !Boolean(status.enabled));
  } else if (eventType === 'all') {
    const newState = !Object.values(status.enabledEvents).every((v) => v !== false);
    const allTypes = Object.values(EVENT_TYPES);
    const categoryTypes = LOGGING_CATEGORIES.map((c) => `${c}.*`);
    await toggleEventLogging(interaction.client, interaction.guildId, [...allTypes, ...categoryTypes], newState);
  } else {
    const currentState = status.enabledEvents[eventType] !== false;
    await toggleEventLogging(interaction.client, interaction.guildId, eventType, !currentState);
  }

  if (onCategoriesView || (eventType !== 'audit_enabled' && eventType.includes('.*'))) {
    const { embed, components } = await buildLoggingCategoriesView(interaction, interaction.client);
    return interaction.editReply({ embeds: [embed], components, content: null });
  }

  const { embed, components } = await buildLoggingDashboardView(interaction, interaction.client);
  await interaction.editReply({ embeds: [embed], components, content: null });
}

async function handleAddFilterModal(interaction) {
  const tr = textForInteraction(interaction);
  const filterType = interaction.customId.replace('log_dash_add_filter:', '');
  if (!['user', 'channel', 'role'].includes(filterType)) {
    return interaction.reply({ content: tr.t('logging.panel.unknownFilter'), ephemeral: true });
  }

  const modalCustomId = `log_dash_filter_modal:add:${filterType}`;

  let modal;
  if (filterType === 'user') {
    const userSelect = new UserSelectMenuBuilder()
      .setCustomId('ignore_user')
      .setPlaceholder(tr.t('logging.panel.addUser.placeholder'))
      .setMinValues(1)
      .setMaxValues(1);

    const userLabel = new LabelBuilder()
      .setLabel(tr.t('logging.panel.addUser.label'))
      .setDescription(tr.t('logging.panel.addUser.hint'))
      .setUserSelectMenuComponent(userSelect);

    modal = new ModalBuilder()
      .setCustomId(modalCustomId)
      .setTitle(tr.t('logging.panel.addUser.title'))
      .addLabelComponents(userLabel);
  } else if (filterType === 'role') {
    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId('ignore_role')
      .setPlaceholder(tr.t('logging.panel.addRole.placeholder'))
      .setMinValues(1)
      .setMaxValues(1);

    const roleLabel = new LabelBuilder()
      .setLabel(tr.t('logging.panel.addRole.label'))
      .setDescription(tr.t('logging.panel.addRole.hint'))
      .setRoleSelectMenuComponent(roleSelect);

    modal = new ModalBuilder()
      .setCustomId(modalCustomId)
      .setTitle(tr.t('logging.panel.addRole.title'))
      .addLabelComponents(roleLabel);
  } else {
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('ignore_channel')
      .setPlaceholder(tr.t('logging.panel.addChannel.placeholder'))
      .setMinValues(1)
      .setMaxValues(1)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildCategory);

    const channelLabel = new LabelBuilder()
      .setLabel(tr.t('logging.panel.addChannel.label'))
      .setDescription(tr.t('logging.panel.addChannel.hint'))
      .setChannelSelectMenuComponent(channelSelect);

    modal = new ModalBuilder()
      .setCustomId(modalCustomId)
      .setTitle(tr.t('logging.panel.addChannel.title'))
      .addLabelComponents(channelLabel);
  }

  await interaction.showModal(modal);

  try {
    const modalSubmission = await interaction.awaitModalSubmit({
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === interaction.user.id && i.customId === modalCustomId,
    });

    let id;
    if (filterType === 'user') {
      id = modalSubmission.fields.getField('ignore_user')?.values?.[0];
    } else if (filterType === 'role') {
      id = modalSubmission.fields.getField('ignore_role')?.values?.[0];
    } else {
      id = modalSubmission.fields.getField('ignore_channel')?.values?.[0];
    }

    if (!id) {
      const pick = { user: () => tr.t('logging.panel.addUser.missing'), channel: () => tr.t('logging.panel.addChannel.missing'), role: () => tr.t('logging.panel.addRole.missing') };
      return replyUserError(modalSubmission, {
        type: ErrorTypes.VALIDATION,
        message: pick[filterType](),
      });
    }

    if (!(await updateIgnoreList(interaction.client, interaction.guildId, { action: 'add', type: filterType, id }))) {
      return replyUserError(modalSubmission, { type: ErrorTypes.DATABASE, message: tr.t('logging.panel.saveFilterFailed') });
    }

    await confirmAndRefresh(interaction, modalSubmission, {
      embeds: [successEmbed(tr.t('logging.panel.filterAddedTitle'), {
        user: () => tr.t('logging.panel.addUser.added', { id }),
        channel: () => tr.t('logging.panel.addChannel.added', { id }),
        role: () => tr.t('logging.panel.addRole.added', { id }),
      }[filterType]())],
      flags: MessageFlags.Ephemeral,
    }, isFilterView(interaction));
  } catch (error) {
    if (isModalTimeout(error)) {
      return;
    }
    logger.error('Error in add filter modal:', error);
  }
}

async function handleRemoveFilterModal(interaction) {
  const tr = textForInteraction(interaction);
  const config = await getGuildConfig(interaction.client, interaction.guildId);
  const ignore = getIgnoreList(config);
  const options = [];

  for (const userId of ignore.users || []) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(tr.t('logging.panel.remove.userLabel', { id: userId }))
        .setDescription(tr.t('logging.panel.remove.userHint'))
        .setValue(`user:${userId}`),
    );
  }

  for (const channelId of ignore.channels || []) {
    const channel = interaction.guild?.channels.cache.get(channelId);
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(channel ? `#${channel.name}`.slice(0, 100) : tr.t('logging.panel.remove.channelLabel', { id: channelId }))
        .setDescription(tr.t('logging.panel.remove.channelHint'))
        .setValue(`channel:${channelId}`),
    );
  }

  for (const roleId of ignore.roles || []) {
    const role = interaction.guild?.roles.cache.get(roleId);
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(role ? `@${role.name}`.slice(0, 100) : tr.t('logging.panel.remove.roleLabel', { id: roleId }))
        .setDescription(tr.t('logging.panel.remove.roleHint'))
        .setValue(`role:${roleId}`),
    );
  }

  if (options.length === 0) {
    return replyUserError(interaction, {
      type: ErrorTypes.USER_INPUT,
      message: tr.t('logging.panel.remove.none'),
    });
  }

  const modalCustomId = 'log_dash_filter_modal:remove';

  const filterSelect = new StringSelectMenuBuilder()
    .setCustomId('filter_entry')
    .setPlaceholder(tr.t('logging.panel.remove.placeholder'))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options.slice(0, 25));

  const filterLabel = new LabelBuilder()
    .setLabel(tr.t('logging.panel.remove.label'))
    .setDescription(tr.t('logging.panel.remove.hint'))
    .setStringSelectMenuComponent(filterSelect);

  const modal = new ModalBuilder()
    .setCustomId(modalCustomId)
    .setTitle(tr.t('logging.panel.remove.title'))
    .addLabelComponents(filterLabel);

  await interaction.showModal(modal);

  try {
    const modalSubmission = await interaction.awaitModalSubmit({
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === interaction.user.id && i.customId === modalCustomId,
    });

    const entry = modalSubmission.fields.getField('filter_entry')?.values?.[0];
    if (!entry) {
      return replyUserError(modalSubmission, {
        type: ErrorTypes.VALIDATION,
        message: tr.t('logging.panel.remove.missing'),
      });
    }

    const [type, id] = entry.split(':');
    if (!(await updateIgnoreList(interaction.client, interaction.guildId, { action: 'remove', type, id }))) {
      return replyUserError(modalSubmission, { type: ErrorTypes.DATABASE, message: tr.t('logging.panel.remove.failed') });
    }

    await confirmAndRefresh(interaction, modalSubmission, {
      embeds: [successEmbed(tr.t('logging.panel.remove.doneTitle'), ({
        user: () => tr.t('logging.panel.remove.doneUser', { id }),
        channel: () => tr.t('logging.panel.remove.doneChannel', { id }),
        role: () => tr.t('logging.panel.remove.doneRole', { id }),
      }[type] ?? (() => `Removed ${type} \`${id}\` from the ignore list.`))())],
      flags: MessageFlags.Ephemeral,
    }, isFilterView(interaction));
  } catch (error) {
    if (isModalTimeout(error)) {
      return;
    }
    logger.error('Error in remove filter modal:', error);
  }
}

async function showChannelModal(interaction, destination) {
  const tr = textForInteraction(interaction);
  const [label, modalLabel, modalHint] = destinationTexts(tr, destination);
  const modalCustomId = `log_dash_channel_modal:${destination}`;

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('log_channel')
    .setPlaceholder(tr.t('logging.panel.pickTextChannel'))
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setRequired(true);

  const channelLabel = new LabelBuilder()
    .setLabel(modalLabel)
    .setDescription(modalHint)
    .setChannelSelectMenuComponent(channelSelect);

  const modal = new ModalBuilder()
    .setCustomId(modalCustomId)
    .setTitle(modalLabel)
    .addLabelComponents(channelLabel);

  await interaction.showModal(modal);

  try {
    const modalSubmission = await interaction.awaitModalSubmit({
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === interaction.user.id && i.customId === modalCustomId,
    });

    const channelId = modalSubmission.fields.getField('log_channel').values[0];
    const channel = interaction.guild.channels.cache.get(channelId)
      ?? await interaction.guild.channels.fetch(channelId).catch(() => null);

    if (!channel) {
      return modalSubmission.reply({
        content: tr.t('logging.panel.channelNotFound'),
        flags: MessageFlags.Ephemeral,
      });
    }

    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      return modalSubmission.reply({
        content: tr.t('logging.panel.channelNeedsPerms'),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!(await setLogChannel(interaction.client, interaction.guildId, destination, channel.id))) {
      return replyUserError(modalSubmission, { type: ErrorTypes.DATABASE, message: tr.t('logging.channel.saveFailed') });
    }

    await confirmAndRefresh(interaction, modalSubmission, {
      embeds: [successEmbed(tr.t('logging.panel.channelUpdatedTitle'), tr.t('logging.panel.channelUpdated', { label, channel: String(channel) }))],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (isModalTimeout(error)) {
      return;
    }
    await handleInteractionError(interaction, error, {
      type: 'modal',
      customId: interaction.customId,
      handler: 'logging_channel',
    });
  }
}

export async function handleLoggingMenuSelect(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      content: textForInteraction(interaction).t('logging.panel.needManageServer'),
      ephemeral: true,
    });
  }

  const value = interaction.values[0];

  if (value.startsWith('set:')) {
    const destination = value.replace('set:', '');
    return showChannelModal(interaction, destination);
  }

  // Everything below edits the panel after database work: acknowledge first.
  await interaction.deferUpdate();

  if (value.startsWith('clear:')) {
    const destination = value.replace('clear:', '');
    await setLogChannel(interaction.client, interaction.guildId, destination, null);
    const { embed, components } = await buildLoggingDashboardView(interaction, interaction.client);
    return interaction.editReply({
      embeds: [embed],
      components,
      content: null,
    });
  }

  if (value === 'view:categories') {
    const { embed, components } = await buildLoggingCategoriesView(interaction, interaction.client);
    return interaction.editReply({ embeds: [embed], components, content: null });
  }

  if (value === 'view:filters') {
    const { embed, components } = await buildLoggingFilterView(interaction, interaction.client);
    return interaction.editReply({ embeds: [embed], components, content: null });
  }

  return interaction.followUp({ content: textForInteraction(interaction).t('logging.panel.unknownOption'), flags: MessageFlags.Ephemeral });
}
