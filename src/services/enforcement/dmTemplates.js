// dmTemplates.js — the DM layouts sent to punished users.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
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
    if (record.is_auto && !record.unappealable) {
        lines.push('Appealing this code also removes the warning that caused this ban.');
    }
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

/**
 * Sent when a ban ends: on expiry, or early when a moderator unbans.
 * `inviteUrl` is a one-time invite back to the server (null when none could be made).
 */
export function banEndedDm(record, inviteUrl, { early = false } = {}) {
    return [
        `**Your ban from ${serverName} has ended**`,
        early ? 'A moderator lifted it early.' : 'It expired.',
        record?.case_code ? `Case code: ${record.case_code}` : null,
        `Rejoin: ${inviteUrl || `ask for an invite in the support server: ${supportServerInvite}`}`,
    ].filter(Boolean).join('\n');
}

/** Sent when a mute ends: on expiry, or early when a moderator unmutes. */
export function muteEndedDm(record, { early = false } = {}) {
    return [
        `**Your mute in ${serverName} has ended**`,
        early ? 'A moderator lifted it early. You can talk again.' : 'It expired. You can talk again.',
        record?.case_code ? `Case code: ${record.case_code}` : null,
    ].filter(Boolean).join('\n');
}

/**
 * Sent when an admin voids a case (/case void): the record no longer counts against
 * the user. `inviteUrl` is set when the void lifted a ban.
 */
export function caseVoidedDm(record, reason, inviteUrl = null) {
    return [
        `**A ${record.type} on your record in ${serverName} was voided**`,
        `Case code: ${record.case_code}`,
        `Reason: ${reason}`,
        'It no longer counts against you.',
        inviteUrl ? `You were unbanned. Rejoin: ${inviteUrl}` : null,
    ].filter(Boolean).join('\n');
}

/** Sent to both members when staff start a no-contact order. `other` is the other member (or null). */
export function noContactStartedDm(order, other) {
    const otherName = other ? `**${other.username}**` : 'another member';
    return [
        `**No-contact order in ${serverName}**`,
        `Staff have asked you and ${otherName} not to contact each other until ${stamp(order.until)}.`,
        'Until then, do not mention or reply to them in the server: those messages are removed.',
        `Reason: ${order.reason}`,
        'This is not a punishment and does not count as a warning.',
    ].join('\n');
}

/** Sent to both members when a no-contact order ends (early by staff, or it expired). */
export function noContactEndedDm(order, other, { early = false } = {}) {
    return [
        `**Your no-contact order in ${serverName} has ended**`,
        `${early ? 'Staff ended it early.' : 'It expired.'} You may contact ${other ? `**${other.username}**` : 'the other member'} again.`,
    ].join('\n');
}

/**
 * The "Contest this" button under an automod DM whose message was deleted
 * (automodContest.js). DM buttons work without a shared server. customId carries
 * the case code: amcontest:open:<code>.
 */
export function contestComponents(caseCode) {
    if (!caseCode) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`amcontest:open:${caseCode}`).setLabel('Contest this').setEmoji('🙋').setStyle(ButtonStyle.Secondary),
    )];
}
