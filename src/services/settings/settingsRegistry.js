// settingsRegistry.js — every per-server setting that lives in the guild_settings
// table (edited from the dashboard later, Phase 2).
//
// One entry per setting:
//   key        the name used everywhere (also the property on the config object
//              that exposes it: enforcementConfig.<key>, automodConfig.<key>, …)
//   module     the dashboard module / page it belongs to
//   kind       channel | category | role | number | duration | string | url | boolean | list | json
//              (json: a structured value, e.g. the server rules; `describe(value)` is its one-line summary)
//   guild      'main' (MAIN_GUILD_ID) or 'support' (SUPPORT_GUILD_ID): the server whose
//              row holds it
//   env        the environment variable that seeds it once (and is the fallback while
//              the database is down at boot — owner decision 1)
//   envUnit    how the env value is written when it differs from the stored unit
//              (durations are stored in ms; their env vars are in minutes or days)
//   fallback   the value used when the env var is empty (the old hardcoded default)
//   prodOnly   the fallback points at the real Mewvo servers: never used in test mode
//   sensitive  never shown in full on a page or in the audit log
//   schema     zod schema every new value must pass
//
// Pure: no database, no Discord. ENFORCEMENT_REASONS, the warn ladder and the automod
// steps stay in code (owner decision 3).

import { z } from 'zod';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const SNOWFLAKE_RE = /^\d{17,20}$/;
const INVITE_RE = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/;

const snowflake = z.string().regex(SNOWFLAKE_RE, 'must be a Discord ID (17–20 digits)');
const optionalId = snowflake.nullable();
const idList = z.array(snowflake).max(25, 'at most 25 IDs');
const invite = z.string().regex(INVITE_RE, 'must be a discord.gg invite link');
const httpsUrl = z.string().max(500).refine((value) => {
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}, 'must be an https:// link');
const int = (min, max) => z.number().int('must be a whole number').min(min).max(max);
const wordList = z.array(z.string().trim().toLowerCase().min(1).max(64)).max(500, 'at most 500 words');

// Server rules (dashboard Rules page, public /rules, the rule line in punishment DMs).
// Each rule has a stable id, so moving or deleting rules never re-points a reason link;
// its number is its position (1-based). updatedAt: when the list last changed (ISO).
export const RULES_LIMITS = Object.freeze({ maxRules: 30, titleMax: 80, textMax: 1000 });
const ruleId = z.string().regex(/^[a-z0-9]{4,16}$/, 'must be a rule id');
const serverRules = z.object({
    rules: z.array(z.object({
        id: ruleId,
        title: z.string().trim().min(1, 'a rule needs a title').max(RULES_LIMITS.titleMax).refine((v) => !/[\r\n]/.test(v), 'the title must be one line'),
        text: z.string().trim().max(RULES_LIMITS.textMax),
    }).strict()).max(RULES_LIMITS.maxRules, `at most ${RULES_LIMITS.maxRules} rules`)
        .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, 'rule ids must be unique'),
    updatedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), 'must be a date').nullable(),
}).strict();
// Prebuilt reason key (config/enforcement.js ENFORCEMENT_REASONS) → rule id.
const reasonRuleLinks = z.record(z.string().regex(/^[a-z0-9_]{1,40}$/, 'must be a reason key'), ruleId)
    .refine((links) => Object.keys(links).length <= 50, 'at most 50 links');

export const SETTING_KINDS = ['channel', 'category', 'role', 'number', 'duration', 'string', 'url', 'boolean', 'list', 'json'];

