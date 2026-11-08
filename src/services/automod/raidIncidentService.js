// raidIncidentService.js — the incident timeline posted when a join-raid lockdown ends.
//
// One report in the alerts channel: when it started and ended, who joined (count +
// up to 25), and what the bot did (verification level, paused invites/DMs, join-gate
// kicks, cases against raid joiners during the lockdown). Its "Release non-offenders"
// button (administrators) lifts what is still held against raid joiners with no case
// since the raid began: the automod extra-watch period is ended and open join-gate flags are closed.
// The incident is stored (automod_raid_incidents) so the button works after a restart
// and only once.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from '../enforcement/db.js';
import { formatDuration } from '../enforcement/format.js';
import { durationIn } from '../enforcement/dmTemplates.js';
import { botText } from '../../utils/botText.js';
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

// Case types as words (English: the stored type as is). Literal keys for tests/botI18nUsage.test.js.
const CASE_TYPE_TEXT = {
    ban: (tr) => tr.t('automod.raid.caseType.ban'),
    kick: (tr) => tr.t('automod.raid.caseType.kick'),
    mute: (tr) => tr.t('automod.raid.caseType.mute'),
    warn: (tr) => tr.t('automod.raid.caseType.warn'),
    unban: (tr) => tr.t('automod.raid.caseType.unban'),
    unmute: (tr) => tr.t('automod.raid.caseType.unmute'),
};
const caseTypeWord = (type, tr) => (tr.lang === 'en' || !CASE_TYPE_TEXT[type] ? type : CASE_TYPE_TEXT[type](tr));

/** "2 kick, 1 ban: `abc1234` kick alice, …" */
export function summarizeCases(cases, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!cases.length) return tr.t('automod.raid.report.noCases');
    const counts = {};
    for (const row of cases) counts[row.type] = (counts[row.type] || 0) + 1;
    const head = Object.entries(counts).map(([type, n]) => `${n} ${caseTypeWord(type, tr)}`).join(', ');
    const listed = cases.slice(0, MAX_LISTED_CASES).map((row) => `\`${row.case_code}\` ${caseTypeWord(row.type, tr)} ${row.target_username}`).join(', ');
    const more = cases.length > MAX_LISTED_CASES ? tr.t('automod.raid.report.andMore', { count: cases.length - MAX_LISTED_CASES }) : '';
    return `${head}: ${listed}${more}`;
}

/** The report's embed parts. incident: { started_at, ended_at, joiner_ids, actions }, endedBy label. */
export function buildIncidentReport(incident, cases, { endedByLabel = null, lang = 'en' } = {}) {
    const tr = botText(lang);
    const joiners = incident.joiner_ids || [];
    const actions = incident.actions || {};
    const started = new Date(incident.started_at);
    const ended = new Date(incident.ended_at || Date.now());
    const listed = joiners.slice(0, MAX_LISTED_JOINERS).map((id) => `<@${id}>`).join(' ');
    const more = joiners.length > MAX_LISTED_JOINERS ? tr.t('automod.raid.report.andMore', { count: joiners.length - MAX_LISTED_JOINERS }) : '';
    const panicLine = actions.incidentActions
        ? `${describePanic(actions.incidentActions, { lang })}${actions.incidentActions.applied ? (actions.resumed ? tr.t('automod.raid.report.resumed') : tr.t('automod.raid.report.notResumed')) : ''}`
        : describePanic(null, { lang });
    const did = [
        tr.t('automod.raid.report.verification', { value: actions.raisedVerification ? tr.t('automod.raid.report.raisedRestored') : tr.t('automod.raid.report.notChanged') }),
        tr.t('automod.raid.report.invites', { value: panicLine }),
        tr.t('automod.raid.report.gateKicks', { count: actions.gateKicks?.length || 0 }),
        tr.t('automod.raid.report.cases', { value: summarizeCases(cases, { lang }) }),
    ].join('\n');
    const duration = Math.max(ended - started, 60 * 1000);
    return {
        title: tr.t('automod.raid.report.title'),
        description: [
            tr.t('automod.raid.report.triggered', {
                start: ts(started), end: ts(ended), by: endedByLabel ?? tr.t('automod.raid.report.anAdmin'),
                duration: lang === 'en' ? formatDuration(duration) : durationIn(duration, lang),
            }),
            `${tr.t('automod.raid.report.joiners', { count: joiners.length })}${joiners.length ? `\n${listed}${more}` : ''}`,
        ].join('\n').slice(0, 4096),
        fields: [{ name: tr.t('automod.raid.report.didTitle'), value: did.slice(0, 1024) }],
    };
}

export function releaseRow(incidentId, disabled = false, { lang = 'en' } = {}) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raidrelease:${incidentId}`).setLabel(botText(lang).t('automod.raid.releaseButton'))
            .setStyle(ButtonStyle.Success).setDisabled(disabled),
    );
}

/** The result line of a release. */
export function formatReleaseResult(result, { lang = 'en' } = {}) {
    const tr = botText(lang);
    return [
        result.offenders
            ? tr.t('automod.raid.release.cleanWithOffenders', { clean: result.clean, offenders: result.offenders })
            : tr.t('automod.raid.release.clean', { clean: result.clean }),
        tr.t('automod.raid.release.counts', { probation: result.probationEnded, flags: result.flagsCleared })
            + (result.notInServer ? tr.t('automod.raid.release.notInServer', { count: result.notInServer }) : ''),
        result.probationEnded || result.flagsCleared ? null : tr.t('automod.raid.release.nothingElse'),
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
