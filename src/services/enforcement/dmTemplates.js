// dmTemplates.js — the DM layouts sent to punished users.

import { enforcementConfig } from '../../config/enforcement.js';
import { dateStamp, formatDuration, stamp } from './format.js';

const { serverName, supportServerInvite } = enforcementConfig;

function appealLine(record) {
    return record.unappealable
        ? 'This ban cannot be appealed.'
        : `**Appeal here:** ${supportServerInvite}`;
}

function common(record) {
    return [
        `By: ${record.moderator_username}`,
        `Reason: ${record.reason}`,
        `Date: ${dateStamp(record.created_at)}`,
    ];
}

export function banDm(record) {
    const duration = record.expires_at
        ? `Duration: ${formatDuration(Number(record.duration_ms))} — ends ${stamp(record.expires_at)}`
        : 'Duration: Permanent';
    const lines = [
        appealLine(record),
        `**Banned from ${serverName}**`,
        ...common(record),
        duration,
        `Case code: ${record.case_code}`,
    ];
    if (record.ladder_level_after === 3 && record.is_auto && record.appeal_deadline && !record.unappealable) {
        lines.push(`You can appeal until ${dateStamp(record.appeal_deadline)}.`);
    }
    return lines.join('\n');
}

export function kickDm(record, inviteUrl) {
    return [
        `**Appeal here:** ${supportServerInvite}`,
        `**Kicked from ${serverName}**`,
        ...common(record),
        `Case code: ${record.case_code}`,
        `Rejoin: ${inviteUrl || 'ask a staff member for an invite'}`,
    ].join('\n');
}

export function muteDm(record) {
    return [
        `**Appeal here:** ${supportServerInvite}`,
        `**Muted in ${serverName}**`,
        ...common(record),
        `Duration: ${formatDuration(Number(record.duration_ms))} — ends ${stamp(record.expires_at)}`,
        `Case code: ${record.case_code}`,
    ].join('\n');
}

export function warnDm(record, warnNumber) {
    return [
        `**Appeal here:** ${supportServerInvite}`,
        `**Warning ${warnNumber} of ${enforcementConfig.warnsPerLevel} in ${serverName}**`,
        ...common(record),
        `Case code: ${record.case_code}`,
        `At ${enforcementConfig.warnsPerLevel} warnings you will be banned.`,
    ].join('\n');
}

export function appealAcceptedDm(adminUsername, inviteUrl) {
    return [
        '**Appeal accepted**',
        `By: ${adminUsername}`,
        inviteUrl || 'Ask a staff member in the support server for an invite back.',
    ].join('\n');
}

export function appealDeniedDm() {
    return `**Appeal denied.** If you think this is a mistake, appeal again here:\n${supportServerInvite}`;
}
