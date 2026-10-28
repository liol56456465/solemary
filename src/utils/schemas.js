// schemas.js

import { z } from 'zod';
import { createError, ErrorTypes } from './errorHandler.js';
import { isValidTimeZone } from './timezone.js';

export const LogIgnoreSchema = z
  .object({
    users: z.array(z.string()).default([]),
    channels: z.array(z.string()).default([]),
    roles: z.array(z.string()).default([])
  })
  .default({ users: [], channels: [], roles: [] });

export const LoggingChannelsSchema = z
  .object({
    audit: z.string().nullable().optional(),
    applications: z.string().nullable().optional(),
    reports: z.string().nullable().optional(),
  })
  .default({ audit: null, applications: null, reports: null });

export const LoggingConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    channels: LoggingChannelsSchema.optional(),
    ignore: LogIgnoreSchema.optional(),
    enabledEvents: z.record(z.string(), z.boolean()).default({}),
    // legacy flat fields — accepted on parse, stripped on normalize
    channelId: z.string().nullable().optional(),
  })
  .default({ enabled: false, enabledEvents: {} });

const TicketLoggingSchema = z
  .object({
    lifecycleChannelId: z.string().nullable().optional(),
    transcriptChannelId: z.string().nullable().optional()
  })
  .optional();

const AutoVerifyConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    criteria: z.enum(['account_age', 'server_size', 'none']).default('none'),
    accountAgeDays: z.number().int().min(1).max(365).nullable().optional(),
    roleId: z.string().nullable().optional()
  })
  .optional();

const VerificationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    channelId: z.string().nullable().optional(),
    messageId: z.string().nullable().optional(),
    roleId: z.string().optional(),
    message: z.string().optional(),
    buttonText: z.string().default('Verify'),
    autoVerify: AutoVerifyConfigSchema
  })
  .optional();

// Leveling settings (services/leveling/leveling.js). Lenient on purpose: every
// field optional and unknown keys kept, so stored configs always parse; tight
// bounds live in the leveling service.
const XpRangeSchema = z.looseObject({
    min: z.number().optional(),
    max: z.number().optional()
});

const LevelingConfigSchema = z.looseObject({
    configured: z.boolean().optional(),
    enabled: z.boolean().optional(),
    xpPerMessage: z.union([z.number(), XpRangeSchema]).nullable().optional(),
    xpRange: XpRangeSchema.nullable().optional(),
    xpCooldown: z.number().nullable().optional(),
    levelUpMessage: z.string().nullable().optional(),
    levelUpChannel: z.string().nullable().optional(),
    ignoredChannels: z.array(z.string()).nullable().optional(),
    ignoredRoles: z.array(z.string()).nullable().optional(),
    blacklistedUsers: z.array(z.string()).nullable().optional(),
    roleRewards: z.record(z.string(), z.string()).nullable().optional(),
    announceLevelUp: z.boolean().optional(),
    xpMultiplier: z.number().nullable().optional()
});

export const GuildConfigSchema = z
  .object({
    prefix: z.string().optional(),
    modRole: z.string().nullable().optional(),
    adminRole: z.string().nullable().optional(),
    logChannelId: z.string().nullable().optional(),
    welcomeChannel: z.string().nullable().optional(),
    welcomeMessage: z.string().optional(),
    autoRole: z.string().nullable().optional(),
    dmOnClose: z.boolean().optional(),
    reportChannelId: z.string().nullable().optional(),
    birthdayChannelId: z.string().nullable().optional(),
    // IANA zone whose local date decides whose birthday it is (default UTC).
    birthdayTimezone: z.string().refine(isValidTimeZone, 'Unknown IANA time zone').optional(),
    // Role given on the member's birthday (services/birthdayService.js); set from the web dashboard.
    birthdayRoleId: z.string().nullable().optional(),
    premiumRoleId: z.string().nullable().optional(),
    logIgnore: LogIgnoreSchema.optional(),
    disabledCommands: z.record(z.string(), z.boolean()).optional(),
    disabledCategories: z.record(z.string(), z.boolean()).optional(),
    logging: LoggingConfigSchema.optional(),
    ticketLogging: TicketLoggingSchema.optional(),
    enableLogging: z.boolean().optional(),
    verification: VerificationConfigSchema,
    // Ticket settings (services/ticketSettingsService.js); tight checks live there.
    ticketPanelChannelId: z.string().nullable().optional(),
    ticketPanelMessageId: z.string().nullable().optional(),
    ticketStaffRoleId: z.string().nullable().optional(),
    ticketCategoryId: z.string().nullable().optional(),
    ticketClosedCategoryId: z.string().nullable().optional(),
    ticketLogsChannelId: z.string().nullable().optional(),
    ticketTranscriptChannelId: z.string().nullable().optional(),
    ticketPanelMessage: z.string().nullable().optional(),
    ticketButtonLabel: z.string().nullable().optional(),
    maxTicketsPerUser: z.number().nullable().optional(),
    leveling: LevelingConfigSchema.nullable().optional()
  })
  .passthrough();

