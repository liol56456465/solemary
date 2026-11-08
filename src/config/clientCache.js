// clientCache.js — discord.js cache limits and sweepers for the client constructor (B5).
//
// discord.js defaults keep 200 messages per channel and every member, reaction user,
// presence, sticker, ... it ever sees, so memory grows with servers and members.
//
// Limits are per manager instance: MessageManager per channel, GuildMemberManager per server.
//   MessageManager 50 per channel, swept every 15 min (messages older than 1 h go). A deleted
//     or edited message that is no longer cached arrives as a partial: its log line has no
//     old text (messageDelete.js skips partials; starboard looks posts up by id).
//   GuildMemberManager 25,000 per server; the bot's own member is always kept (permission
//     checks read guild.members.me). No member sweeper: commands, mutes and the dashboard
//     read the cache and fetch what's missing.
//   0 (nothing cached): ReactionUserManager (starboard counts from reaction.users.fetch(),
//     whose return value doesn't need the cache), PresenceManager (no presence intent),
//     GuildStickerManager, GuildScheduledEventManager, StageInstanceManager,
//     ThreadMemberManager — nothing in src reads these caches.
//   Kept at the default (unlimited):
//     ReactionManager and VoiceStateManager (reaction counts; voice XP, mute disconnects);
//     GuildInviteManager: automodService.js ownCachedInvite reads guild.invites.cache (the
//       server's own invites created by Mewvo, enforcementService.js invites.create);
//     AutoModerationRuleManager: nativeBridge.js reads execution.autoModerationRule, which is
//       guild.autoModerationRules.cache; with no cache every execution would cost a REST fetch.
//   Threads: discord.js default sweeper (archived threads, hourly).

import { Options } from 'discord.js';

export const MESSAGE_CACHE_PER_CHANNEL = 50;
export const MEMBER_CACHE_PER_GUILD = 25_000;
export const MESSAGE_SWEEP_INTERVAL_S = 900;
export const MESSAGE_LIFETIME_S = 3600;

/** The cacheWithLimits settings (exported for tests). */
export function cacheLimitSettings() {
    return {
        ...Options.DefaultMakeCacheSettings,
        MessageManager: MESSAGE_CACHE_PER_CHANNEL,
        GuildMemberManager: {
            maxSize: MEMBER_CACHE_PER_GUILD,
            keepOverLimit: (member) => member.id === member.client?.user?.id,
        },
        ReactionUserManager: 0,
        PresenceManager: 0,
        GuildStickerManager: 0,
        GuildScheduledEventManager: 0,
        StageInstanceManager: 0,
        ThreadMemberManager: 0,
    };
}

export function makeCache() {
    return Options.cacheWithLimits(cacheLimitSettings());
}

export function sweepers() {
    return {
        ...Options.DefaultSweeperSettings,
        messages: { interval: MESSAGE_SWEEP_INTERVAL_S, lifetime: MESSAGE_LIFETIME_S },
    };
}
