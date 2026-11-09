// inviteTracker.js — which invite a new member used ("attribution"), recorded in invite_joins.
//
// How: the cache (inviteCache.js) holds the uses Mewvo last saw; on a join Mewvo fetches the
// invites again and compares (diffInvites, pure):
//   one code went up                       → that code (source 'invite'; 'widget' when it has no
//                                            creator and the server widget is on)
//   two or more went up (or vanity + code) → 'ambiguous' (nothing is guessed)
//   the vanity URL went up                 → 'vanity'
//   nothing went up, a code vanished whose last uses were max-1 (used up, Discord deleted it;
//   inviteDelete may even arrive first, but at most USED_UP_WINDOW_MS before)
//                                          → that code; two such codes → 'ambiguous'
//   nothing at all                         → 'discovery' (server is DISCOVERABLE), else 'widget'
//                                            (widget on), else 'unknown'
// Before any fetch: Mewvo's own OAuth re-add (expectedAdds.js) → 'bot'; cache not loaded yet →
// 'not_ready' (and it starts loading); no Manage Server → 'no_permission'.
//
// Joins of one server are serialized (utils/mutex.js, key invites:<guildId>) and batched in a
// BATCH_WINDOW_MS window, so a burst of joins costs one invite fetch. Within a batch each join
// takes ONE use (consume +1): if a code went up by 2 for one join seen so far, the second use
// stays "pending" for the next join (its event may come a little later); a pending use nobody
// claims within PENDING_MS is dropped.
//
// startInviteAttribution(member) runs all of that and writes the join row; guildMemberAdd awaits
// it for at most 3 s (awaitAttribution) for the welcome message and the join log. It never
// rejects; null = the feature is off here (or the member is a bot).

import { Mutex } from '../../utils/mutex.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { logger } from '../../utils/logger.js';
import { noteSettingsUnavailable } from '../settings/guildScoped.js';
import { isEnforcementDbAvailable } from '../enforcement/db.js';
import { takeExpectedBotAdd } from './expectedAdds.js';
import {
    canReadInvites, fetchSnapshot, getInviteState, pruneDeleted, setInviteState, warmGuild,
} from './inviteCache.js';
import { forgetLeaderboard, inviteCounts, inviteSettings, isFakeJoin } from './inviteStats.js';
import { insertJoin, saveCode, stampLeft } from './inviteStore.js';
import { applyMilestoneRoles } from './inviteRoles.js';

export const BATCH_WINDOW_MS = 1000;
export const PENDING_MS = 10_000;
export const USED_UP_WINDOW_MS = 15_000;
export const ATTRIBUTION_TIMEOUT_MS = 3000;
export const SOURCES = Object.freeze(['invite', 'vanity', 'widget', 'discovery', 'bot', 'ambiguous', 'unknown', 'not_ready', 'no_permission']);
const DAY_MS = 86_400_000;

const result = (source, code = null, inviterId = null) => ({ source, code, inviterId });

/**
 * The pure attribution rule (see the header). before / after: Map code → { uses, inviterId,
 * maxUses, expiresAt }; vanity: { before, after } each { code, uses } | null; features:
 * { discoverable, widgetEnabled, now }. Returns { source, code, inviterId }.
 */
export function diffInvites(before, after, vanity = {}, features = {}) {
    const now = features.now ?? Date.now();
    const up = [];
    for (const [code, entry] of after) {
        const prev = before.get(code);
        if ((entry?.uses ?? 0) > (prev?.uses ?? 0)) up.push(code);
    }
    const vb = vanity.before;
    const va = vanity.after;
    const vanityUp = Boolean(va && vb && va.code === vb.code && va.uses > vb.uses);
    if (up.length + (vanityUp ? 1 : 0) >= 2) return result('ambiguous');
    if (up.length === 1) {
        const entry = after.get(up[0]);
        if (!entry?.inviterId && features.widgetEnabled) return result('widget', up[0]);
        return result('invite', up[0], entry?.inviterId || null);
    }
    if (vanityUp) return result('vanity', va.code);
    const usedUp = [];
    for (const [code, prev] of before) {
        if (after.has(code)) continue;
        const expired = Number.isFinite(prev?.expiresAt) && prev.expiresAt <= now;
        // Deleted a while ago: staff deleted it (a used-up invite goes at the moment of the join).
        const stale = Number.isFinite(prev?.deletedAt) && now - prev.deletedAt > USED_UP_WINDOW_MS;
        if (prev?.maxUses > 0 && prev.uses === prev.maxUses - 1 && !expired && !stale) usedUp.push(code);
    }
    if (usedUp.length >= 2) return result('ambiguous');
    if (usedUp.length === 1) return result('invite', usedUp[0], before.get(usedUp[0])?.inviterId || null);
    if (features.discoverable) return result('discovery');
    if (features.widgetEnabled) return result('widget');
    return result('unknown');
}

