// enforcement.js — settings for /enforcements, appeals and the warn ladder.

import { logger } from '../utils/logger.js';

const SNOWFLAKE = /^\d{17,20}$/;

function readId(name) {
    const value = (process.env[name] || '').trim();
    return value || null;
}

export const enforcementConfig = {
    mainGuildId: readId('MAIN_GUILD_ID'),
    supportGuildId: readId('SUPPORT_GUILD_ID'),
    // Defaults are the production Meowist values; .env.test overrides them for the test servers.
    adminRequestChannelId: readId('ADMIN_REQUEST_CHANNEL_ID') || '1527697155643408442',
    supportServerInvite: (process.env.SUPPORT_SERVER_INVITE || '').trim() || 'https://discord.gg/7Ckv9Bt577',
    appealsCategoryId: readId('APPEALS_CATEGORY_ID'),
    // Optional: closed appeal/report channels move here. Without it they stay in place, renamed closed-….
    appealsArchiveCategoryId: readId('APPEALS_ARCHIVE_CATEGORY_ID'),
    mutedRoleId: readId('MUTED_ROLE_ID'),
    // Optional: a role in the support server that members with an active main-server ban get.
    bannedRoleId: readId('BANNED_ROLE_ID'),

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
        APPEALS_CATEGORY_ID: enforcementConfig.appealsCategoryId,
    };

    for (const [name, value] of Object.entries(required)) {
        if (!value) {
            errors.push(`${name} is not set`);
        } else if (!SNOWFLAKE.test(value)) {
            errors.push(`${name} must be a Discord ID (17–20 digits), got "${value}"`);
        }
    }

    for (const name of ['ADMIN_REQUEST_CHANNEL_ID', 'MUTED_ROLE_ID', 'APPEALS_ARCHIVE_CATEGORY_ID', 'BANNED_ROLE_ID']) {
        const value = readId(name);
        if (value && !SNOWFLAKE.test(value)) {
            errors.push(`${name} must be a Discord ID (17–20 digits), got "${value}"`);
        }
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
