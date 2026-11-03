// raidService.js — join-raid detection and lockdown for the main server.
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
// Raid timeline (incidentTimeline.js): once the protective steps ran, the lockdown opens
// an incident (its id is kept in the lockdown state as timelineId) and records what it
// did; noteIncidentEvent lets other code (join gate, automod, mass-action guard) add to
// the running incident. Recording never throws and never delays a protective step.

import { GuildVerificationLevel } from 'discord.js';
import { automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { getAutomodSettings, getLockdown, setLockdown } from './automodSettings.js';
import { describePanic, pauseInvitesAndDms, resumeInvitesAndDms } from './incidentActions.js';
import { postAlert } from './alertPost.js';
import { buildIncidentReport, casesAgainst, recordIncident, releaseRow } from './raidIncidentService.js';
import { recordEvent } from './reviewRegistry.js';
import { addTimelineEvent, closeTimeline, linkTimelineReport, openTimeline } from './incidentTimeline.js';

const recentJoins = new Map(); // guildId → [{ at, userId }]
const lockdownCache = new Map(); // guildId → state | null
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

async function startLockdown(guild, joinerIds) {
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
        raised = await guild.setVerificationLevel(GuildVerificationLevel.High, 'Automod: join raid detected')
            .then(() => true)
            .catch((error) => {
                logger.warn(`Lockdown could not raise the verification level: ${error.message}`);
                return false;
            });
    }

    const verifiedAt = new Date();

    const settings = await getAutomodSettings(guild.id).catch(() => null);
    const panic = settings?.panic?.enabled === false ? null : await pauseInvitesAndDms(guild, settings?.panic?.hours);
    const pausedAt = new Date();

    if (raised || panic) {
        const current = await loadLockdown(guild.id);
        await saveLockdown(guild.id, {
            ...(current?.active ? current : state),
            raisedVerification: raised,
            incidentActions: panic,
        });
    }

    recordEvent('raid');
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

async function announceLockdown(guild, { joinerCount, raised, panic }) {
    const summary = `${joinerCount} accounts joined within ${automodConfig.raidWindowMs / 1000} seconds.`;
    await postModLog(guild.client, 'raid', [
        { name: 'What happened', value: summary },
        { name: 'Verification level', value: raised ? 'Raised to High' : 'Not changed (already High, or missing Manage Server)' },
        { name: 'Invites and DMs', value: describePanic(panic) },
        { name: 'Raid joiners', value: 'Kicked automatically if they break any rule while the lockdown lasts.' },
        { name: 'End it', value: '`/automod lockdown-end`' },
    ], { title: 'Join raid: lockdown started' });
    const extras = [raised ? 'the verification level is now High' : null, panic?.applied ? 'invites and DMs are paused' : null].filter(Boolean);
    await alertOwner(guild, `**Join raid in ${guild.name}.** ${summary} The server is in lockdown${extras.length ? ` and ${extras.join(' and ')}` : ''}. End it with \`/automod lockdown-end\` when it is over.`);
}

/** Call for every member who joins the main server. */
export async function recordJoin(member) {
    if (member.guild.id !== enforcementConfig.mainGuildId) return;
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
    const report = buildIncidentReport(
        incident || { started_at: state.startedAt, ended_at: new Date(), joiner_ids: joinerIds, actions },
        cases,
        { endedByLabel: `${admin.username} (\`${admin.id}\`)` },
    );
    await postAlert(guild.client, 'raid', {
        ...report,
        color: 'success',
        components: incident && joinerIds.length ? [releaseRow(incident.id)] : [],
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
