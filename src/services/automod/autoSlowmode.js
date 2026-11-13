// autoSlowmode.js — turns slowmode on in a channel that suddenly gets very busy
// (a fight, a spam wave, a raid) and off again once it calms down.
//
// Busy: BUSY_MESSAGES messages from at least BUSY_AUTHORS people within BUSY_WINDOW_MS.
// Only channels without slowmode are touched, and only slowmode the bot set itself is
// removed, after CALM_MS without another busy burst. State is kept in the key-value
// store so a restart still lifts it.
//
// Multi-server (B1): runs in every server where automod is on (off by default outside the
// main server; a server with it off is not even counted). The running slowmodes are stored
// per server (automod:slowmode:<guildId>, deleted when the last one is lifted), so servers
// never share or rewrite one row. The old single key (automod:slowmode) is read once at the
// first per-minute run, moved into the per-server keys and emptied.

import { logger } from '../../utils/logger.js';
import { db, deleteFromDb, getFromDb, setInDb } from '../../utils/database.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { isEnforcementDbAvailable } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { logAutomod } from './automodLog.js';
import { isSettingsUnavailable, noteSettingsUnavailable } from '../settings/guildScoped.js';
import { getAutomodSettings, isChannelExempt } from './automodSettings.js';

const BUSY_MESSAGES = 15;
const BUSY_AUTHORS = 3;
const BUSY_WINDOW_MS = 10 * 1000;
const SLOWMODE_SECONDS = 5;
const CALM_MS = 3 * 60 * 1000;
const LEGACY_STATE_KEY = 'automod:slowmode';
const STATE_PREFIX = 'automod:slowmode:';
export const stateKey = (guildId) => `${STATE_PREFIX}${guildId}`;
// Channels counted at once (one entry per channel with a message in the last 10 s).
export const RECENT_CHANNELS_MAX = 5000;

const recent = new BoundedMap(RECENT_CHANNELS_MAX); // channelId → [{ at, authorId }]
const active = new Map(); // guildId → Map(channelId → { guildId, since, lastBusy, reason }); only servers with a running slowmode
let discovered = false;   // the per-server keys (and the legacy key) were read after startup

const defaultDeps = {
    kvGet: (key) => getFromDb(key, null),
    kvSet: (key, value) => setInDb(key, value),
    kvDelete: (key) => deleteFromDb(key),
    kvList: (prefix) => db.list(prefix),
};
let deps = { ...defaultDeps };

/** Test hook: replace the key-value store (no argument restores it) and forget all state. */
export function setAutoSlowmodeDepsForTest(overrides = null) {
    deps = overrides ? { ...defaultDeps, ...overrides } : { ...defaultDeps };
    resetAutoSlowmodeState();
}

export function resetAutoSlowmodeState() {
    recent.clear();
    active.clear();
    discovered = false;
}

/** Test hook: sizes of the in-memory state. */
export function autoSlowmodeStateSizes() {
    return { recent: recent.size, guilds: active.size };
}

const toMap = (stored) => new Map(Object.entries(stored && typeof stored === 'object' ? stored : {}));

// A failed load throws and is retried next time: caching an empty map here would
// save it over the stored state on the next change.
// Concurrent loads of one server share one read, so neither overwrites the other's change.
const loading = new Map(); // guildId → Promise<Map>
async function loadGuild(guildId) {
    if (active.has(guildId)) return active.get(guildId);
    if (!loading.has(guildId)) {
        loading.set(guildId, Promise.resolve(deps.kvGet(stateKey(guildId)))
            .then((stored) => {
                if (!active.has(guildId)) active.set(guildId, toMap(stored));
                return active.get(guildId);
            })
            .finally(() => loading.delete(guildId)));
    }
    return loading.get(guildId);
}

async function saveGuild(guildId) {
    const state = active.get(guildId);
    const write = state?.size
        ? deps.kvSet(stateKey(guildId), Object.fromEntries(state))
        : deps.kvDelete(stateKey(guildId));
    if (!state?.size) active.delete(guildId);
    await Promise.resolve(write).catch((error) => logger.warn(`Auto slowmode state of ${guildId} was not saved: ${error.message}`));
}

/**
 * After a restart: loads every server with a stored slowmode, and moves the old single
 * key's entries into their servers' keys. Servers already loaded keep their state.
 */
async function discover() {
    if (discovered) return;
    const keys = await deps.kvList(STATE_PREFIX);
    for (const key of keys || []) {
        const guildId = String(key).slice(STATE_PREFIX.length);
        if (guildId) await loadGuild(guildId);
    }
    const legacy = toMap(await deps.kvGet(LEGACY_STATE_KEY));
    if (legacy.size) {
        const touched = new Set();
        for (const [channelId, entry] of legacy) {
            if (!entry?.guildId) continue;
            const state = await loadGuild(entry.guildId);
            if (!state.has(channelId)) state.set(channelId, entry);
            touched.add(entry.guildId);
        }
        for (const guildId of touched) await saveGuild(guildId);
        await deps.kvSet(LEGACY_STATE_KEY, {});
        logger.info(`Auto slowmode: moved ${legacy.size} running slowmode(s) to per-server keys`);
    }
    discovered = true;
}

