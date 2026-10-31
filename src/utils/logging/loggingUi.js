// loggingUi.js

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { EVENT_TYPES } from '../../services/loggingService.js';

const EVENT_TYPES_BY_CATEGORY = Object.values(EVENT_TYPES).reduce((accumulator, eventType) => {
  const [category] = eventType.split('.');
  if (!accumulator[category]) {
    accumulator[category] = [];
  }
  accumulator[category].push(eventType);
  return accumulator;
}, {});

export const DASHBOARD_CATEGORIES = [
  'moderation',
  'message',
  'role',
  'member',
  'leveling',
  'reactionrole',
  'giveaway',
  'counter',
  'application',
  'report',
  'channel',
  'server',
];


export const DASHBOARD_CATEGORY_LABELS = {
  moderation: 'Moderation',
  message: 'Messages',
  role: 'Roles',
  member: 'Members',
  leveling: 'Leveling',
  reactionrole: 'Reaction roles',
  giveaway: 'Giveaways',
  counter: 'Counters',
  application: 'Applications',
  report: 'Reports',
  channel: 'Channels and threads',
  server: 'Emoji, events, webhooks, invites, AutoMod',
};

function createBackButton() {
  return new ButtonBuilder()
    .setCustomId('log_dash_back')
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);
}

function createCategoryToggleButtons(enabledEvents = {}, loggingEnabled = false) {
  const buttons = DASHBOARD_CATEGORIES.map((category) => {
    const wildcardDisabled = enabledEvents[`${category}.*`] === false;
    const categoryEvents = EVENT_TYPES_BY_CATEGORY[category] || [];
    const allEnabled = categoryEvents.length === 0
      ? true
      : categoryEvents.every((t) => enabledEvents[t] !== false);
    const isEnabled = loggingEnabled && !wildcardDisabled && allEnabled;
    const label = DASHBOARD_CATEGORY_LABELS[category] || category;

    return new ButtonBuilder()
      .setCustomId(`log_dash_toggle:${category}.*`)
      .setLabel(label)
      .setStyle(isEnabled ? ButtonStyle.Success : ButtonStyle.Danger);
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

export function createLoggingMainMenuSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('log_dash_menu')
      .setPlaceholder('Pick a setting to change')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Set audit log channel')
          .setDescription('Moderation, messages, members, roles, etc.')
          .setValue('set:audit'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Set applications channel')
          .setDescription('New applications and review updates')
          .setValue('set:applications'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Set reports channel')
          .setDescription('Reports sent with /report')
          .setValue('set:reports'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Clear audit channel')
          .setValue('clear:audit'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Clear applications channel')
          .setValue('clear:applications'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Clear reports channel')
          .setValue('clear:reports'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Event categories')
          .setDescription('Pick which kinds of logs are sent')
          .setValue('view:categories'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Ignore filters')
          .setDescription('Skip logs from specific users, channels or roles')
          .setValue('view:filters'),
      ),
  );
}

export function createLoggingMainActionRow(loggingEnabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('log_dash_toggle:audit_enabled')
      .setLabel('Audit logging')
      .setStyle(loggingEnabled ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('log_dash_refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
  );
}

export function createLoggingDashboardComponents(_enabledEvents, loggingEnabled = false) {
  return [
    createLoggingMainMenuSelect(),
    createLoggingMainActionRow(loggingEnabled),
  ];
}

export function createLoggingCategoryViewComponents(enabledEvents, loggingEnabled = false) {
  const categoryRows = createCategoryToggleButtons(enabledEvents, loggingEnabled);

  const actionRow = new ActionRowBuilder().addComponents(
    createBackButton(),
    new ButtonBuilder()
      .setCustomId('log_dash_toggle:all')
      .setLabel('Toggle all categories')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('log_dash_refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
  );

  return [...categoryRows, actionRow];
}

export function createLoggingFilterComponents() {
  return [
    new ActionRowBuilder().addComponents(
      createBackButton(),
      new ButtonBuilder()
        .setCustomId('log_dash_add_filter:user')
        .setLabel('Ignore a user')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('log_dash_add_filter:channel')
        .setLabel('Ignore a channel')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('log_dash_add_filter:role')
        .setLabel('Ignore a role')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('log_dash_remove_filter')
        .setLabel('Remove one')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

export { EVENT_TYPES_BY_CATEGORY };