/** Takes the one use a join consumed out of the cache state (mutates state). */
export function consumeUse(state, attribution, after, vanityAfter) {
    const { source, code } = attribution;
    if ((source === 'invite' || source === 'widget') && code) {
        const fresh = after.get(code);
        if (!fresh) {
            state.codes.delete(code); // used up and gone
            return;
        }
        const current = state.codes.get(code);
        state.codes.set(code, { ...(current || fresh), ...fresh, uses: Math.min(fresh.uses, (current?.uses ?? 0) + 1), pendingSince: current?.pendingSince, seenUses: current?.seenUses });
    } else if (source === 'vanity' && vanityAfter && state.vanity) {
        state.vanity = { ...state.vanity, uses: Math.min(vanityAfter.uses, state.vanity.uses + 1) };
    }
}

/**
 * After a batch: the cache follows the fetch, except uses not claimed yet (kept pending, at most
 * PENDING_MS); vanished codes are kept as deleted for a minute (inviteCache DELETED_KEEP_MS).
 */
export function finalizeState(state, after, vanityAfter, now = Date.now()) {
    for (const [code, fresh] of after) {
        const current = state.codes.get(code);
        if (current && current.uses < fresh.uses) {
            state.codes.set(code, { ...fresh, uses: current.uses, seenUses: fresh.uses, pendingSince: current.pendingSince ?? now });
        } else {
            state.codes.set(code, { ...fresh });
        }
    }
    for (const [code, entry] of state.codes) if (!after.has(code) && !entry.deletedAt) entry.deletedAt = now;
    if (vanityAfter && state.vanity && state.vanity.code === vanityAfter.code && state.vanity.uses < vanityAfter.uses) {
        state.vanity = { ...vanityAfter, uses: state.vanity.uses, seenUses: vanityAfter.uses, pendingSince: state.vanity.pendingSince ?? now };
    } else {
        state.vanity = vanityAfter ? { ...vanityAfter } : null;
    }
    pruneDeleted(state, now);
}

/** Pending uses nobody claimed within PENDING_MS are dropped (mutates state). */
export function expirePending(state, now = Date.now()) {
    for (const entry of state.codes.values()) {
        if (Number.isFinite(entry.pendingSince) && now - entry.pendingSince > PENDING_MS) {
            entry.uses = entry.seenUses ?? entry.uses;
            delete entry.pendingSince;
            delete entry.seenUses;
        }
    }
    if (Number.isFinite(state.vanity?.pendingSince) && now - state.vanity.pendingSince > PENDING_MS) {
        state.vanity = { code: state.vanity.code, uses: state.vanity.seenUses ?? state.vanity.uses };
    }
}

function guildFeatures(guild, now) {
    return {
        discoverable: Boolean(guild?.features?.includes?.('DISCOVERABLE')),
        widgetEnabled: Boolean(guild?.widgetEnabled),
        now,
    };
}

function isMissingPermission(error) {
    return Number(error?.code) === 50013 || Number(error?.status) === 403;
}

/**
 * Attributes a batch of joins of one server (already serialized): one fetch, then each join in
 * order. Returns one { source, code, inviterId } per member. deps: fetch(guild), now().
 */
