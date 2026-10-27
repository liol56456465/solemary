// enforcement.js — settings for /enforcements, appeals and the warn ladder.

import { logger } from '../utils/logger.js';

const SNOWFLAKE = /^\d{17,20}$/;

function readId(name) {
    const value = (process.env[name] || '').trim();
    return value || null;
}

// Defaults that point at the real Meowist servers; test mode never uses them.
const IS_TEST = process.env.NODE_ENV === 'test';
function prodDefault(value) {
    return IS_TEST ? null : value;
}

function readPositiveInt(name, fallback) {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readIdList(name) {
    const raw = (process.env[name] || '').trim();
    return raw ? raw.split(',').map((id) => id.trim()).filter(Boolean) : null;
}

export const enforcementConfig = {
    mainGuildId: readId('MAIN_GUILD_ID'),
    supportGuildId: readId('SUPPORT_GUILD_ID'),
    // Defaults are the production Meowist values; .env.test overrides them for the test servers.
    adminRequestChannelId: readId('ADMIN_REQUEST_CHANNEL_ID') || '1527697155643408442',
    supportServerInvite: (process.env.SUPPORT_SERVER_INVITE || '').trim() || 'https://discord.gg/7Ckv9Bt577',
    // Fallback main-server category for appeals and staff reports when /ticket has no ticket category set.
    // (Renamed from APPEALS_CATEGORY_ID, which was a support-server category; that variable is ignored.)
    appealsCategoryId: readId('MAIN_APPEALS_CATEGORY_ID') || prodDefault('1531365877755285606'),
    mutedRoleId: readId('MUTED_ROLE_ID'),
    // A role in the support server that members with an active main-server ban get.
    bannedRoleId: readId('BANNED_ROLE_ID') || prodDefault('1564363121685176320'),
    // Main-server roles for 1, 2 and 3+ active warnings (WARN_ROLE_IDS=id1,id2,id3).
    warnRoleIds: readIdList('WARN_ROLE_IDS')
        || prodDefault(['1527697636969152672', '1527697712189800641', '1564357658943946794'])
        || [],
    // Main-server channel that gets a message for every enforcement action and appeal decision.
    modLogChannelId: readId('MOD_LOG_CHANNEL_ID') || prodDefault('1564598148251525252'),

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

    appealWindowMs: 30 * 24 * 60 * 60 * 1000,
    appealCooldownMs: 7 * 24 * 60 * 60 * 1000,
    rejoinInviteMaxAgeSeconds: 7 * 24 * 60 * 60,

    panelTtlMs: 15 * 60 * 1000,
    panelMaxEntries: 500,

    // Panel mass-action guard: a moderator who has already banned/kicked this many
    // members within the window is blocked from the panel on the next ban/kick,
    // and OWNER_IDS get a DM. OWNER_IDS themselves are never blocked.
    massActionLimit: readPositiveInt('MASS_ACTION_LIMIT', 5),
    massActionWindowMs: readPositiveInt('MASS_ACTION_WINDOW_MINUTES', 10) * 60 * 1000,
    massActionBlockMs: readPositiveInt('MASS_ACTION_BLOCK_MINUTES', 60) * 60 * 1000,

    // Stale appeal/report channels (checked with the ticket reminders, every 5 min):
    // report channels close after this long without a message, and staff get one
    // reminder in a pending appeal that has been quiet this long. Pending appeals are
    // never closed automatically.
    staleReportMs: readPositiveInt('STALE_REPORT_DAYS', 7) * 24 * 60 * 60 * 1000,
    staleAppealReminderMs: readPositiveInt('STALE_APPEAL_REMINDER_DAYS', 3) * 24 * 60 * 60 * 1000,
};

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
