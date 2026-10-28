// enforcement.js — settings for /enforcements, appeals and the warn ladder.

import { logger } from '../utils/logger.js';
import { bindSettingGetters } from '../services/settings/guildSettings.js';

const SNOWFLAKE = /^\d{17,20}$/;

function readId(name) {
    const value = (process.env[name] || '').trim();
    return value || null;
}

export const enforcementConfig = {
    mainGuildId: readId('MAIN_GUILD_ID'),
    supportGuildId: readId('SUPPORT_GUILD_ID'),
    serverName: 'Meowist',
    mutedRoleName: 'Muted',

    // Warn ladder: at level 0 the third warn bans; at level ≥ 1 the first warn bans.
    warnsPerLevel: 3,
    ladderBans: {
        1: 7 * 24 * 60 * 60 * 1000,
        2: 30 * 24 * 60 * 60 * 1000,
        3: null,
    },
    ladderReason: 'Reached warning limit',
    // Level-3 ladder bans can be appealed for this many calendar months.
    level3AppealMonths: 6,

    panelTtlMs: 15 * 60 * 1000,
    panelMaxEntries: 500,
};

// Per-server settings: stored in guild_settings (services/settings/guildSettings.js,
// registry in services/settings/settingsRegistry.js) and read through getters, so every
// caller keeps using enforcementConfig.<key> synchronously. Env vars only seed them once
// (and are the fallback while the database is down at boot); the old hardcoded
// production defaults are in the registry and are never used in test mode.
//   adminRequestChannelId  ADMIN_REQUEST_CHANNEL_ID
//   supportServerInvite    SUPPORT_SERVER_INVITE
//   appealsCategoryId      MAIN_APPEALS_CATEGORY_ID (fallback main-server category for appeals
//                          and staff reports when /ticket has no category; APPEALS_CATEGORY_ID
//                          is ignored)
//   reportsCategoryId, modmailCategoryId  MAIN_REPORTS_CATEGORY_ID / MAIN_MODMAIL_CATEGORY_ID: their own
//                          categories (unset: the /ticket category, as before)
//   openChannelCap         OPEN_CHANNEL_CAP (20): open staff reports + modmail channels at most; appeals
//                          are never counted or refused (Discord allows 50 channels per category)
//   mutedRoleId            MUTED_ROLE_ID
//   bannedRoleId           BANNED_ROLE_ID (support server: members with an active main-server ban)
//   warnRoleIds            WARN_ROLE_IDS (roles for 1, 2 and 3+ active warnings)
//   modLogChannelId        MOD_LOG_CHANNEL_ID (every enforcement action and appeal decision)
//   evidenceChannelId      EVIDENCE_CHANNEL_ID (re-hosted evidence images; falls back to the mod log)
//   appealWindowMs, appealCooldownMs, rejoinInviteMaxAgeSeconds
//   massActionLimit/WindowMs/BlockMs  MASS_ACTION_LIMIT / _WINDOW_MINUTES / _BLOCK_MINUTES: a
//                          moderator who already banned/kicked this many members within the
//                          window is blocked from the panel; OWNER_IDS get a DM and are never blocked
//   massMuteLimit          MASS_MUTE_LIMIT: the same for mutes, with its own (higher) count in the same window
//   staleReportMs, staleAppealReminderMs  STALE_REPORT_DAYS / STALE_APPEAL_REMINDER_DAYS: report
//                          channels close after this long without a message; staff get one
//                          reminder in a quiet pending appeal (appeals never close automatically)
bindSettingGetters(enforcementConfig, [
    'adminRequestChannelId', 'supportServerInvite', 'appealsCategoryId', 'reportsCategoryId', 'modmailCategoryId',
    'openChannelCap', 'mutedRoleId', 'bannedRoleId',
    'warnRoleIds', 'modLogChannelId', 'evidenceChannelId',
    'appealWindowMs', 'appealCooldownMs', 'rejoinInviteMaxAgeSeconds',
    'massActionLimit', 'massMuteLimit', 'massActionWindowMs', 'massActionBlockMs',
    'staleReportMs', 'staleAppealReminderMs',
]);

/**
 * Prebuilt reasons for the panel. `severe` pre-checks "Unappealable" on bans.
 * `key` is stored with each case so reasons can be reworded later.
 */
export const ENFORCEMENT_REASONS = [
    { key: 'slurs', label: 'Swearing/slurs', severe: false },
    { key: 'spam', label: 'Spam', severe: false },
    { key: 'harassment', label: 'Harassment', severe: true },
    { key: 'nsfw', label: 'NSFW content', severe: true },
    { key: 'advertising', label: 'Advertising', severe: false },
    { key: 'raiding', label: 'Raiding', severe: true },
    { key: 'scamming', label: 'Scamming', severe: true },
    { key: 'staff_disrespect', label: 'Staff disrespect', severe: false },
];

export const CUSTOM_REASON_KEY = 'custom';

export function getReason(key) {
    return ENFORCEMENT_REASONS.find((reason) => reason.key === key) || null;
}

export function validateEnforcementConfig() {
    const errors = [];
    const required = {
        MAIN_GUILD_ID: enforcementConfig.mainGuildId,
        SUPPORT_GUILD_ID: enforcementConfig.supportGuildId,
    };

    for (const [name, value] of Object.entries(required)) {
        if (!value) {
            errors.push(`${name} is not set`);
        } else if (!SNOWFLAKE.test(value)) {
            errors.push(`${name} must be a Discord ID (17–20 digits), got "${value}"`);
        }
    }

    for (const name of ['ADMIN_REQUEST_CHANNEL_ID', 'MUTED_ROLE_ID', 'BANNED_ROLE_ID', 'MOD_LOG_CHANNEL_ID', 'MAIN_APPEALS_CATEGORY_ID']) {
        const value = readId(name);
        if (value && !SNOWFLAKE.test(value)) {
            errors.push(`${name} must be a Discord ID (17–20 digits), got "${value}"`);
        }
    }

    for (const id of enforcementConfig.warnRoleIds) {
        if (!SNOWFLAKE.test(id)) errors.push(`WARN_ROLE_IDS must be Discord IDs separated by commas, got "${id}"`);
    }

    if (!/^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(enforcementConfig.supportServerInvite)) {
        errors.push(`SUPPORT_SERVER_INVITE must be a discord.gg invite link, got "${enforcementConfig.supportServerInvite}"`);
    }

    if (enforcementConfig.mainGuildId && enforcementConfig.mainGuildId === enforcementConfig.supportGuildId) {
        errors.push('MAIN_GUILD_ID and SUPPORT_GUILD_ID must be different servers');
    }

    return errors;
}

const enforcementConfigErrors = validateEnforcementConfig();
if (enforcementConfigErrors.length > 0) {
    logger.error(
        'Enforcement configuration errors (see .env.example):\n' +
        enforcementConfigErrors.map((error) => `  - ${error}`).join('\n')
    );
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
}

export default enforcementConfig;
