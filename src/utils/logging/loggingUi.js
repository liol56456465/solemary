// loggingUi.js

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { EVENT_TYPES } from '../../services/loggingService.js';
import { botText } from '../botText.js';

// Every label takes { lang } (the /logging panel is ephemeral: the admin's Discord language); default English.

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


// English labels (kept for callers that want them); the panel uses categoryLabel() in its language.
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

/** One category's label in a language (literal keys, so the key test sees each one). */
export function categoryLabel(category, { lang = 'en' } = {}) {
  const tr = botText(lang);
  const labels = {
    moderation: () => tr.t('logging.category.moderation'),
    message: () => tr.t('logging.category.message'),
    role: () => tr.t('logging.category.role'),
    member: () => tr.t('logging.category.member'),
    leveling: () => tr.t('logging.category.leveling'),
    reactionrole: () => tr.t('logging.category.reactionrole'),
    giveaway: () => tr.t('logging.category.giveaway'),
    counter: () => tr.t('logging.category.counter'),
    application: () => tr.t('logging.category.application'),
    report: () => tr.t('logging.category.report'),
    channel: () => tr.t('logging.category.channel'),
    server: () => tr.t('logging.category.server'),
  };
  return labels[category] ? labels[category]() : category;
}

function createBackButton(tr) {
  return new ButtonBuilder()
    .setCustomId('log_dash_back')
    .setLabel(tr.t('logging.ui.back'))
    .setStyle(ButtonStyle.Secondary);
}

function createCategoryToggleButtons(enabledEvents = {}, loggingEnabled = false, lang = 'en') {
  const buttons = DASHBOARD_CATEGORIES.map((category) => {
    const wildcardDisabled = enabledEvents[`${category}.*`] === false;
    const categoryEvents = EVENT_TYPES_BY_CATEGORY[category] || [];
    const allEnabled = categoryEvents.length === 0
      ? true
      : categoryEvents.every((t) => enabledEvents[t] !== false);
    const isEnabled = loggingEnabled && !wildcardDisabled && allEnabled;
    const label = categoryLabel(category, { lang });

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

export function createLoggingMainMenuSelect({ lang = 'en' } = {}) {
  const tr = botText(lang);
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('log_dash_menu')
      .setPlaceholder(tr.t('logging.ui.menuPlaceholder'))
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(tr.t('logging.ui.setAudit'))
          .setDescription(tr.t('logging.ui.setAuditHint'))
          .setValue('set:audit'),
        new StringSelectMenuOptionBuilder()
          .setLabel(tr.t('logging.ui.setApplications'))
          .setDescription(tr.t('logging.ui.setApplicationsHint'))
          .setValue('set:applications'),
        new StringSelectMenuOptionBuilder()
          .setLabel(tr.t('logging.ui.setReports'))
          .setDescription(tr.t('logging.ui.setReportsHint'))
          .setValue('set:reports'),
        new StringSelectMenuOptionBuilder()
          .setLabel(tr.t('logging.ui.clearAudit'))
          .setValue('clear:audit'),
        new StringSelectMenuOptionBuilder()
          .setLabel(tr.t('logging.ui.clearApplications'))
          .setValue('clear:applications'),
        new StringSelectMenuOptionBuilder()
          .setLabel(tr.t('logging.ui.clearReports'))
          .setValue('clear:reports'),
        new StringSelectMenuOptionBuilder()
          .setLabel(tr.t('logging.ui.categories'))
          .setDescription(tr.t('logging.ui.categoriesHint'))
          .setValue('view:categories'),
        new StringSelectMenuOptionBuilder()
          .setLabel(tr.t('logging.ui.filters'))
          .setDescription(tr.t('logging.ui.filtersHint'))
          .setValue('view:filters'),
      ),
  );
}

export function createLoggingMainActionRow(loggingEnabled = false, { lang = 'en' } = {}) {
  const tr = botText(lang);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('log_dash_toggle:audit_enabled')
      .setLabel(tr.t('logging.ui.auditLogging'))
      .setStyle(loggingEnabled ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('log_dash_refresh')
      .setLabel(tr.t('logging.ui.refresh'))
      .setStyle(ButtonStyle.Primary),
  );
}

export function createLoggingDashboardComponents(_enabledEvents, loggingEnabled = false, { lang = 'en' } = {}) {
  return [
    createLoggingMainMenuSelect({ lang }),
    createLoggingMainActionRow(loggingEnabled, { lang }),
  ];
}

export function createLoggingCategoryViewComponents(enabledEvents, loggingEnabled = false, { lang = 'en' } = {}) {
  const tr = botText(lang);
  const categoryRows = createCategoryToggleButtons(enabledEvents, loggingEnabled, lang);

  const actionRow = new ActionRowBuilder().addComponents(
    createBackButton(tr),
    new ButtonBuilder()
      .setCustomId('log_dash_toggle:all')
      .setLabel(tr.t('logging.ui.toggleAll'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('log_dash_refresh')
      .setLabel(tr.t('logging.ui.refresh'))
      .setStyle(ButtonStyle.Primary),
  );

  return [...categoryRows, actionRow];
}

export function createLoggingFilterComponents({ lang = 'en' } = {}) {
  const tr = botText(lang);
  return [
    new ActionRowBuilder().addComponents(
      createBackButton(tr),
      new ButtonBuilder()
        .setCustomId('log_dash_add_filter:user')
        .setLabel(tr.t('logging.ui.ignoreUser'))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('log_dash_add_filter:channel')
        .setLabel(tr.t('logging.ui.ignoreChannel'))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('log_dash_add_filter:role')
        .setLabel(tr.t('logging.ui.ignoreRole'))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('log_dash_remove_filter')
        .setLabel(tr.t('logging.ui.removeOne'))
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

export { EVENT_TYPES_BY_CATEGORY };
