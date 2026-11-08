// cronStats.js — in-memory record of each cron job's last run and failures (app.js `exclusive`
// wrapper writes it, the health report reads it). Bounded by the number of job names.

const MAX_JOBS = 200;
const jobs = new Map(); // name → { lastRunAt, lastOkAt, lastFailAt, lastError, runs, failures, skipped, lastDurationMs }

function entry(name) {
    let job = jobs.get(name);
    if (!job) {
        if (jobs.size >= MAX_JOBS) return null;
        job = { lastRunAt: 0, lastOkAt: 0, lastFailAt: 0, lastError: null, runs: 0, failures: 0, skipped: 0, lastDurationMs: 0 };
        jobs.set(name, job);
    }
    return job;
}

/** One finished run: ok, or failed with `error` (only its message is kept, cut to 120). */
export function recordCronRun(name, { ok, startedAt = Date.now(), endedAt = Date.now(), error = null } = {}) {
    const job = entry(name);
    if (!job) return;
    job.runs += 1;
    job.lastRunAt = startedAt;
    job.lastDurationMs = Math.max(0, endedAt - startedAt);
    if (ok) {
        job.lastOkAt = endedAt;
    } else {
        job.failures += 1;
        job.lastFailAt = endedAt;
        job.lastError = errorLabel(error);
    }
}

/**
 * What the health report may show about a failure: the error's code or name only, never its
 * free-text message (Postgres/Discord messages can carry hosts, URLs or connection details;
 * security review). E.g. "ECONNREFUSED", "50013", "TimeoutError".
 */
export function errorLabel(error) {
    const code = error?.code ?? error?.status;
    const label = code !== undefined && code !== null && String(code).trim() ? String(code) : (error?.name || 'Error');
    return label.replace(/[^\w.-]/g, '').slice(0, 40) || 'Error';
}

/** A tick skipped because the previous run was still going. */
export function recordCronSkip(name) {
    const job = entry(name);
    if (job) job.skipped += 1;
}

/** [{ name, ...stats }] sorted by name (copies). */
export function cronStatsSnapshot() {
    return [...jobs.entries()].map(([name, job]) => ({ name, ...job })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Tests only. */
export function resetCronStats() {
    jobs.clear();
}