/** Call for every message (after automod). Servers with automod off: nothing at all. */
export async function trackChannelActivity(message) {
    if (!message.guildId || message.author?.bot) return;
    const channel = message.channel;
    if (typeof channel?.setRateLimitPerUser !== 'function' || channel.isThread?.()) return;
    if (!isEnforcementDbAvailable()) return;
    // Cached (the automod check of the same message just read it).
    const settings = await getAutomodSettings(message.guildId);
    if (!settings.enabled) return;

    const now = Date.now();
    const list = (recent.get(channel.id) || []).filter((entry) => now - entry.at <= BUSY_WINDOW_MS);
    list.push({ at: now, authorId: message.author.id });
    recent.set(channel.id, list);
    if (list.length < BUSY_MESSAGES || new Set(list.map((entry) => entry.authorId)).size < BUSY_AUTHORS) return;

    try {
        if (await isChannelExempt(message.guildId, channel)) return;
    } catch (error) {
        if (!isSettingsUnavailable(error)) throw error;
        noteSettingsUnavailable(message.guildId, 'auto slowmode');
        return;
    }

    const started = await startSlowmode(channel, { reason: 'Automod: channel flooded' });
    if (started === 'extended') return;
    recent.delete(channel.id);
    if (started !== 'started') return;
    await channel.send({ content: `Slowmode is on for a few minutes because this channel got very busy (${SLOWMODE_SECONDS}s between messages).` }).catch(() => {});
    const fields = [
        { name: 'Channel', value: `<#${channel.id}>` },
        { name: 'Why', value: `${list.length} messages from ${new Set(list.map((e) => e.authorId)).size} people in ${BUSY_WINDOW_MS / 1000}s` },
        { name: 'Ends', value: `after ${CALM_MS / 60000} quiet minutes` },
    ];
    void logAutomod(message.client, message.guildId, { type: 'slowmode', title: 'Automod: auto slowmode on', fields, channelId: channel.id });
    await postModLog(message.client, 'slowmode', fields, { guildId: message.guildId, title: 'Auto slowmode on' });
}

/**
 * Turns the bot's slowmode on in a channel (or keeps it on). Returns 'started' when it
 * was just set, 'extended' when the bot's slowmode was already on (the calm timer
 * restarts), or null when nothing was done (a thread, a moderator's own slowmode, or
 * Discord refused). `reason` goes to the audit log and the stored state. Lifted by
 * liftCalmSlowmodes after CALM_MS without another call.
 */
export async function startSlowmode(channel, { reason = 'Automod: channel flooded' } = {}) {
    if (typeof channel?.setRateLimitPerUser !== 'function' || channel.isThread?.()) return null;
    const guildId = channel.guild?.id || channel.guildId;
    if (!guildId) return null;
    const now = Date.now();
    const state = await loadGuild(guildId);
    const existing = state.get(channel.id);
    if (existing) {
        existing.lastBusy = now;
        return 'extended';
    }
    if (channel.rateLimitPerUser > 0) {
        if (!state.size) active.delete(guildId);
        return null; // a moderator already set slowmode; leave it alone
    }

    const ok = await channel.setRateLimitPerUser(SLOWMODE_SECONDS, reason).then(() => true).catch((error) => {
        logger.warn(`Auto slowmode in ${channel.id} failed: ${error.message}`);
        return false;
    });
    if (!ok) {
        if (!state.size) active.delete(guildId);
        return null;
    }
    state.set(channel.id, { guildId, since: now, lastBusy: now, reason });
    await saveGuild(guildId);
    return 'started';
}

export const AUTO_SLOWMODE_SECONDS = SLOWMODE_SECONDS;
export const AUTO_SLOWMODE_CALM_MS = CALM_MS;

/** Lifts slowmode the bot set once the channel has been calm; run every minute. */
export async function liftCalmSlowmodes(client) {
    await discover();
    if (!active.size) return;
    const now = Date.now();
    for (const [guildId, state] of [...active]) {
        let changed = false;
        for (const [channelId, entry] of state) {
            if (now - entry.lastBusy < CALM_MS) continue;
            const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
            // Only undo our own value; a moderator may have changed it meanwhile.
            if (channel && channel.rateLimitPerUser === SLOWMODE_SECONDS) {
                await channel.setRateLimitPerUser(0, 'Automod: channel calm again').catch(() => {});
            }
            state.delete(channelId);
            changed = true;
        }
        if (changed) await saveGuild(guildId);
        else if (!state.size) active.delete(guildId);
    }
}
