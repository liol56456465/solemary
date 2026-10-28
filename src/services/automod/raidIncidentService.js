// raidIncidentService.js — the incident timeline posted when a join-raid lockdown ends.
//
// One report in the alerts channel: when it started and ended, who joined (count +
// up to 25), and what the bot did (verification level, paused invites/DMs, join-gate
// kicks, cases against raid joiners during the lockdown). Its "Release non-offenders"
// button (administrators) lifts what is still held against raid joiners with no case
// since the raid began: automod probation is ended and open join-gate flags are closed.
// The incident is stored (automod_raid_incidents) so the button works after a restart
// and only once.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from '../enforcement/db.js';
import { formatDuration } from '../enforcement/format.js';
import { describePanic } from './incidentActions.js';

export const MAX_LISTED_JOINERS = 25;
const MAX_LISTED_CASES = 15;

const ts = (date, style = 'f') => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

export async function createIncident({ guildId, startedAt, endedBy, joinerIds, actions }) {
    const { rows } = await query(
        `INSERT INTO ${T.raidIncidents} (guild_id, started_at, ended_by, joiner_ids, actions)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING *`,
        [guildId, startedAt, endedBy, JSON.stringify(joinerIds || []), JSON.stringify(actions || {})]
    );
    return rows[0];
}

export async function getIncident(id) {
    const { rows } = await query(`SELECT * FROM ${T.raidIncidents} WHERE id = $1`, [id]);
    return rows[0] || null;
}

/** Marks the incident released by `userId`. Returns the row, or null if it was already released (or is gone). */
export async function claimRelease(id, userId) {
    const { rows } = await query(
        `UPDATE ${T.raidIncidents} SET released_at = NOW(), released_by = $2
         WHERE id = $1 AND released_at IS NULL RETURNING *`,
        [id, userId]
    );
    return rows[0] || null;
}

export async function saveReleaseResult(id, result) {
    await query(`UPDATE ${T.raidIncidents} SET release_result = $2::jsonb WHERE id = $1`, [id, JSON.stringify(result)]);
    return true;
}

/** Cases (not test, not voided) against these users since `since`, oldest first. */
export async function casesAgainst(guildId, userIds, since) {
    if (!userIds?.length) return [];
    const { rows } = await query(
        `SELECT case_code, type, target_user_id, target_username, created_at
         FROM ${T.cases}
         WHERE guild_id = $1 AND target_user_id = ANY($2::varchar[]) AND created_at >= $3
           AND is_test = FALSE AND voided_at IS NULL
         ORDER BY created_at
         LIMIT 500`,
        [guildId, userIds, since]
    );
    return rows;
}

/** { offenders: Set<userId>, clean: userId[] } — an offender has at least one case. */
export function splitOffenders(joinerIds, cases) {
    const offenders = new Set(cases.map((row) => row.target_user_id));
    return { offenders, clean: joinerIds.filter((id) => !offenders.has(id)) };
}

/** "2 kick, 1 ban: `abc1234` kick alice, …" */
export function summarizeCases(cases) {
    if (!cases.length) return 'None';
    const counts = {};
    for (const row of cases) counts[row.type] = (counts[row.type] || 0) + 1;
    const head = Object.entries(counts).map(([type, n]) => `${n} ${type}`).join(', ');
    const listed = cases.slice(0, MAX_LISTED_CASES).map((row) => `\`${row.case_code}\` ${row.type} ${row.target_username}`).join(', ');
    const more = cases.length > MAX_LISTED_CASES ? ` and ${cases.length - MAX_LISTED_CASES} more` : '';
    return `${head}: ${listed}${more}`;
}

/** The report's embed parts. incident: { started_at, ended_at, joiner_ids, actions }, endedBy label. */
export function buildIncidentReport(incident, cases, { endedByLabel = 'an administrator' } = {}) {
    const joiners = incident.joiner_ids || [];
    const actions = incident.actions || {};
    const started = new Date(incident.started_at);
    const ended = new Date(incident.ended_at || Date.now());
    const listed = joiners.slice(0, MAX_LISTED_JOINERS).map((id) => `<@${id}>`).join(' ');
    const more = joiners.length > MAX_LISTED_JOINERS ? ` and ${joiners.length - MAX_LISTED_JOINERS} more` : '';
    const panicLine = actions.incidentActions
        ? `${describePanic(actions.incidentActions)}${actions.incidentActions.applied ? (actions.resumed ? ' → resumed' : ' → ⚠️ could not resume them: lift the pause in Server Settings → Safety Setup') : ''}`
        : describePanic(null);
    const did = [
        `**Verification level:** ${actions.raisedVerification ? 'raised to High → restored' : 'not changed'}`,
        `**Invites and DMs:** ${panicLine}`,
        `**Join gate kicks:** ${actions.gateKicks?.length || 0}`,
        `**Cases against raid joiners:** ${summarizeCases(cases)}`,
    ].join('\n');
    return {
        title: '📋 Join raid: incident report',
        description: [
            `**Triggered:** ${ts(started)} · **ended:** ${ts(ended)} by ${endedByLabel} (${formatDuration(Math.max(ended - started, 60 * 1000))})`,
            `**Raid joiners:** ${joiners.length}${joiners.length ? `\n${listed}${more}` : ''}`,
        ].join('\n'),
        fields: [{ name: 'What the bot did', value: did.slice(0, 1024) }],
    };
}

export function releaseRow(incidentId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raidrelease:${incidentId}`).setLabel('Release non-offenders')
            .setStyle(ButtonStyle.Success).setDisabled(disabled),
    );
}

/** The result line of a release. */
export function formatReleaseResult(result) {
    return [
        `**${result.clean}** raid joiner(s) broke no rule${result.offenders ? `; **${result.offenders}** with a case stay as they are` : ''}.`,
        `Probation ended: ${result.probationEnded} · join-gate flags closed: ${result.flagsCleared}`
            + `${result.notInServer ? ` · no longer in the server: ${result.notInServer}` : ''}`,
        result.probationEnded || result.flagsCleared ? null : 'Nothing else was held against them.',
    ].filter(Boolean).join('\n');
}

/** Stores the incident; null when the database is unavailable (the report then has no button). */
export async function recordIncident(fields) {
    if (!isEnforcementDbAvailable()) return null;
    return createIncident(fields).catch((error) => {
        logger.warn(`Could not store the raid incident: ${error.message}`);
        return null;
    });
}