const DEFAULT_LOGGING = {
  enabled: false,
  channels: { audit: null, applications: null, reports: null },
  ignore: { users: [], channels: [], roles: [] },
  enabledEvents: {},
};

function migrateLoggingConfig(raw = {}, legacy = {}) {
  const base = typeof raw === 'object' && raw !== null ? raw : {};
  const {
    logChannelId,
    reportChannelId,
    enableLogging,
    logIgnore,
  } = legacy;

  const auditChannel =
    base.channels?.audit ??
    base.channelId ??
    logChannelId ??
    null;

  const applicationsChannel = base.channels?.applications ?? null;

  const reportsChannel =
    base.channels?.reports ??
    reportChannelId ??
    null;

  const ignore = {
    users: base.ignore?.users ?? logIgnore?.users ?? [],
    channels: base.ignore?.channels ?? logIgnore?.channels ?? [],
    roles: base.ignore?.roles ?? [],
  };

  let enabled = base.enabled ?? false;
  if (enableLogging === false) {
    enabled = false;
  } else if (auditChannel && base.enabled === undefined && enableLogging !== false) {
    enabled = base.enabled ?? Boolean(enableLogging);
  }

  const { channelId: _legacyChannelId, ignore: _ignore, channels: _channels, ...rest } = base;

  return {
    ...DEFAULT_LOGGING,
    ...rest,
    enabled,
    channels: {
      audit: auditChannel,
      applications: applicationsChannel,
      reports: reportsChannel,
    },
    ignore,
    enabledEvents: base.enabledEvents ?? {},
  };
}

export function stripLegacyLoggingFields(config) {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const {
    logChannelId: _logChannelId,
    enableLogging: _enableLogging,
    reportChannelId: _reportChannelId,
    logIgnore: _logIgnore,
    ...rest
  } = config;

  if (rest.logging && typeof rest.logging === 'object') {
    const { channelId: _channelId, ...loggingRest } = rest.logging;
    rest.logging = loggingRest;
  }

  return rest;
}

export function normalizeGuildConfig(raw, defaults = {}) {
  const base = typeof raw === 'object' && raw !== null ? raw : {};
  const merged = { ...defaults, ...base };

  merged.logging = migrateLoggingConfig(merged.logging, {
    logChannelId: merged.logChannelId,
    reportChannelId: merged.reportChannelId,
    enableLogging: merged.enableLogging,
    logIgnore: merged.logIgnore,
  });

  const parsed = GuildConfigSchema.safeParse(merged);
  const normalized = parsed.success ? parsed.data : { ...defaults, ...merged };

  normalized.logging = migrateLoggingConfig(normalized.logging, {
    logChannelId: normalized.logChannelId,
    reportChannelId: normalized.reportChannelId,
    enableLogging: normalized.enableLogging,
    logIgnore: normalized.logIgnore,
  });

  return stripLegacyLoggingFields(normalized);
}

export function validateGuildConfigOrThrow(rawConfig, context = {}) {
  const normalized = normalizeGuildConfig(rawConfig);
  const parsed = GuildConfigSchema.safeParse(normalized);

  if (parsed.success) {
    return stripLegacyLoggingFields({
      ...normalized,
      logging: migrateLoggingConfig(normalized.logging, {}),
    });
  }

  throw createError(
    'Invalid guild configuration payload',
    ErrorTypes.VALIDATION,
    'Configuration payload is invalid. Please review provided values and try again.',
    {
      ...context,
      errorCode: 'VALIDATION_FAILED',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code
      }))
    }
  );
}
