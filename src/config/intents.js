// intents.js — the gateway intents, with the two privileged ones switchable from the environment.
//
// ENABLE_MESSAGE_CONTENT and ENABLE_GUILD_MEMBERS default to true (today's behaviour). Set one to
// false when Discord refuses that privileged intent for a verified bot: the bot then starts without
// it (instead of failing to log in with "Used disallowed intents") and the features below degrade:
// each one checks hasIntent() at its entry point, and warnDisabledFeatures() logs one warning per
// disabled feature at startup. docs/scale-and-verification.md has the background.
//
// Without Message Content, Discord still sends the text of DMs and of messages that mention the
// bot; every other server message arrives with empty content, embeds and attachments.
// Without Guild Members, Discord sends no member join/leave/update events and no full member list.

import { GatewayIntentBits } from 'discord.js';

/** false only for an explicit "false/0/no/off"; unset or anything else keeps the intent on. */
function envFlag(value) {
    if (value === undefined || value === null || String(value).trim() === '') return true;
    return !/^(0|false|no|off)$/i.test(String(value).trim());
}

/** The privileged intents and the env variable that switches each one. */
export const PRIVILEGED_INTENTS = Object.freeze({
    MessageContent: 'ENABLE_MESSAGE_CONTENT',
    GuildMembers: 'ENABLE_GUILD_MEMBERS',
});

/** Always requested (not privileged). */
const BASE_INTENTS = Object.freeze([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildBans,
    // Native Discord AutoMod executions (services/automod/nativeBridge.js); the
    // events only arrive while the bot has Manage Server.
    GatewayIntentBits.AutoModerationExecution,
]);

/**
 * True when the bot runs with this intent. Non-privileged intents are always on.
 * Reads the environment on every call (a string test, cheap enough for messageCreate).
 */
export function hasIntent(name, env = process.env) {
    const variable = PRIVILEGED_INTENTS[name];
    return variable ? envFlag(env[variable]) : true;
}

/** The intent list for the Client constructor. */
export function buildIntents(env = process.env) {
    const intents = [...BASE_INTENTS];
    if (hasIntent('GuildMembers', env)) intents.push(GatewayIntentBits.GuildMembers);
    if (hasIntent('MessageContent', env)) intents.push(GatewayIntentBits.MessageContent);
    return intents;
}

/** Features that need a privileged intent: key → { intent, label }. Keys are what callers pass to featureAvailable(). */
export const INTENT_FEATURES = Object.freeze({
    automodContent: { intent: 'MessageContent', label: 'automod content checks (words, links, invites, caps, language, custom rules); mention and flood checks still run' },
    counting: { intent: 'MessageContent', label: 'counting game (messages in the counting channel are left alone)' },
    tagAutoResponses: { intent: 'MessageContent', label: 'tag auto-responses (word/regex triggers)' },
    prefixCommands: { intent: 'MessageContent', label: 'prefix commands (slash commands still work)' },
    modmailStaffRelay: { intent: 'MessageContent', label: 'modmail staff replies typed in the staff channel (member DMs still arrive)' },
    messageLogText: { intent: 'MessageContent', label: 'message text in edit/delete logs, starboard posts and ticket transcripts' },
    welcome: { intent: 'GuildMembers', label: 'welcome and goodbye messages, auto roles, verification on join' },
    joinGate: { intent: 'GuildMembers', label: 'join gate, raid join tracking, impersonation checks, probation' },
    memberLogs: { intent: 'GuildMembers', label: 'member join/leave/update logs and member insights' },
    muteReapply: { intent: 'GuildMembers', label: 'mute and temp-role re-apply on rejoin, Banned role on join' },
    roleRules: { intent: 'GuildMembers', label: 'role rules (on join/role change and the full-server backfill)' },
    levelRoles: { intent: 'GuildMembers', label: 'level roles on rejoin and the full-server level role sync' },
    fullMemberList: { intent: 'GuildMembers', label: 'full member list fetches (staff activity, random member, dashboard lists use the cache only)' },
});

/** True when the feature's intent is on (unknown keys: true). */
export function featureAvailable(feature, env = process.env) {
    const entry = INTENT_FEATURES[feature];
    return entry ? hasIntent(entry.intent, env) : true;
}

/** The features that are off because an intent is disabled: [{ feature, intent, variable, label }]. */
export function disabledFeatures(env = process.env) {
    return Object.entries(INTENT_FEATURES)
        .filter(([, { intent }]) => !hasIntent(intent, env))
        .map(([feature, { intent, label }]) => ({ feature, intent, variable: PRIVILEGED_INTENTS[intent], label }));
}

let warned = false;

/** One warning per disabled feature, once per process. Returns the number of warnings logged. */
export function warnDisabledFeatures(log, env = process.env, { force = false } = {}) {
    if (warned && !force) return 0;
    warned = true;
    const list = disabledFeatures(env);
    for (const { variable, intent, label } of list) {
        log(`Intent ${intent} is off (${variable}=false): disabled: ${label}`);
    }
    return list.length;
}
