// bulkActions.js — one action on many members (Members list → preview → run).
// planBulk is pure: who will be changed and who is skipped (with the reason), using the same
// rules as single actions. Jobs run one member at a time in the background (Discord rate
// limits); the browser polls a progress page. Kicks and bans stay inside the mass-action
// guard: only as many as the moderator has left in the current window are planned.

import { randomUUID } from 'node:crypto';
import { TIMEOUTS, roleProblem, targetProblem } from './memberActions.js';

export const BULK_LIMIT = 100;
export const BULK_ACTIONS = {
    'role-add': 'Give a role',
    'role-remove': 'Take a role',
    timeout: 'Time out',
    kick: 'Kick',
    ban: 'Ban',
};

/**
 * Who will be changed and who is skipped.
 * input: { guild, members: [GuildMember], action, role, timeoutKey, actorId, actorMember, actorIsOwner,
 *          botMember, guardLeft (bans/kicks still allowed now; Infinity for bot owners) }
 * → { run: [{ id, name }], skipped: [{ id, name, why }] }
 */
export function planBulk({ guild, members, action, role = null, timeoutKey = '', actorId, actorMember, actorIsOwner = false, botMember, guardLeft = Infinity }) {
    const run = [];
    const skipped = [];
    const base = { guild, actorId, actorMember, actorIsOwner, botMember };
    const rolesProblem = action === 'role-add' || action === 'role-remove' ? roleProblem({ ...base, role }) : null;
    let guarded = 0;
    for (const member of members) {
        const id = member.id || member.user?.id;
        const name = member.user?.username || id;
        const skip = (why) => skipped.push({ id, name, why });
        const problem = targetProblem({ ...base, target: member });
        if (problem) { skip(problem); continue; }
        if (rolesProblem) { skip(rolesProblem); continue; }
        const has = role ? member.roles?.cache?.has?.(role.id) : false;
        if (action === 'role-add' && has) { skip(`already has @${role.name}`); continue; }
        if (action === 'role-remove' && !has) { skip(`does not have @${role.name}`); continue; }
        if (action === 'timeout' && !TIMEOUTS[timeoutKey]) { skip('no timeout length chosen'); continue; }
        if (action === 'timeout' && member.permissions?.has?.('Administrator')) { skip('has Administrator (Discord does not allow a timeout)'); continue; }
        if (action === 'kick' || action === 'ban') {
            if (guarded >= guardLeft) { skip('mass-action guard: no more bans/kicks allowed in this 10-minute window'); continue; }
            guarded += 1;
        }
        run.push({ id, name });
    }
    return { run, skipped };
}

/** In-memory jobs (newest 20, kept 1 hour), visible only to the session that started them. */
export function createJobStore({ max = 20, keepMs = 3_600_000 } = {}) {
    const jobs = new Map();
    const prune = (now) => {
        for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > keepMs) jobs.delete(id);
        while (jobs.size > max) jobs.delete(jobs.keys().next().value);
    };
    return {
        /** Starts `work(item)` for every item, one after the other; resolves when done. */
        start({ session, label, items, work, onDone = async () => {} }, now = Date.now()) {
            prune(now);
            const job = { id: randomUUID(), session, label, total: items.length, done: [], failed: [], startedAt: now, finishedAt: null };
            jobs.set(job.id, job);
            job.promise = (async () => {
                for (const item of items) {
                    try {
                        await work(item);
                        job.done.push(item);
                    } catch (error) {
                        job.failed.push({ ...item, why: String(error?.userMessage || error?.message || error).slice(0, 200) });
                    }
                }
                job.finishedAt = Date.now();
                await onDone(job).catch(() => {});
            })();
            return job;
        },
        get(id, session) {
            const job = jobs.get(id);
            return job && job.session === session ? job : null;
        },
    };
}
