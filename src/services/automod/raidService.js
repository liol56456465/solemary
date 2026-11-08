// raidService.js — join-raid detection and lockdown, per server.
//
// Multi-server (B1): the main server is watched as before (whatever /automod enable says);
// any other server only while its automod is on (off by default, automodSettings.js).
//
// When raidJoins members join within raidWindowMs, the server goes into lockdown:
// the verification level is raised to High, admins are alerted (alerts channel + owner DM),
// and everyone who joined in the raid window or during the lockdown is remembered.
// Nobody is kicked for joining; a raid joiner who then breaks a rule is kicked
// (see automodService). An administrator ends the lockdown with /automod lockdown-end,
// which restores the previous verification level and posts an incident report
// (raidIncidentService.js) with a "Release non-offenders" button.
//
// Panic mode (/automod panic, on by default): the lockdown also pauses invites and
// DMs with Discord's incident actions for a few hours (default 2, at most 24); the
// pause is lifted when the lockdown ends. Without Manage Server the pause is skipped
// and the alert says so.
//
// Manual lockdown ("Lock down (panic)" on a nuke alert, startManualLockdown): the same lockdown
// started by an Administrator, with the invite/DM pause even when panic mode is off (the button
// asks for it). /automod lockdown-end lifts it as usual. No raid timeline (no join raid).
//
// Raid timeline (incidentTimeline.js): once the protective steps ran, the lockdown opens
// an incident (its id is kept in the lockdown state as timelineId) and records what it
// did; noteIncidentEvent lets other code (join gate, automod, mass-action guard) add to
// the running incident. Recording never throws and never delays a protective step.

import { GuildVerificationLevel } from 'discord.js';
import { automodConfig } from '../../config/automod.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { Mutex } from '../../utils/mutex.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { getAutomodSettings, getLockdown, isLegacyAutomodGuild, setLockdown } from './automodSettings.js';
import { describePanic, pauseInvitesAndDms, resumeInvitesAndDms } from './incidentActions.js';
import { postAlert } from './alertPost.js';
import { staffGuildId } from './channelRouting.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { buildIncidentReport, casesAgainst, recordIncident, releaseRow } from './raidIncidentService.js';
import { recordEvent } from './reviewRegistry.js';
import { addTimelineEvent, closeTimeline, linkTimelineReport, openTimeline } from './incidentTimeline.js';

// Bounded for any server count: a dropped lockdown entry is re-read from the database (it is
// saved there first); a dropped join list only restarts that server's raid window.
export const RAID_STATE_MAX = 5000;
const recentJoins = new BoundedMap(RAID_STATE_MAX); // guildId → [{ at, userId }]
const lockdownCache = new BoundedMap(RAID_STATE_MAX); // guildId → state | null
const MAX_TRACKED_JOINERS = 1000;

async function loadLockdown(guildId) {
    if (!lockdownCache.has(guildId)) {
        // Only a successful read is cached; a failure throws and is retried next time,
        // so a database blip can't hide an active lockdown.
        lockdownCache.set(guildId, await getLockdown(guildId));
    }
    return lockdownCache.get(guildId);
}

async function saveLockdown(guildId, state) {
    lockdownCache.set(guildId, state);
    await setLockdown(guildId, state);
}

export async function isLockdownActive(guildId) {
    return Boolean((await loadLockdown(guildId))?.active);
}

export async function isRaidJoiner(guildId, userId) {
    const state = await loadLockdown(guildId);
    return Boolean(state?.active && state.joinerIds?.includes(userId));
}