export async function attributeBatch(guild, members, deps = {}) {
    const { fetch = fetchSnapshot, now = () => Date.now() } = deps;
    const state = getInviteState(guild.id);
    if (!state || state.status !== 'ready') {
        return members.map(() => result(state?.status === 'no_permission' ? 'no_permission' : 'not_ready'));
    }
    let snapshot;
    try {
        snapshot = await fetch(guild);
    } catch (error) {
        if (isMissingPermission(error)) {
            setInviteState(guild.id, { status: 'no_permission', codes: new Map(), vanity: null, loadedAt: now() });
            return members.map(() => result('no_permission'));
        }
        logger.warn(`Invites of guild ${guild.id} not fetched for ${members.length} join(s): ${error.message}`);
        return members.map(() => result('unknown'));
    }
    const at = now();
    expirePending(state, at);
    const features = guildFeatures(guild, at);
    const out = [];
    for (let i = 0; i < members.length; i += 1) {
        const attribution = diffInvites(state.codes, snapshot.codes, { before: state.vanity, after: snapshot.vanity }, features);
        consumeUse(state, attribution, snapshot.codes, snapshot.vanity);
        out.push(attribution);
    }
    finalizeState(state, snapshot.codes, snapshot.vanity, at);
    return out;
}

// ── batching ──────────────────────────────────────────────────────────────

const batches = new Map(); // guildId → { guild, joins: [{ member, resolve }] } (each flushes within BATCH_WINDOW_MS)

/** Queues a join for its server's next batch; resolves with { source, code, inviterId }. */
export function queueJoin(member, deps = {}) {
    const { windowMs = BATCH_WINDOW_MS, schedule = setTimeout } = deps;
    const guild = member.guild;
    let batch = batches.get(guild.id);
    if (!batch) {
        batch = { guild, joins: [] };
        batches.set(guild.id, batch);
        const timer = schedule(() => { void flushBatch(guild.id, deps); }, windowMs);
        timer?.unref?.();
    }
    return new Promise((resolve) => batch.joins.push({ member, resolve }));
}

/** Runs one server's queued batch (serialized per server). */
export async function flushBatch(guildId, deps = {}) {
    const batch = batches.get(guildId);
    if (!batch) return;
    batches.delete(guildId);
    const members = batch.joins.map((j) => j.member);
    let results;
    try {
        results = await Mutex.runExclusive(`invites:${guildId}`, () => attributeBatch(batch.guild, members, deps));
    } catch (error) {
        logger.warn(`Invite attribution failed in guild ${guildId}: ${error.message}`);
        results = members.map(() => result('unknown'));
    }
    batch.joins.forEach((join, i) => join.resolve(results[i] || result('unknown')));
}

export function resetInviteTrackerForTests() {
    batches.clear();
}

// ── the join pipeline ─────────────────────────────────────────────────────

function accountAgeDays(user, joinedAt) {
    const created = user?.createdTimestamp;
    if (!Number.isFinite(created)) return null;
    return Math.max(0, Math.floor((joinedAt - created) / DAY_MS));
}

/** Where the join came from before any fetch, or null to fetch. Starts loading a missing cache. */
function preCheck(member, deps) {
    const guild = member.guild;
    if ((deps.takeBotAdd || takeExpectedBotAdd)(guild.id, member.id)) return result('bot');
    const state = getInviteState(guild.id);
    if (!canReadInvites(guild)) {
        if (state?.status !== 'no_permission') setInviteState(guild.id, { status: 'no_permission', codes: new Map(), vanity: null, loadedAt: Date.now() });
        return result('no_permission');
    }
    if (!state || state.status !== 'ready') {
        // Not loaded (feature just turned on, restart warm-up still running, or Manage Server was
        // granted since): load it now in the background (once: 'loading'); this join can't be matched.
        if (state?.status !== 'loading') {
            setInviteState(guild.id, { status: 'loading', codes: new Map(), vanity: null, loadedAt: Date.now() });
            void Mutex.runExclusive(`invites:${guild.id}`, () => (deps.warm || warmGuild)(guild)).catch(() => {});
        }
        return result('not_ready');
    }
    return null;
}

