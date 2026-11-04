// trustCardService.js — the numbers behind the public /trust page (services/site/pages/trust.js):
// a short summary of how the main server was moderated over the last 90 days.
//
//   appeals        mod_appeals kind 'appeal' sent in the window (by created_at), joined to their
//                  case so the server, test and imported filters apply (like transparencyService).
//                  First answer = the earlier of claimed_at and the decision (accepted/denied);
//                  decision = decided_at of accepted/denied appeals. Medians in hours.
//   cases          mod_cases of the server in the window: not test, not imported, not voided.
//   good standing  current members (the cached member list) with no counted warning
//                  (mod_ladder warns_since_level > 0) and no active mute or ban case, out of
//                  guild.memberCount.
//   heads-up       automod heads-up counts (automod/headsUp.js headsUpStats): fixed / (fixed + acted).
//
// Numbers only: nothing here selects a name, an ID that leaves this file, a case code or a reason.
// Small-number privacy (same rules as the transparency report): a count of 1–2 shows as
// "fewer than 3"; a rate or median based on fewer than 3 is not shown; member-based numbers
// need at least 10 members.
//
// Reads throw on any database error (the page answers 503); the cached reader never keeps a failure.

import { query, T } from './db.js';
import { SMALL_COUNT, maskCount, medianParts, medianText } from './transparencyService.js';

export const TRUST_DAYS = 90;
export const MIN_MEMBERS = 10;
export const TRUST_CACHE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DECIDED = "a.status IN ('accepted', 'denied') AND a.decided_at IS NOT NULL";
const HOURS = (from, to) => `EXTRACT(EPOCH FROM (${to} - ${from})) / 3600.0`;

/** SQL + params: the server's appeals sent since `since`, with both medians. */
export function trustAppealsQuery(guildId, since) {
    return {
        text: `SELECT COUNT(*)::int AS received,
                      COUNT(*) FILTER (WHERE m.decided AND m.status = 'accepted')::int AS accepted,
                      COUNT(*) FILTER (WHERE m.decided AND m.status = 'denied')::int AS denied,
                      COUNT(m.first_hours)::int AS answered,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY m.first_hours) AS median_first_hours,
                      COUNT(m.decision_hours)::int AS decided,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY m.decision_hours) AS median_decision_hours
                 FROM (SELECT a.status, (${DECIDED}) AS decided,
                              CASE WHEN ${DECIDED} THEN ${HOURS('a.created_at', 'a.decided_at')} END AS decision_hours,
                              ${HOURS('a.created_at', `LEAST(a.claimed_at, CASE WHEN ${DECIDED} THEN a.decided_at END)`)} AS first_hours
                         FROM ${T.appeals} a
                         JOIN ${T.cases} c ON c.case_code = a.case_code
                        WHERE a.kind = 'appeal' AND c.guild_id = $1 AND a.created_at >= $2
                          AND c.is_test = FALSE AND c.is_imported = FALSE) m`,
        params: [guildId, since],
    };
}

/** SQL + params: the server's counted cases since `since`. */
export function trustCasesQuery(guildId, since) {
    return {
        text: `SELECT COUNT(*)::int AS cases
                 FROM ${T.cases} c
                WHERE c.guild_id = $1 AND c.created_at >= $2
                  AND c.is_test = FALSE AND c.is_imported = FALSE AND c.voided_at IS NULL`,
        params: [guildId, since],
    };
}

/**
 * SQL + params: how many of `memberIds` have a counted warning or an active mute/ban case.
 * One query; the IDs only go in, a count comes out.
 */
export function standingQuery(guildId, memberIds) {
    return {
        text: `SELECT COUNT(*)::int AS flagged FROM (
                   SELECT l.user_id FROM ${T.ladder} l
                    WHERE l.guild_id = $1 AND l.warns_since_level > 0 AND l.user_id = ANY($2::text[])
                   UNION
                   SELECT c.target_user_id FROM ${T.cases} c
                    WHERE c.guild_id = $1 AND c.type IN ('mute', 'ban') AND c.status IN ('active', 'appeal_pending')
                      AND c.voided_at IS NULL AND c.is_test = FALSE AND c.target_user_id = ANY($2::text[])
               ) x`,
        params: [guildId, memberIds],
    };
}

const int = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const hours = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value)));

async function defaultHeadsUp(guildId, options) {
    const { headsUpStats } = await import('../automod/headsUp.js');
    return headsUpStats(guildId, options);
}

/**
 * The raw numbers: { days, since, generatedAt, serverName, memberCount, appeals: { received,
 * accepted, denied, answered, decided, medianFirstHours, medianDecisionHours }, cases,
 * flagged (null under MIN_MEMBERS), headsUp: { fixed, acted } }.
 * Throws when the server is not in the bot's cache (no member count) or on any database error.
 */