async function alertOwner(guild, text) {
    const owner = await guild.fetchOwner().catch(() => null);
    await owner?.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

async function startLockdown(guild, joinerIds, { forcePanic = false, reason = 'Automod: join raid detected' } = {}) {
    const previous = guild.verificationLevel;
    // Save the lockdown before any slow call, so joins arriving meanwhile add to
    // it instead of starting a second one that forgets the original level.
    const state = {
        active: true,
        startedAt: new Date().toISOString(),
        previousVerificationLevel: previous,
        raisedVerification: false,
        joinerIds,
    };
    await saveLockdown(guild.id, state);

    let raised = false;
    if (previous < GuildVerificationLevel.High) {
        raised = await guild.setVerificationLevel(GuildVerificationLevel.High, reason.slice(0, 512))
            .then(() => true)
            .catch((error) => {
                logger.warn(`Lockdown could not raise the verification level: ${error.message}`);
                return false;
            });
    }

    const verifiedAt = new Date();

    const settings = await getAutomodSettings(guild.id).catch(() => null);
    const panic = settings?.panic?.enabled === false && !forcePanic ? null : await pauseInvitesAndDms(guild, settings?.panic?.hours);
    const pausedAt = new Date();

    if (raised || panic) {
        const current = await loadLockdown(guild.id);
        await saveLockdown(guild.id, {
            ...(current?.active ? current : state),
            raisedVerification: raised,
            incidentActions: panic,
        });
    }

    recordEvent('raid', Date.now(), guild.id);
    logger.warn(`Join raid in ${guild.id}: ${joinerIds.length} joins within ${automodConfig.raidWindowMs / 1000}s. Lockdown started.`);
    return {
        joinerCount: joinerIds.length, raised, panic,
        timeline: { startedAt: state.startedAt, previous, verifiedAt, pausedAt },
    };
}

/** The panic result as one plain line for the timeline (no Discord markup). */
export function panicDetail(result) {
    if (!result) return 'Not paused: panic mode is off';
    if (result.applied) return `Paused until ${new Date(result.until).toISOString().slice(11, 16)} UTC`;
    if (result.reason === 'missing Manage Server') return 'Not paused: the bot needs the Manage Server permission';
    return `Not paused: ${String(result.reason || 'Discord refused')}`;
}

async function recordStartEvents(timelineId, { startedAt, joinerCount, previous, raised, verifiedAt, panic, pausedAt }) {
    await addTimelineEvent(timelineId, {
        at: startedAt, kind: 'lockdown_start',
        detail: `${joinerCount} accounts joined within ${automodConfig.raidWindowMs / 1000} seconds`,
    });
    await addTimelineEvent(timelineId, {
        at: verifiedAt, kind: 'verification',
        detail: raised ? 'Raised to High' : previous >= GuildVerificationLevel.High ? 'Not changed: already High or higher' : 'Not changed: the bot could not raise it',
    });
    await addTimelineEvent(timelineId, { at: pausedAt, kind: 'panic', detail: panicDetail(panic) });
}

/**
 * Adds an event to the running incident of this guild (raid timeline). Resolves 'inactive'
 * when there is none; never throws. event: { kind, actorId, targetId, detail }.
 */
export async function noteIncidentEvent(guildId, event) {
    const at = event?.at || new Date();
    try {
        const state = await loadLockdown(guildId);
        if (!state?.active || !state.timelineId) return 'inactive';
        return await addTimelineEvent(state.timelineId, { ...event, at });
    } catch (error) {
        logger.warn(`Raid timeline: could not check for a running incident in ${guildId}: ${error.message}`);
        return 'failed';
    }
}

/** The mod-log post of a lockdown that started, in `lang` (the staff server's). Pure, for tests. */
export function lockdownAnnouncement({ joinerCount, raised, panic, startedBy = null }, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const summary = startedBy
        ? tr.t('automod.raid.lockdown.startedBy', { name: startedBy.username, id: startedBy.id })
        : tr.t('automod.raid.lockdown.joined', { count: joinerCount, seconds: automodConfig.raidWindowMs / 1000 });
    return {
        summary,
        title: startedBy ? tr.t('automod.raid.lockdown.titleManual') : tr.t('automod.raid.lockdown.titleRaid'),
        fields: [
            { name: tr.t('automod.raid.lockdown.whatHappened'), value: summary },
            { name: tr.t('automod.raid.lockdown.verification'), value: raised ? tr.t('automod.raid.lockdown.raised') : tr.t('automod.raid.lockdown.notRaised') },
            { name: tr.t('automod.raid.lockdown.invites'), value: describePanic(panic, { lang }) },
            { name: tr.t('automod.raid.lockdown.joiners'), value: tr.t('automod.raid.lockdown.joinersValue') },
            { name: tr.t('automod.raid.lockdown.endIt'), value: '`/automod lockdown-end`' },
        ],
    };
}

/** The owner's DM about a lockdown, in `lang` (the server's). Pure, for tests. */
export function lockdownOwnerText({ raised, panic, startedBy = null }, guildName, summary, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const extras = [raised ? tr.t('automod.raid.owner.raised') : null, panic?.applied ? tr.t('automod.raid.owner.paused') : null].filter(Boolean);
    const what = extras.length ? tr.t('automod.raid.owner.lockdownAnd', { extras: extras.join(tr.t('automod.raid.owner.and')) }) : tr.t('automod.raid.owner.lockdown');
    return tr.t(startedBy ? 'automod.raid.owner.manual' : 'automod.raid.owner.raid', { server: guildName, summary, what });
}

async function announceLockdown(guild, { joinerCount, raised, panic, startedBy = null }) {
    // The mod log sits in the staff server (the main server for a home server): its language.
    const staff = textForGuild(staffGuildId(guild.id), { purpose: 'public' });
    const post = lockdownAnnouncement({ joinerCount, raised, panic, startedBy }, { lang: staff.lang });
    await postModLog(guild.client, 'raid', post.fields, { guildId: guild.id, title: post.title });
    // The owner's DM: the language of the server it is about.
    const own = textForGuild(guild.id, { userId: guild.ownerId, purpose: 'dm' });
    const summary = own.lang === staff.lang ? post.summary : lockdownAnnouncement({ joinerCount, raised, panic, startedBy }, { lang: own.lang }).summary;
    await alertOwner(guild, lockdownOwnerText({ raised, panic, startedBy }, guild.name, summary, { lang: own.lang }));
}

/**
 * Starts a lockdown now (an Administrator's "Lock down (panic)"): verification High and invites
 * and DMs paused for the panic hours, whatever /automod panic says. Resolves the lockdown
 * ({ raised, panic, ... }) or null when one is already running. Throws on a database error.
 */
export async function startManualLockdown(guild, admin) {
    const lockdown = await Mutex.runExclusive(`raid:${guild.id}`, async () => {
        if ((await loadLockdown(guild.id))?.active) return null;
        return startLockdown(guild, [], { forcePanic: true, reason: `Lockdown by ${admin.username} (nuke alert)` });
    });
    if (lockdown) {
        announceLockdown(guild, { ...lockdown, startedBy: admin }).catch((error) => logger.warn(`Lockdown notice failed: ${error.message}`));
    }
    return lockdown;
}

/** Test hook: sizes of the in-memory state. */
export function raidStateSizes() {
    return { recentJoins: recentJoins.size, lockdownCache: lockdownCache.size };
}

/** Test hook: forget the in-memory state. */
export function resetRaidState() {
    recentJoins.clear();
    lockdownCache.clear();
}

/**
 * Whether raid detection runs in this server: always in the main server (as before), elsewhere
 * only while automod is on there. Throws on a database error (the caller logs and skips).
 */
export async function raidWatchOn(guildId) {
    if (isLegacyAutomodGuild(guildId)) return true;
    return (await getAutomodSettings(guildId)).enabled;
}

/** Call for every member who joins a server. */
export async function recordJoin(member) {
    if (!member?.guild?.id || !await raidWatchOn(member.guild.id)) return;
    // One join at a time per guild: the lockdown state is read-modify-write.
    const lockdown = await Mutex.runExclusive(`raid:${member.guild.id}`, () => recordJoinLocked(member));
    // The mod log and owner DM can be slow; don't hold up the next join.
    if (lockdown) {
        announceLockdown(member.guild, lockdown).catch((error) => logger.warn(`Lockdown notice failed: ${error.message}`));
        // Raid timeline: outside the lock, after the protective steps ran and were saved.
        attachTimeline(member.guild.id, lockdown).catch((error) => logger.warn(`Raid timeline: could not start: ${error.message}`));
    }
}

/**
 * Opens the incident for a lockdown that just started, keeps its id on the lockdown state
 * (short lock: load, check, save) and records the start. Never delays a protective step:
 * it runs after them, outside the join lock. Exported for tests.
 */
export async function attachTimeline(guildId, { joinerCount, raised, panic, timeline }) {
    const timelineId = await openTimeline({ guildId, trigger: 'join_raid', startedAt: timeline.startedAt });
    if (!timelineId) return null;
    const attached = await Mutex.runExclusive(`raid:${guildId}`, async () => {
        const current = await loadLockdown(guildId);
        if (!current?.active || current.startedAt !== timeline.startedAt) return false;
        await saveLockdown(guildId, { ...current, timelineId });
        return true;
    }).catch((error) => {
        logger.warn(`Raid timeline: could not keep the incident id on the lockdown: ${error.message}`);
        return false;
    });
    await recordStartEvents(timelineId, { ...timeline, joinerCount, raised, panic });
    // The lockdown already ended (or the id could not be kept): close it here, so it is not left open.
    if (!attached) await closeTimeline(timelineId, { endedAt: new Date() });
    return attached ? timelineId : null;
}

async function recordJoinLocked(member) {
    const { guild } = member;

    const state = await loadLockdown(guild.id);
    if (state?.active) {
        if (!state.joinerIds.includes(member.id) && state.joinerIds.length < MAX_TRACKED_JOINERS) {
            await saveLockdown(guild.id, { ...state, joinerIds: [...state.joinerIds, member.id] });
        }
        return;
    }

    const now = Date.now();
    const joins = (recentJoins.get(guild.id) || []).filter((join) => now - join.at <= automodConfig.raidWindowMs);
    joins.push({ at: now, userId: member.id });
    recentJoins.set(guild.id, joins);

    if (joins.length >= automodConfig.raidJoins) {
        recentJoins.delete(guild.id);
        return startLockdown(guild, joins.map((join) => join.userId));
    }
    return null;
}

/**
 * Ends the lockdown, restores the verification level, resumes invites and DMs, and
 * posts the incident report (raidIncidentService.js). Returns false if none was active.
 */
export async function endLockdown(guild, admin) {
    const ended = await Mutex.runExclusive(`raid:${guild.id}`, () => endLockdownLocked(guild, admin));
    if (!ended) return false;
    const timelineId = ended.state.timelineId || null;
    // The timeline end (never throws) runs alongside the report, so it delays nothing.
    const [, report] = await Promise.all([
        timelineId ? recordEndEvents(timelineId, admin, ended) : null,
        postIncidentReport(guild, admin, ended).catch((error) => {
            logger.warn(`Raid incident report failed: ${error.message}`);
            return null;
        }),
    ]);
    if (timelineId && report?.id) await linkTimelineReport(timelineId, report.id);
    return true;
}

/** The end of the lockdown on the timeline, then the incident is closed. Never throws. */
async function recordEndEvents(timelineId, admin, { state, resumed, restored, endedAt }) {
    if (state.raisedVerification) {
        await addTimelineEvent(timelineId, {
            at: endedAt, kind: 'verification', actorId: admin.id,
            detail: restored ? 'Restored to the level before the raid' : 'Could not restore the level before the raid',
        });
    }
    if (state.incidentActions?.applied) {
        await addTimelineEvent(timelineId, {
            at: endedAt, kind: 'panic', actorId: admin.id,
            detail: resumed ? 'Resumed' : 'Could not resume: lift the pause in Server Settings, Safety Setup',
        });
    }
    await addTimelineEvent(timelineId, { at: endedAt, kind: 'lockdown_end', actorId: admin.id, detail: `Ended by ${admin.username || admin.id}` });
    await closeTimeline(timelineId, { endedAt, endedBy: admin.id });
}

async function postIncidentReport(guild, admin, { state, resumed }) {
    const joinerIds = state.joinerIds || [];
    const actions = {
        raisedVerification: Boolean(state.raisedVerification),
        incidentActions: state.incidentActions || null,
        resumed: Boolean(resumed),
        gateKicks: state.gateKicks || [],
    };
    const incident = await recordIncident({ guildId: guild.id, startedAt: state.startedAt, endedBy: admin.id, joinerIds, actions });
    const cases = await casesAgainst(guild.id, joinerIds, state.startedAt).catch((error) => {
        logger.warn(`Raid report: could not read cases of raid joiners: ${error.message}`);
        return [];
    });
    // Posted in the staff server's alerts channel: its language.
    const { lang } = textForGuild(staffGuildId(guild.id), { purpose: 'public' });
    const report = buildIncidentReport(
        incident || { started_at: state.startedAt, ended_at: new Date(), joiner_ids: joinerIds, actions },
        cases,
        { endedByLabel: `${admin.username} (\`${admin.id}\`)`, lang },
    );
    await postAlert(guild.client, 'raid', {
        guildId: guild.id,
        ...report,
        color: 'success',
        components: incident && joinerIds.length ? [releaseRow(incident.id, false, { lang })] : [],
    });
    return incident;
}

async function endLockdownLocked(guild, admin) {
    const state = await loadLockdown(guild.id);
    if (!state?.active) return false;

    const restored = state.raisedVerification
        ? await guild.setVerificationLevel(state.previousVerificationLevel, `Lockdown ended by ${admin.username}`)
            .then(() => true)
            .catch((error) => {
                logger.warn(`Could not restore the verification level: ${error.message}`);
                return false;
            })
        : null;
    const resumed = state.incidentActions?.applied ? await resumeInvitesAndDms(guild) : null;
    await saveLockdown(guild.id, null);
    return { state, resumed, restored, endedAt: new Date() };
}

/** Remembers a join-gate kick on the running lockdown (for the incident report). */
export async function noteGateKick(guildId, userId) {
    await Mutex.runExclusive(`raid:${guildId}`, async () => {
        const state = await loadLockdown(guildId);
        if (!state?.active) return;
        const gateKicks = [...new Set([...(state.gateKicks || []), userId])].slice(0, MAX_TRACKED_JOINERS);
        await saveLockdown(guildId, { ...state, gateKicks });
    });
}

export async function getLockdownState(guildId) {
    return loadLockdown(guildId);
}