/** @type {ReadonlyArray<object>} */
export const SETTINGS = Object.freeze([
    // ── Enforcement ──
    {
        key: 'adminRequestChannelId', module: 'enforcement', kind: 'channel', guild: 'main',
        label: 'Admin request channel', env: 'ADMIN_REQUEST_CHANNEL_ID',
        fallback: '1527697155643408442', prodOnly: true, schema: optionalId,
    },
    {
        key: 'mutedRoleId', module: 'enforcement', kind: 'role', guild: 'main',
        label: 'Muted role', env: 'MUTED_ROLE_ID', fallback: null, schema: optionalId,
    },
    {
        key: 'warnRoleIds', module: 'enforcement', kind: 'list', itemKind: 'role', guild: 'main',
        label: 'Warning roles (1, 2, 3+ warnings)', env: 'WARN_ROLE_IDS', envUnit: 'csv',
        fallback: ['1527697636969152672', '1527697712189800641', '1564357658943946794'], prodOnly: true,
        prodFallbackEmpty: [], schema: idList,
    },
    {
        key: 'massActionLimit', module: 'enforcement', kind: 'number', guild: 'main',
        label: 'Mass-action guard: bans/kicks allowed in the window', env: 'MASS_ACTION_LIMIT',
        fallback: 5, schema: int(1, 100),
    },
    {
        key: 'massMuteLimit', module: 'enforcement', kind: 'number', guild: 'main',
        label: 'Mass-action guard: mutes allowed in the window', env: 'MASS_MUTE_LIMIT',
        fallback: 10, schema: int(1, 200),
    },
    {
        key: 'massActionWindowMs', module: 'enforcement', kind: 'duration', guild: 'main',
        label: 'Mass-action guard: window', env: 'MASS_ACTION_WINDOW_MINUTES', envUnit: 'minutes',
        fallback: 10 * MINUTE, schema: int(MINUTE, DAY),
    },
    {
        key: 'massActionBlockMs', module: 'enforcement', kind: 'duration', guild: 'main',
        label: 'Mass-action guard: block length', env: 'MASS_ACTION_BLOCK_MINUTES', envUnit: 'minutes',
        fallback: 60 * MINUTE, schema: int(MINUTE, 7 * DAY),
    },
    // ── Appeals ──
    {
        key: 'appealsCategoryId', module: 'appeals', kind: 'category', guild: 'main',
        label: 'Appeals category (mute/warn appeals)', env: 'MAIN_APPEALS_CATEGORY_ID',
        fallback: '1531365877755285606', prodOnly: true, schema: optionalId,
    },
    {
        key: 'reportsCategoryId', module: 'appeals', kind: 'category', guild: 'main',
        label: 'Staff reports category', env: 'MAIN_REPORTS_CATEGORY_ID', fallback: null, schema: optionalId,
    },
    {
        key: 'modmailCategoryId', module: 'appeals', kind: 'category', guild: 'main',
        label: 'Modmail category', env: 'MAIN_MODMAIL_CATEGORY_ID', fallback: null, schema: optionalId,
    },
    {
        key: 'openChannelCap', module: 'appeals', kind: 'number', guild: 'main',
        label: 'Most open staff reports + modmail at once', env: 'OPEN_CHANNEL_CAP', fallback: 20, schema: int(1, 45),
    },
    {
        key: 'appealWindowMs', module: 'appeals', kind: 'duration', guild: 'main',
        label: 'Appeal window', env: null, fallback: 30 * DAY, schema: int(DAY, 365 * DAY),
    },
    {
        key: 'appealCooldownMs', module: 'appeals', kind: 'duration', guild: 'main',
        label: 'Cooldown after a denied appeal', env: null, fallback: 7 * DAY, schema: int(0, 90 * DAY),
    },
    {
        key: 'rejoinInviteMaxAgeSeconds', module: 'appeals', kind: 'number', unit: 'seconds', guild: 'main',
        label: 'Rejoin invite lifetime (seconds)', env: null, fallback: 7 * 24 * 60 * 60,
        // Discord's limit for invite max_age.
        schema: int(60, 7 * 24 * 60 * 60),
    },
    {
        key: 'staleReportMs', module: 'appeals', kind: 'duration', guild: 'main',
        label: 'Close quiet report channels after', env: 'STALE_REPORT_DAYS', envUnit: 'days',
        fallback: 7 * DAY, schema: int(DAY, 90 * DAY),
    },
    {
        key: 'staleAppealReminderMs', module: 'appeals', kind: 'duration', guild: 'main',
        label: 'Remind staff about a quiet appeal after', env: 'STALE_APPEAL_REMINDER_DAYS', envUnit: 'days',
        fallback: 3 * DAY, schema: int(DAY, 90 * DAY),
    },
    {
        // /transparency on the website (services/site/pages/transparency.js): monthly counts
        // only, never names or IDs. Off until an administrator turns it on in the dashboard.
        key: 'transparencyReportEnabled', module: 'appeals', kind: 'boolean', guild: 'main',
        label: 'Publish a monthly transparency report on the website', env: null, fallback: false, schema: z.boolean(),
    },
    {
        // On: the moderator who issued a punishment cannot decide its appeal (OWNER_IDS
        // excepted, logged as an owner override). See enforcement/appealReviewer.js.
        key: 'independentAppealReview', module: 'appeals', kind: 'boolean', guild: 'main',
        label: 'Appeals must be decided by someone other than the issuing moderator', env: null,
        fallback: false, schema: z.boolean(),
    },
    // ── Logging ──
    {
        key: 'modLogChannelId', module: 'logging', kind: 'channel', guild: 'main',
        label: 'Mod log channel', env: 'MOD_LOG_CHANNEL_ID',
        fallback: '1564598148251525252', prodOnly: true, schema: optionalId,
    },
    {
        key: 'evidenceChannelId', module: 'logging', kind: 'channel', guild: 'main',
        label: 'Evidence channel (falls back to the mod log)', env: 'EVIDENCE_CHANNEL_ID', fallback: null, schema: optionalId,
    },
    // ── Automod ──
    {
        key: 'reviewChannelId', module: 'automod', kind: 'channel', guild: 'main',
        label: 'Review channel (falls back to the mod log)', env: 'AUTOMOD_REVIEW_CHANNEL_ID', fallback: null, schema: optionalId,
    },
    {
        key: 'alertsChannelId', module: 'automod', kind: 'channel', guild: 'main',
        label: 'Alerts channel (falls back to the mod log)', env: 'BOT_ALERTS_CHANNEL_ID', fallback: null, schema: optionalId,
    },
    {
        key: 'exemptChannelIds', module: 'automod', kind: 'list', itemKind: 'channel', guild: 'main',
        label: 'Channels automod ignores', env: 'AUTOMOD_EXEMPT_CHANNEL_IDS', envUnit: 'csv', fallback: [], schema: idList,
    },
    {
        key: 'extraBlockedWords', module: 'automod', kind: 'list', itemKind: 'string', guild: 'main',
        label: 'Extra blocked words (applied after a restart)', env: 'AUTOMOD_EXTRA_WORDS', envUnit: 'csv-lower',
        fallback: [], schema: wordList,
    },
    // ── Verification ──
    {
        key: 'verifySuccessRedirect', module: 'verification', kind: 'url', guild: 'main',
        label: 'Page after web verification', env: 'VERIFY_SUCCESS_REDIRECT',
        fallback: 'https://discord.gg/WyceK9YENP', schema: httpsUrl,
    },
    // ── Support server ──
    {
        key: 'supportServerInvite', module: 'support', kind: 'url', guild: 'main',
        label: 'Support server invite', env: 'SUPPORT_SERVER_INVITE',
        fallback: 'https://discord.gg/7Ckv9Bt577', schema: invite,
    },
    {
        key: 'supportAppealsCategoryId', module: 'support', kind: 'category', guild: 'support',
        label: 'Ban/kick appeals category (support server)', env: 'APPEALS_CATEGORY_ID', fallback: null, schema: optionalId,
    },
    {
        key: 'bannedRoleId', module: 'support', kind: 'role', guild: 'support',
        label: 'Banned role (support server)', env: 'BANNED_ROLE_ID',
        fallback: '1564363121685176320', prodOnly: true, schema: optionalId,
    },
    // ── Server rules ──
    {
        key: 'serverRules', module: 'rules', kind: 'json', guild: 'main', label: 'Server rules',
        fallback: Object.freeze({ rules: Object.freeze([]), updatedAt: null }), schema: serverRules,
        describe: (value) => `${value?.rules?.length || 0} rule${value?.rules?.length === 1 ? '' : 's'}`,
    },
    {
        key: 'reasonRuleLinks', module: 'rules', kind: 'json', guild: 'main', label: 'Reasons linked to rules',
        fallback: Object.freeze({}), schema: reasonRuleLinks,
        describe: (value) => `${Object.keys(value || {}).length} linked`,
    },
].map((entry) => Object.freeze({ sensitive: false, envUnit: null, ...entry })));