export async function readTrustCard(guildId, { client, now = new Date(), run = query, headsUp = defaultHeadsUp } = {}) {
    if (!guildId) throw new Error('MAIN_GUILD_ID is not set');
    if (!client?.isReady?.()) throw new Error('the bot is not connected yet');
    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) throw new Error('the main server is not in the cache');
    const memberCount = int(guild.memberCount);
    const since = new Date(now.getTime() - TRUST_DAYS * DAY_MS);
    const appeals = trustAppealsQuery(guildId, since);
    const cases = trustCasesQuery(guildId, since);
    const memberIds = memberCount >= MIN_MEMBERS ? [...(guild.members?.cache?.keys?.() || [])] : null;
    const standing = memberIds ? standingQuery(guildId, memberIds) : null;
    const [appealResult, caseResult, standingResult, heads] = await Promise.all([
        run(appeals.text, appeals.params),
        run(cases.text, cases.params),
        standing ? run(standing.text, standing.params) : null,
        headsUp(guildId, { days: TRUST_DAYS, now: now.getTime() }),
    ]);
    const a = appealResult?.rows?.[0];
    const c = caseResult?.rows?.[0];
    if (!a || !c || (standing && !standingResult?.rows?.[0])) throw new Error('trust card: no rows from the database');
    if (!heads || typeof heads !== 'object') throw new Error('trust card: no heads-up counts');
    return {
        days: TRUST_DAYS, since, generatedAt: now,
        serverName: String(guild.name || '').trim() || 'This server',
        memberCount,
        appeals: {
            received: int(a.received), accepted: int(a.accepted), denied: int(a.denied),
            answered: int(a.answered), decided: int(a.decided),
            medianFirstHours: hours(a.median_first_hours), medianDecisionHours: hours(a.median_decision_hours),
        },
        cases: int(c.cases),
        flagged: standing ? int(standingResult.rows[0].flagged) : null,
        headsUp: { fixed: int(heads.fixed), acted: int(heads.acted) },
    };
}

// ── Display helpers (pure) ────────────────────────────────────────────────

/** "67%" for part / whole, or null when the whole is under 3. */
export function rateText(part, whole) {
    const total = int(whole);
    if (total < SMALL_COUNT) return null;
    return `${Math.round((Math.min(int(part), total) / total) * 100)}%`;
}

/**
 * Members in good standing as "97%", or null under MIN_MEMBERS. Rounded down while anyone is
 * flagged, so 100% only ever means everyone.
 */
export function goodStandingText(memberCount, flagged) {
    const members = int(memberCount);
    if (members < MIN_MEMBERS || flagged === null || flagged === undefined) return null;
    const bad = Math.min(int(flagged), members);
    const pct = ((members - bad) / members) * 100;
    return `${bad > 0 ? Math.floor(pct) : 100}%`;
}

/** Cases per 1,000 members as a number (4.2, 18: one decimal under 10), or null under MIN_MEMBERS or with 1–2 cases. */
export function casesPerThousand(cases, memberCount) {
    const members = int(memberCount);
    const count = int(cases);
    if (members < MIN_MEMBERS || (count > 0 && count < SMALL_COUNT)) return null;
    const rate = (count / members) * 1000;
    return rate < 10 ? Math.round(rate * 10) / 10 : Math.round(rate);
}

/** Cases per 1,000 members ("4.2", "18", English number format), or null under MIN_MEMBERS or with 1–2 cases. */
export function casesPerThousandText(cases, memberCount) {
    const value = casesPerThousand(cases, memberCount);
    return value === null ? null : value.toLocaleString('en-US');
}

/** The page's view of readTrustCard's numbers: every value already masked or null (hidden). */
export function trustCardView(card) {
    const a = card.appeals;
    return {
        serverName: card.serverName,
        days: card.days,
        since: card.since,
        generatedAt: card.generatedAt,
        received: maskCount(a.received),
        decided: maskCount(a.accepted + a.denied),
        firstAnswer: medianText(a.medianFirstHours, a.answered),
        decisionTime: medianText(a.medianDecisionHours, a.decided),
        // The same medians as data, for the website's own words ({ unit, value } or null).
        firstAnswerParts: medianParts(a.medianFirstHours, a.answered),
        decisionTimeParts: medianParts(a.medianDecisionHours, a.decided),
        successRate: rateText(a.accepted, a.accepted + a.denied),
        goodStanding: goodStandingText(card.memberCount, card.flagged),
        casesPerThousand: casesPerThousandText(card.cases, card.memberCount),
        casesPerThousandValue: casesPerThousand(card.cases, card.memberCount),
        headsUpRate: rateText(card.headsUp.fixed, card.headsUp.fixed + card.headsUp.acted),
    };
}

/**
 * The cached reader for the site: () → Promise<card>. One read per 10 minutes, shared by
 * concurrent views; a failed read is not cached (the next view tries again).
 */
export function createTrustCardReader({ guildId, client = null, read = readTrustCard, now = () => Date.now(), ttlMs = TRUST_CACHE_MS } = {}) {
    let hit = null;
    return () => {
        if (hit && hit.until > now()) return hit.promise;
        const id = typeof guildId === 'function' ? guildId() : guildId;
        const promise = Promise.resolve().then(() => read(id, { client, now: new Date(now()) }));
        const entry = { promise, until: now() + ttlMs };
        hit = entry;
        promise.catch(() => { if (hit === entry) hit = null; });
        return promise;
    };
}
