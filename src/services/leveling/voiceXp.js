// voiceXp.js — Voice XP: members earn XP for time in voice channels (docs/features-v14.md §1).
//
// A 60-second tick (cron in app.js, `exclusive('voice_xp')`) looks at guild.voiceStates.cache.
// A minute counts only when a member was eligible in the same channel on this tick AND on the
// previous one (an in-memory Set of guild:user:channel). No sessions are stored, so a restart
// loses at most a minute or two and can never count a minute twice. While the gateway is not
// ready (reconnecting) the tick is skipped and the Set is cleared.
//
// Eligible: a human (not a bot) whose member is cached (no member fetches), not deafened
// (self or server), not server-muted, not in the AFK channel, not in a leveling ignored channel
// or a voice excluded channel, without an ignored role, not blacklisted (the same checks as chat
// XP, messageCreate.js), and in a channel with at least `minHumans` such members. Self-muted
// members count unless `requireUnmuted` is on. On a stage, a suppressed listener counts.
//
// A counted minute: random xpMin..xpMax x the existing channel/role boosts (levelBoosts.js),
// given through addXp(..., { source: 'voice' }) (level roles, role rules and level-up posts as
// for chat; the chat cooldown is not touched). The daily cap counts minutes per member per server
// per UTC day; past the cap the time is still counted, without XP. The time is written first:
// if that write fails, no XP is given for the minute.

import { logger } from '../../utils/logger.js';
import { getLevelingConfig } from './leveling.js';
import { addXp } from './xpSystem.js';
import { applyXpMultiplier, computeXpMultiplier } from './levelBoosts.js';
import { VOICE_MIN_HUMANS_MIN, voiceConfigOf } from './voiceConfig.js';
import { addVoiceXp, readDayMinutes, upsertMinutes, utcDay } from './voiceStore.js';

/** Seconds of voice time one counted minute adds. */
export const SECONDS_PER_TICK = 60;
/** discord.js Status.Ready. */
const WS_READY = 0;

/**
 * True when every shard is connected and ready. client.ws.status is set to Ready once, at the
 * first ready, and never changes on a reconnect (discord.js 14 WebSocketManager), so each
 * shard's own status is checked: while one reconnects its voice states may be stale.
 */
export function gatewayReady(client) {
    const shards = client?.ws?.shards;
    if (!shards || !(shards.size > 0)) return false;
    for (const shard of shards.values()) if (shard?.status !== WS_READY) return false;
    return true;
}

let previous = new Set(); // guild:user:channel seen eligible on the last tick
let running = false;

export const voiceKey = (guildId, userId, channelId) => `${guildId}:${userId}:${channelId}`;

/**
 * Who is eligible right now in one guild, from the cache only. Pure (reads the guild objects).
 * `levelingConfig` is the whole leveling config. With `prevSet`, each entry says whether it was
 * also eligible on the previous tick (`counted`: this minute counts).
 * Returns [{ key, userId, channelId, member, channel, counted }].
 */
export function eligibleMembers(guild, levelingConfig, prevSet = null) {
    const voice = voiceConfigOf(levelingConfig);
    const ignoredChannels = new Set(levelingConfig?.ignoredChannels || []);
    const excluded = new Set(voice.excludedChannels);
    const ignoredRoles = levelingConfig?.ignoredRoles || [];
    const blacklisted = new Set(levelingConfig?.blacklistedUsers || []);
    const afk = guild?.afkChannelId || null;
    const byChannel = new Map();
    for (const state of guild?.voiceStates?.cache?.values?.() || []) {
        const channelId = state?.channelId;
        if (!channelId || channelId === afk) continue;
        if (ignoredChannels.has(channelId) || excluded.has(channelId)) continue;
        if (state.selfDeaf || state.serverDeaf || state.serverMute) continue;
        if (voice.requireUnmuted && state.selfMute) continue;
        const userId = state.id;
        const member = guild.members?.cache?.get?.(userId);
        if (!member?.user || member.user.bot) continue;
        if (blacklisted.has(userId)) continue;
        if (ignoredRoles.length && member.roles?.cache?.some?.((role) => ignoredRoles.includes(role.id))) continue;
        const channel = guild.channels?.cache?.get?.(channelId) || null;
        if (!channel) continue;
        if (!byChannel.has(channelId)) byChannel.set(channelId, []);
        byChannel.get(channelId).push({ userId, member, channel });
    }
    const out = [];
    for (const [channelId, members] of byChannel) {
        if (members.length < voice.minHumans) continue;
        for (const { userId, member, channel } of members) {
            const key = voiceKey(guild.id, userId, channelId);
            out.push({ key, userId, channelId, member, channel, counted: Boolean(prevSet?.has(key)) });
        }
    }
    return out;
}

