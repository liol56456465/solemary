// inviteCache.js — per server, the invite uses Mewvo last saw (memory), so a join can be matched
// to the code whose use count went up (inviteTracker.js).
//
// State per server (BoundedMap guildId → state):
//   codes   Map code → { uses, inviterId, maxUses, expiresAt, deletedAt? }
//   vanity  { code, uses } | null
//   status  'ready' | 'no_permission' (Mewvo lacks Manage Server: no cache, joins are recorded
//           with source no_permission and the dashboard warns)
// Filled from guild.invites.fetch() + guild.fetchVanityData() (both need Manage Server), kept
// current by inviteCreate / inviteDelete. A deleted code stays in the cache for DELETED_KEEP_MS,
// marked deletedAt: Discord can send inviteDelete for a used-up invite before the join that used
// it, and the join must still find it ([I5]).
//
// Startup warm-up: only servers with the feature on, 250 ms apart, at most 3 at once
// (multi-server B5 pacing). guildCreate warms, guildDelete drops (memory only).
// The persisted copy is invite_tracking (inviteStore.saveCodes; best effort, logged).

import { PermissionFlagsBits } from 'discord.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { logger } from '../../utils/logger.js';
import { inviteTrackingOn } from './inviteStats.js';
import { markCodeDeleted, saveCode, saveCodes } from './inviteStore.js';

export const MAX_CACHED_GUILDS = 5000;
export const DELETED_KEEP_MS = 60_000;
export const WARM_PAUSE_MS = 250;
export const WARM_CONCURRENCY = 3;

const states = new BoundedMap(MAX_CACHED_GUILDS);

/** True when Mewvo may read the server's invites (Manage Server). */
export function canReadInvites(guild) {
    return Boolean(guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

/** A discord.js Invite → the cache entry; pure. */
export function inviteEntry(invite) {
    return {
        uses: Math.max(0, Number(invite?.uses) || 0),
        inviterId: invite?.inviterId || invite?.inviter?.id || null,
        maxUses: Math.max(0, Number(invite?.maxUses) || 0),
        expiresAt: Number.isFinite(invite?.expiresTimestamp) ? invite.expiresTimestamp : null,
    };
}

/** True when the server can have a vanity URL (fetchVanityData throws otherwise). */
function hasVanity(guild) {
    return Boolean(guild?.vanityURLCode) || Boolean(guild?.features?.includes?.('VANITY_URL'));
}

/**
 * The server's invites right now: { codes: Map, vanity }. Throws on a Discord error;
 * error.code 50013 (Missing Permissions) means Manage Server is gone.
 */
export async function fetchSnapshot(guild) {
    const invites = await guild.invites.fetch({ cache: false });
    const codes = new Map();
    for (const invite of invites.values()) codes.set(invite.code, inviteEntry(invite));
    let vanity = null;
    if (hasVanity(guild)) {
        try {
            const data = await guild.fetchVanityData();
            if (data?.code) vanity = { code: data.code, uses: Math.max(0, Number(data.uses) || 0) };
        } catch (error) {
            logger.debug(`Vanity data of guild ${guild.id} not read: ${error.message}`);
        }
    }
    return { codes, vanity };
}

export function getInviteState(guildId) {
    return states.get(String(guildId)) || null;
}

export function setInviteState(guildId, state) {
    states.set(String(guildId), state);
}

export function dropInviteCache(guildId) {
    states.delete(String(guildId));
}

export function resetInviteCacheForTests() {
    states.clear();
}

function isMissingPermission(error) {
    return Number(error?.code) === 50013 || Number(error?.status) === 403;
}

/** The persisted copy of a snapshot (logged, never thrown: the cache works without it). */
async function persistSnapshot(guildId, snapshot, deps) {
    const save = deps.saveCodes || saveCodes;
    try {
        await save(guildId, [...snapshot.codes].map(([code, e]) => ({ code, ...e })));
    } catch (error) {
        logger.warn(`Invite codes of guild ${guildId} not saved: ${error.message}`);
    }
}

/**
 * Loads one server's cache. Returns 'ready' | 'no_permission' | 'error'. Never throws.
 * deps (tests): fetch(guild) → snapshot, saveCodes, now.
 */
export async function warmGuild(guild, deps = {}) {
    const { fetch = fetchSnapshot, now = Date.now() } = deps;
    if (!guild?.id) return 'error';
    if (!canReadInvites(guild)) {
        setInviteState(guild.id, { status: 'no_permission', codes: new Map(), vanity: null, loadedAt: now });
        return 'no_permission';
    }
    try {
        const snapshot = await fetch(guild);
        setInviteState(guild.id, { status: 'ready', codes: snapshot.codes, vanity: snapshot.vanity, loadedAt: now });
        await persistSnapshot(guild.id, snapshot, deps);
        return 'ready';
    } catch (error) {
        if (isMissingPermission(error)) {
            setInviteState(guild.id, { status: 'no_permission', codes: new Map(), vanity: null, loadedAt: now });
            return 'no_permission';
        }
        dropInviteCache(guild.id);
        logger.warn(`Invite cache of guild ${guild.id} not loaded: ${error.message}`);
        return 'error';
    }
}

const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
});