/**
 * Attributes and records one join. Resolves with
 * { source, code, inviterId, inviterName, inviterInvites, accountAgeDays, fakeAccount, counted, recorded }
 * or null (feature off, a bot, or the settings could not be read). Never rejects.
 * deps (tests): settings, attribute(member), insert, counts, milestones, fetchMember, dbAvailable, now.
 */
export async function attributeJoin(member, deps = {}) {
    try {
        const user = member?.user;
        if (!member?.guild?.id || !user || user.bot) return null;
        let settings;
        try {
            settings = deps.settings || inviteSettings(member.guild.id);
        } catch {
            noteSettingsUnavailable(member.guild.id, 'invite tracking');
            return null;
        }
        if (!settings.enabled) return null;
        const joinedAt = deps.now ? deps.now() : (Number.isFinite(member.joinedTimestamp) ? member.joinedTimestamp : Date.now());

        const attribution = preCheck(member, deps) || await (deps.attribute || queueJoin)(member, deps);
        const ageDays = accountAgeDays(user, joinedAt);
        const out = {
            ...attribution,
            inviterName: null,
            inviterInvites: null,
            accountAgeDays: ageDays,
            fakeAccount: isFakeJoin({ accountCreatedAt: user.createdTimestamp ?? null, joinedAt }, settings),
            counted: true,
            recorded: false,
        };

        const dbAvailable = deps.dbAvailable || isEnforcementDbAvailable;
        if (!dbAvailable()) {
            logger.warn(`Join of ${member.id} in guild ${member.guild.id} not recorded for invite tracking: database not available`);
        } else {
            try {
                const row = await (deps.insert || insertJoin)({
                    guildId: member.guild.id, userId: member.id, inviterId: out.inviterId, code: out.code, source: out.source,
                    accountCreatedAt: Number.isFinite(user.createdTimestamp) ? new Date(user.createdTimestamp) : null,
                    joinedAt: new Date(joinedAt), serverResetAt: settings.resetAt,
                });
                out.counted = row.counted;
                out.recorded = true;
                forgetLeaderboard(member.guild.id);
            } catch (error) {
                logger.warn(`Join of ${member.id} in guild ${member.guild.id} not recorded for invite tracking: ${error.message}`);
            }
        }

        if (out.inviterId) {
            const inviter = await (deps.fetchMember || ((id) => member.guild.members.fetch(id)))(out.inviterId).catch(() => null);
            out.inviterName = inviter?.user?.username || null;
            if (out.recorded) {
                try {
                    const counts = await (deps.counts || inviteCounts)(member.guild.id, out.inviterId, settings);
                    out.inviterInvites = counts.total;
                    if (inviter && settings.milestones.length) {
                        void (deps.milestones || applyMilestoneRoles)(member.guild, inviter, counts.total, settings)
                            .catch((error) => logger.warn(`Invite milestone roles not given in guild ${member.guild.id}: ${error.message}`));
                    }
                } catch (error) {
                    logger.warn(`Invite count of ${out.inviterId} in guild ${member.guild.id} not read: ${error.message}`);
                }
            }
        }
        // The code's new use count in the stored copy (best effort; the cache already has it).
        if (out.recorded && out.code && out.source === 'invite') {
            const entry = getInviteState(member.guild.id)?.codes?.get(out.code);
            if (entry) void (deps.saveCode || saveCode)(member.guild.id, { code: out.code, ...entry }).catch(() => {});
        }
        return out;
    } catch (error) {
        logger.warn(`Invite tracking failed for a join in guild ${member?.guild?.id}: ${error.message}`);
        return null;
    }
}

/** attributeJoin started early in guildMemberAdd (not awaited yet). */
// Attributions still running (their row is not written yet), so a member who leaves within the
// first seconds (or is kicked by the join gate) gets left_at on that row, not on nothing.
const inFlight = new BoundedMap(5000); // `${guildId}:${userId}` → promise

export function startInviteAttribution(member, deps = {}) {
    const key = `${member?.guild?.id}:${member?.id}`;
    const promise = attributeJoin(member, deps);
    inFlight.set(key, promise);
    promise.finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
    return promise;
}

