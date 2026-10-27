// standingService.js — "My standing" on the appeal panels: a member's own
// counted warnings, warn-ladder level, what the next warning would do, active
// punishments and appeals. Only ever built for the member who clicked.
//
// How the ladder works (enforcementService.js): warnings never expire. At level 0
// the third counted warning bans; at level 1+ the first one does. Each automatic
// ban raises the level and resets the counter, so the warnings before it stop
// counting. A counted warning stops counting only when staff remove it, it is lifted
// on appeal, or the case is voided. The level itself is never reset.

import { enforcementConfig } from '../../config/enforcement.js';
import { getActiveCase, getCountedWarns, listUserAppeals } from './caseService.js';
import { getLadder, previewWarn } from './enforcementService.js';
import { formatDuration, truncate } from './format.js';

const day = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:d>`;
const relative = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

const APPEAL_STATUS = {
    pending: '⏳ pending',
    accepted: '✅ accepted',
    denied: '❌ denied',
    closed: '🔒 closed',
};

export async function getMemberStanding(guildId, userId) {
    const ladder = await getLadder(guildId, userId);
    const [warns, activeBan, activeMute, appeals] = await Promise.all([
        getCountedWarns(guildId, userId, ladder.level),
        getActiveCase(guildId, userId, 'ban'),
        getActiveCase(guildId, userId, 'mute'),
        listUserAppeals(userId, 5),
    ]);
    return { ladder, warns, activeBan, activeMute, appeals };
}

/** What the next warning would do, in plain words. */
export function nextWarningText(ladder) {
    const step = previewWarn(ladder);
    if (!step.escalates) {
        const left = step.threshold - step.warnNumber;
        return `It would be warning ${step.warnNumber} of ${step.threshold}. `
            + `${left === 1 ? 'The one after it' : `${left} more after it`} would mean an automatic ban `
            + `(${banLength(enforcementConfig.ladderBans[Math.min(ladder.level + 1, 3)])}).`;
    }
    return `It would reach the warning limit: an automatic ban (${banLength(step.banDurationMs)}, ladder level ${step.nextLevel}).`;
}

function banLength(ms) {
    return ms == null ? 'permanent' : formatDuration(ms);
}

/** The embed fields for a standing; pure, for tests. */
export function standingFields(standing) {
    const { ladder, warns, activeBan, activeMute, appeals } = standing;
    const threshold = ladder.level === 0 ? enforcementConfig.warnsPerLevel : 1;

    const warnLines = warns.slice(0, 10).map((warn) => `\`${warn.case_code}\` · ${truncate(warn.reason, 80)} · ${day(warn.created_at)}`);
    if (warns.length > 10) warnLines.push(`…and ${warns.length - 10} more`);
    const warnsValue = [
        ladder.warns_since_level
            ? `**${ladder.warns_since_level}** counted (limit at this level: ${threshold}).`
            : 'None counted right now.',
        ...warnLines,
        '-# Warnings do not expire. One stops counting when staff remove it, it is lifted on appeal, or you reach the limit (then the count starts again at the next level).',
    ].join('\n');

    const ladderValue = [
        `Level **${ladder.level}** of 3${ladder.level === 0 ? ' (no automatic bans yet)' : ''}.`,
        `**Your next warning:** ${nextWarningText(ladder)}`,
    ].join('\n');

    const active = [];
    if (activeBan) active.push(`Ban \`${activeBan.case_code}\` — ${activeBan.expires_at ? `ends ${day(activeBan.expires_at)} (${relative(activeBan.expires_at)})` : 'permanent'}`);
    if (activeMute) active.push(`Mute \`${activeMute.case_code}\` — ends ${day(activeMute.expires_at)} (${relative(activeMute.expires_at)})`);

    const appealLines = appeals.map((appeal) => `\`${appeal.case_code}\` ${appeal.type} · ${APPEAL_STATUS[appeal.status] ?? appeal.status} · filed ${day(appeal.created_at)}${appeal.decided_at ? `, decided ${day(appeal.decided_at)}` : ''}`);

    return [
        { name: 'Counted warnings', value: truncate(warnsValue, 1024) },
        { name: 'Warning ladder', value: truncate(ladderValue, 1024) },
        { name: 'Active punishments', value: active.length ? active.join('\n') : 'None.' },
        { name: 'Appeals', value: truncate(appealLines.length ? appealLines.join('\n') : 'None filed.', 1024) },
    ];
}