/**
 * Warms every server the bot is in that has invite tracking on: one start every `pauseMs`,
 * at most `concurrency` loads at once. Returns { servers, ready, noPermission, errors }.
 * deps (tests): isOn(guildId), warm(guild), sleepFn, pauseMs, concurrency.
 */
export function warmAllInviteCaches(client, deps = {}) {
    const run = warmAll(client, deps);
    lastWarmUp = run.catch(() => null);
    return run;
}

// The latest warm-up (settled, never rejects): the leave reconcile (inviteReconcile.js) waits for it.
let lastWarmUp = Promise.resolve(null);

/** Resolves once the latest warm-up has finished (success or not). */
export function inviteWarmUpSettled() {
    return lastWarmUp;
}

async function warmAll(client, deps) {
    const {
        isOn = (id) => inviteTrackingOn(id), warm = (guild) => warmGuild(guild), sleepFn = sleep,
        pauseMs = WARM_PAUSE_MS, concurrency = WARM_CONCURRENCY,
    } = deps;
    const guilds = [...(client?.guilds?.cache?.values?.() || [])].filter((g) => isOn(g.id));
    const totals = { servers: guilds.length, ready: 0, noPermission: 0, errors: 0 };
    const running = new Set();
    for (const [index, guild] of guilds.entries()) {
        if (index > 0) await sleepFn(pauseMs);
        while (running.size >= concurrency) await Promise.race(running);
        const task = Promise.resolve()
            .then(() => warm(guild))
            .then((status) => {
                if (status === 'ready') totals.ready += 1;
                else if (status === 'no_permission') totals.noPermission += 1;
                else totals.errors += 1;
            }, () => { totals.errors += 1; })
            .finally(() => running.delete(task));
        running.add(task);
    }
    await Promise.all(running);
    return totals;
}

/** inviteCreate: the new code starts at its uses (0). Only for servers whose cache is loaded. */
export async function noteInviteCreate(invite, deps = {}) {
    const guildId = invite?.guild?.id;
    if (!guildId || !invite.code) return false;
    const state = getInviteState(guildId);
    if (!state || state.status !== 'ready') return false;
    const entry = inviteEntry(invite);
    state.codes.set(invite.code, entry);
    try {
        await (deps.saveCode || saveCode)(guildId, { code: invite.code, ...entry });
    } catch (error) {
        logger.warn(`Invite code of guild ${guildId} not saved: ${error.message}`);
    }
    return true;
}

/** inviteDelete: kept for a minute, marked deleted (see the header). */
export async function noteInviteDelete(invite, deps = {}) {
    const { now = Date.now() } = deps;
    const guildId = invite?.guild?.id;
    if (!guildId || !invite.code) return false;
    const state = getInviteState(guildId);
    if (state?.status === 'ready') {
        const entry = state.codes.get(invite.code);
        if (entry) entry.deletedAt = now;
    }
    if (!inviteTrackingOn(guildId, deps)) return Boolean(state);
    try {
        await (deps.markCodeDeleted || markCodeDeleted)(guildId, invite.code);
    } catch (error) {
        logger.warn(`Deleted invite code of guild ${guildId} not marked: ${error.message}`);
    }
    return true;
}

/** Drops deleted codes older than DELETED_KEEP_MS; pure on the state object. */
export function pruneDeleted(state, now = Date.now()) {
    for (const [code, entry] of state.codes) {
        if (entry.deletedAt && now - entry.deletedAt > DELETED_KEEP_MS) state.codes.delete(code);
    }
}