/** Random whole number in [min, max]. */
const randomInt = (min, max, random) => Math.floor(random() * (max - min + 1)) + min;

/**
 * One counted minute for one member: the time first (throws when it can't be written, then no
 * XP), then the XP when the day's cap allows it. Returns { minutes, xp }.
 */
export async function awardVoiceMinute(client, guild, entry, levelingConfig, {
    now = Date.now(), random = Math.random, store = { readDayMinutes, upsertMinutes, addVoiceXp }, giveXp = addXp,
} = {}) {
    const voice = voiceConfigOf(levelingConfig);
    const day = utcDay(now);
    const before = await store.readDayMinutes(guild.id, entry.userId, day);
    let xp = 0;
    if (before < voice.dailyCapMinutes) {
        const { multiplier } = computeXpMultiplier(levelingConfig, {
            channelId: entry.channelId,
            threadParentId: null,
            roleIds: entry.member?.roles?.cache ? [...entry.member.roles.cache.keys()] : [],
        });
        xp = applyXpMultiplier(randomInt(voice.xpMin, voice.xpMax, random), multiplier);
    }
    const minutes = await store.upsertMinutes(guild.id, entry.userId, { day, seconds: SECONDS_PER_TICK, xp: 0 });
    if (xp <= 0) return { minutes, xp: 0 };
    // voice_xp counts only XP that addXp really gave (null: leveling was turned off meanwhile).
    const given = await giveXp(client, guild, entry.member, xp, { source: 'voice' });
    if (!given) return { minutes, xp: 0 };
    await store.addVoiceXp(guild.id, entry.userId, xp);
    return { minutes, xp };
}

/**
 * One tick over every cached guild. Never throws: a failing guild or member is logged and the
 * rest go on. Returns { guilds, counted, awarded, skipped } for tests and the cron log.
 * deps (tests): { now, random, store, giveXp, readConfig }.
 */
export async function runVoiceXpTick(client, deps = {}) {
    if (running) return { skipped: 'overlap', guilds: 0, counted: 0, awarded: 0 };
    running = true;
    try {
        if (!gatewayReady(client)) {
            previous = new Set();
            return { skipped: 'not-ready', guilds: 0, counted: 0, awarded: 0 };
        }
        const readConfig = deps.readConfig || getLevelingConfig;
        const next = new Set();
        let guilds = 0;
        let counted = 0;
        let awarded = 0;
        let failures = 0;
        for (const guild of client.guilds?.cache?.values?.() || []) {
            if (!guild?.available) continue;
            // Cheap first: fewer people in voice than any channel needs → no config read.
            if ((guild.voiceStates?.cache?.size || 0) < VOICE_MIN_HUMANS_MIN) continue;
            let config;
            try {
                config = await readConfig(client, guild.id);
            } catch (error) {
                failures += 1;
                logger.warn(`Voice XP: leveling config not readable for guild ${guild.id}: ${error.message}`);
                continue;
            }
            if (!config?.enabled || !voiceConfigOf(config).enabled) continue;
            guilds += 1;
            for (const entry of eligibleMembers(guild, config, previous)) {
                next.add(entry.key);
                if (!entry.counted) continue;
                counted += 1;
                try {
                    const { xp } = await awardVoiceMinute(client, guild, entry, config, deps);
                    if (xp > 0) awarded += 1;
                } catch (error) {
                    failures += 1;
                    if (failures <= 3) logger.warn(`Voice XP: minute not counted for a member in guild ${guild.id}: ${error.message}`);
                }
            }
        }
        previous = next;
        if (failures > 3) logger.warn(`Voice XP: ${failures} failures this tick`);
        return { guilds, counted, awarded, skipped: null };
    } finally {
        running = false;
    }
}

/** For tests: forget the previous tick. */
export function resetVoiceXpForTests() {
    previous = new Set();
    running = false;
}

/** For tests: the keys seen on the last tick. */
export function previousVoiceKeysForTests() {
    return new Set(previous);
}