const BY_KEY = new Map(SETTINGS.map((entry) => [entry.key, entry]));

export function getSettingEntry(key) {
    return BY_KEY.get(key) || null;
}

export function settingKeys() {
    return [...BY_KEY.keys()];
}

export function entriesForModule(module) {
    return SETTINGS.filter((entry) => entry.module === module);
}

export function entriesForGuild(guild) {
    return SETTINGS.filter((entry) => entry.guild === guild);
}

function isTestEnv(env) {
    return env.NODE_ENV === 'test';
}

function positiveInt(raw) {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function csv(raw, lower = false) {
    const items = String(raw).split(',').map((item) => item.trim()).filter(Boolean);
    return lower ? items.map((item) => item.toLowerCase()) : items;
}

/** The hardcoded default of an entry for this environment (prodOnly ones are null/empty in test mode). */
export function defaultValue(entry, env = process.env) {
    if (entry.prodOnly && isTestEnv(env)) return entry.prodFallbackEmpty !== undefined ? entry.prodFallbackEmpty : null;
    return Array.isArray(entry.fallback) ? [...entry.fallback] : entry.fallback;
}

/**
 * The value from the environment, parsed to the stored unit, or undefined when the env
 * var is empty / unusable (then the default applies). Same parsing as the old config.
 */
export function envValue(entry, env = process.env) {
    if (!entry.env) return undefined;
    const raw = String(env[entry.env] ?? '').trim();
    if (!raw) return undefined;
    switch (entry.envUnit) {
        case 'csv': {
            const items = csv(raw);
            return items.length ? items : undefined;
        }
        case 'csv-lower': {
            const items = csv(raw, true);
            return items.length ? items : undefined;
        }
        case 'minutes': {
            const value = positiveInt(raw);
            return value === null ? undefined : value * MINUTE;
        }
        case 'days': {
            const value = positiveInt(raw);
            return value === null ? undefined : value * DAY;
        }
        default:
            if (entry.kind === 'number') return positiveInt(raw) ?? undefined;
            return raw;
    }
}

/** env value, else the default: what the bot runs on when no database row has the key. */
export function seedValue(entry, env = process.env) {
    const fromEnv = envValue(entry, env);
    return fromEnv !== undefined ? fromEnv : defaultValue(entry, env);
}

/** { ok: true, value } or { ok: false, error } for one key. */
export function validateSetting(key, value) {
    const entry = getSettingEntry(key);
    if (!entry) return { ok: false, error: `unknown setting "${key}"` };
    const result = entry.schema.safeParse(value);
    if (!result.success) {
        const issue = result.error.issues[0];
        return { ok: false, error: `${entry.label}: ${issue?.message || 'invalid value'}` };
    }
    return { ok: true, value: result.data };
}

/**
 * Validates a patch { key: value } for one server ('main' | 'support'). Returns the
 * parsed patch; throws an Error with `userMessage` listing every problem.
 */
export function validatePatch(patch, guild = 'main') {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw Object.assign(new Error('Settings patch must be an object'), { userMessage: 'Invalid settings update.' });
    }
    const out = {};
    const problems = [];
    for (const [key, value] of Object.entries(patch)) {
        const entry = getSettingEntry(key);
        if (!entry) {
            problems.push(`unknown setting "${key}"`);
            continue;
        }
        if (entry.guild !== guild) {
            problems.push(`${entry.label} belongs to the ${entry.guild} server`);
            continue;
        }
        const result = validateSetting(key, value);
        if (result.ok) out[key] = result.value;
        else problems.push(result.error);
    }
    if (problems.length) {
        const error = new Error(`Invalid settings: ${problems.join('; ')}`);
        error.userMessage = problems.join('; ');
        error.problems = problems;
        throw error;
    }
    return out;
}