/**
 * Waits for an attribution at most `timeoutMs` (3 s): after that the welcome and the join log go
 * out with source 'unknown' (the row is still written when the attribution finishes).
 */
export async function awaitAttribution(promise, timeoutMs = ATTRIBUTION_TIMEOUT_MS) {
    if (!promise) return null;
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ...result('unknown'), timedOut: true, inviterName: null, inviterInvites: null, accountAgeDays: null, fakeAccount: false }), timeoutMs);
        timer.unref?.();
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The member left: stamps left_at on their open join row and returns it (for the leave log), or
 * null. At most `timeoutMs`; never rejects. Runs whether or not the feature is on now, so a join
 * recorded while it was on gets its leave time (counts and the 365-day retention need it).
 */
export async function noteMemberLeft(member, { timeoutMs = 2000, stamp = stampLeft, dbAvailable = isEnforcementDbAvailable } = {}) {
    const guildId = member?.guild?.id;
    const userId = member?.user?.id ?? member?.id;
    if (!guildId || !userId || member?.user?.bot || !dbAvailable()) return null;
    const leftAt = new Date();
    // A join still being recorded: wait for its row first (the stamp still lands after the timeout).
    const pending = inFlight.get(`${guildId}:${userId}`) || Promise.resolve();
    let timer;
    try {
        return await Promise.race([
            pending.catch(() => null).then(() => stamp(guildId, userId, leftAt)).then((row) => {
                if (row) forgetLeaderboard(guildId);
                return row;
            }),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), timeoutMs);
                timer.unref?.();
            }),
        ]);
    } catch (error) {
        logger.warn(`Leave of ${userId} in guild ${guildId} not stamped for invite tracking: ${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── log lines (English, like the rest of the join / leave log) ────────────

const SOURCE_TEXT = {
    vanity: 'the vanity URL',
    widget: 'the server widget',
    discovery: 'Server Discovery',
    bot: 'Mewvo (Verify with Discord re-add)',
    ambiguous: 'one of several invites (could not tell which)',
    unknown: 'unknown',
    not_ready: 'unknown (invite list was still loading)',
    no_permission: 'unknown (Mewvo needs Manage Server to track invites)',
};

/** An invite code safe inside `backticks` (codes are letters, digits and dashes). */
export function safeCode(code) {
    return String(code || '').replace(/[^\w-]/g, '').slice(0, 32);
}

/** "@x (`code`)" / "the vanity URL (`code`)" / "Server Discovery" …; pure. */
export function describeSource({ source, code, inviterId } = {}) {
    const c = safeCode(code);
    if (source === 'invite' || (source === 'widget' && inviterId)) {
        if (inviterId) return `<@${inviterId}>${c ? ` (\`${c}\`)` : ''}`;
        return c ? `invite \`${c}\`` : 'an invite';
    }
    const text = SOURCE_TEXT[source] || SOURCE_TEXT.unknown;
    return c && (source === 'vanity' || source === 'widget') ? `${text} (\`${c}\`)` : text;
}

/** The join log lines of an attribution (none when the feature is off). */
export function joinLogLines(attribution) {
    if (!attribution) return [];
    const lines = [];
    const via = describeSource(attribution);
    lines.push(attribution.source === 'invite' && attribution.inviterId ? `**Invited by:** ${via}` : `**Joined via:** ${via}`);
    if (attribution.source === 'invite' && attribution.inviterId && attribution.counted === false) lines.push('**Invite count:** not counted again (rejoined through the same inviter)');
    if (Number.isFinite(attribution.accountAgeDays)) {
        lines.push(`**Account:** ${attribution.accountAgeDays} day${attribution.accountAgeDays === 1 ? '' : 's'} old${attribution.fakeAccount ? ' (new account: counts as fake)' : ''}`);
    }
    return lines;
}

/** The leave log line ("Joined via"), or [] without a join row. */
export function leaveLogLines(row) {
    if (!row) return [];
    return [`**Joined via:** ${describeSource(row)}`];
}
