// homeServers.js — Mewvo's own three servers and the ids of the home-server features
// (docs/home-servers.md). Ids are not secrets.
//
//   main      1527697154926182492  the community server; its roles drive the role mirror
//   support   1564312871976829009  Mewvo Support
//   database  1564332751170044186  owner tools (/database, health report, profile channel)
//
// Features: the role mirror (main → support / database), the 5-minute health report and the
// /database profile channel. Outside test mode the ids below are fixed. In test mode
// (NODE_ENV=test) NONE of the real ids is used: every id comes from the env (unset = that
// feature is off), and an env value that is one of the real ids is refused (null), so a test
// run can never touch the real servers, roles or channels. validateTestMode (testMode.js)
// also refuses to start when a HOME_* value or TEST_GUILD_IDS names a real id.
//
// Test-mode env:
//   MAIN_GUILD_ID, SUPPORT_GUILD_ID         (already required by test mode)
//   HOME_DATABASE_GUILD_ID                  the test "database" server
//   HOME_HEALTH_CHANNEL_ID                  health report channel (in the database server)
//   HOME_PROFILE_CHANNEL_ID                 profile channel (in the database server)
//   HOME_ROLE_MIRROR                        rules: "src1,src2>target@support;src3>target@database"

const SNOWFLAKE = /^\d{17,20}$/;

export const REAL_GUILDS = Object.freeze({
    main: '1527697154926182492',
    support: '1564312871976829009',
    database: '1564332751170044186',
});

export const DEFAULT_OWNER_TOOLS_GUILD_ID = REAL_GUILDS.database;

export const REAL_CHANNELS = Object.freeze({
    health: '1569108216372269217',
    profile: '1564332757029490851',
});

const ADMIN_TIER = ['1527697154943225980', '1527697154943225979', '1527697154943225978', '1527697154943225977'];

/**
 * The role mirror, as the owner gave it (2026-11-09). `target: null` = an UNSET entry: the
 * owner's id for it is not a role id yet, so it is skipped and reported once at startup
 * (`given` keeps what was written).
 */
export const REAL_MIRROR_RULES = Object.freeze([
    { sources: ['1527697154926182498'], target: '1564363263402184885', guild: 'support' },
    // Given as "156436291527508386": 18 digits, and a snowflake that old (2016) cannot be a role
    // in the support server (created 2026). Probably a digit was lost. Left UNSET until corrected.
    { sources: ADMIN_TIER, target: null, given: '156436291527508386', guild: 'support' },
    { sources: ['1527697154943225981'], target: '1564363269765079070', guild: 'support' },
    { sources: ['1527697154943225982'], target: '1564362821071016080', guild: 'support' },
    { sources: ADMIN_TIER, target: '1569108491380072581', guild: 'database' },
    { sources: ['1527697154943225982'], target: '1569108245241536613', guild: 'database' },
].map((rule) => Object.freeze({ ...rule, sources: Object.freeze([...rule.sources]) })));

/** Every real id this module knows (servers, channels, roles): test mode never uses one. */
export const REAL_IDS = new Set([
    ...Object.values(REAL_GUILDS),
    ...Object.values(REAL_CHANNELS),
    ...REAL_MIRROR_RULES.flatMap((rule) => [...rule.sources, rule.target, rule.given].filter(Boolean)),
]);

export const TEST_ENV_NAMES = Object.freeze([
    'MAIN_GUILD_ID', 'SUPPORT_GUILD_ID', 'HOME_DATABASE_GUILD_ID', 'HOME_HEALTH_CHANNEL_ID', 'HOME_PROFILE_CHANNEL_ID',
]);

export const isTestEnv = (env = process.env) => env.NODE_ENV === 'test';

/** A test-mode id from the env: a snowflake that is not a real id, else null. */
function testId(env, name) {
    const value = String(env[name] ?? '').trim();
    return SNOWFLAKE.test(value) && !REAL_IDS.has(value) ? value : null;
}

/**
 * HOME_ROLE_MIRROR → rules. "a,b>t@support;c>u@database". A rule with a bad id, a real id
 * or an unknown server is dropped (and listed in `problems`).
 */
export function parseMirrorRules(text) {
    const rules = [];
    const problems = [];
    for (const part of String(text || '').split(';').map((p) => p.trim()).filter(Boolean)) {
        const match = /^([\d,\s]+)>\s*(\d{17,20})\s*@\s*(support|database)$/.exec(part);
        const sources = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
        const ids = match ? [...sources, match[2]] : [];
        if (!match || !sources.length || ids.some((id) => !SNOWFLAKE.test(id) || REAL_IDS.has(id))) {
            problems.push(`HOME_ROLE_MIRROR rule "${part.slice(0, 80)}" is not valid (or uses a real id); ignored`);
            continue;
        }
        rules.push(Object.freeze({ sources: Object.freeze(sources), target: match[2], guild: match[3] }));
    }
    return { rules, problems };
}

/**
 * The home servers and feature ids in effect: { guilds: { main, support, database },
 * channels: { health, profile }, mirrorRules, test }. Any id may be null (feature off).
 */
export function homeServers(env = process.env) {
    if (!isTestEnv(env)) {
        return {
            test: false,
            guilds: { ...REAL_GUILDS },
            channels: { ...REAL_CHANNELS },
            mirrorRules: REAL_MIRROR_RULES,
        };
    }
    return {
        test: true,
        guilds: {
            main: testId(env, 'MAIN_GUILD_ID'),
            support: testId(env, 'SUPPORT_GUILD_ID'),
            database: testId(env, 'HOME_DATABASE_GUILD_ID'),
        },
        channels: {
            health: testId(env, 'HOME_HEALTH_CHANNEL_ID'),
            profile: testId(env, 'HOME_PROFILE_CHANNEL_ID'),
        },
        mirrorRules: parseMirrorRules(env.HOME_ROLE_MIRROR).rules,
    };
}

/** Test mode: HOME_* values that name a real Mewvo id (validateTestMode refuses to start). */
export function homeServerTestModeErrors(env = process.env) {
    const errors = [];
    for (const name of ['HOME_DATABASE_GUILD_ID', 'HOME_HEALTH_CHANNEL_ID', 'HOME_PROFILE_CHANNEL_ID']) {
        const value = String(env[name] ?? '').trim();
        if (REAL_IDS.has(value)) errors.push(`${name} is a real Mewvo id (${value}). Use an id from your test servers.`);
    }
    const mirror = String(env.HOME_ROLE_MIRROR ?? '');
    if (mirror && [...REAL_IDS].some((id) => mirror.includes(id))) {
        errors.push('HOME_ROLE_MIRROR names a real Mewvo role or server. Use roles from your test servers.');
    }
    const testGuilds = String(env.TEST_GUILD_IDS ?? '').split(',').map((id) => id.trim());
    if (testGuilds.includes(REAL_GUILDS.database)) {
        errors.push(`TEST_GUILD_IDS contains the real Mewvo database server (${REAL_GUILDS.database}). Use your test servers.`);
    }
    return errors;
}

/** Mirror rules that cannot run (UNSET targets), for the one startup line. */
export function unsetMirrorRules(env = process.env) {
    return homeServers(env).mirrorRules.filter((rule) => !rule.target);
}
