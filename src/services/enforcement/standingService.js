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
import { formatDuration, ladderStageLabel, truncate } from './format.js';
import { durationIn } from './dmTemplates.js';
import { ladderStageShortIn } from './precedentService.js';
import { botText } from '../../utils/botText.js';

const day = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:d>`;
const relative = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

const APPEAL_STATUSES = new Set(['pending', 'accepted', 'denied', 'closed']);
const CASE_TYPES = new Set(['ban', 'kick', 'mute', 'warn']);

export async function getMemberStanding(guildId, userId) {
    const ladder = await getLadder(guildId, userId);
    const [warns, activeBan, activeMute, appeals] = await Promise.all([
        getCountedWarns(guildId, userId, ladder.level),
        getActiveCase(guildId, userId, 'ban'),
        getActiveCase(guildId, userId, 'mute'),
        listUserAppeals(userId, 5, { guildId }),
    ]);
    return { ladder, warns, activeBan, activeMute, appeals };
}

/**
 * What the next warning would do, as data (the website words it in the page's language):
 * { escalates: false, warnNumber, threshold, left, banMs } or { escalates: true, banMs, nextLevel }.
 * banMs null = permanent.
 */
export function nextWarningSteps(ladder) {
    const step = previewWarn(ladder);
    // Warn ladder off in this server (ladderPolicy.js): a warning never bans automatically.
    if (step.ladderOff) return { escalates: false, ladderOff: true };
    if (!step.escalates) {
        return {
            escalates: false, warnNumber: step.warnNumber, threshold: step.threshold, left: step.threshold - step.warnNumber,
            banMs: enforcementConfig.ladderBans[Math.min(ladder.level + 1, 3)] ?? null,
        };
    }
    return { escalates: true, banMs: step.banDurationMs ?? null, nextLevel: step.nextLevel };
}

/** What the next warning would do, in plain words (English: Discord, dashboard). */
export function nextWarningText(ladder) {
    const step = nextWarningSteps(ladder);
    if (step.ladderOff) return LADDER_OFF_TEXT;
    if (!step.escalates) {
        return `It would be warning ${step.warnNumber} of ${step.threshold}. `
            + `${step.left === 1 ? 'The one after it' : `${step.left} more after it`} would mean an automatic ban `
            + `(${banLength(step.banMs)}).`;
    }
    return `It would reach the warning limit: an automatic ban (${banLength(step.banMs)}, warning stage ${step.nextLevel} of 3).`;
}

const LADDER_OFF_TEXT = 'Warnings are recorded but never lead to an automatic ban in this server (the warn ladder is off).';

function banLength(ms) {
    return ms == null ? 'permanent' : formatDuration(ms);
}

/** "Warning stage 1 of 3 (7-day ban)" in a language (English: format.js ladderStageLabel). */
function stageLabelIn(level, tr) {
    if (tr.lang === 'en') return ladderStageLabel(level);
    const text = tr.t('staff.panel.stage.long', { stage: ladderStageShortIn(level, { lang: tr.lang }) });
    return text.charAt(0).toLocaleUpperCase(tr.lang) + text.slice(1);
}

/** nextWarningText in a language (English: exactly nextWarningText). */
export function nextWarningIn(ladder, { lang = 'en' } = {}) {
    if (lang === 'en') return nextWarningText(ladder);
    const tr = botText(lang);
    const step = nextWarningSteps(ladder);
    if (step.ladderOff) return tr.t('member.record.ladderOff');
    const ban = step.banMs == null ? tr.t('member.record.permanent') : durationIn(step.banMs, tr.lang);
    if (step.escalates) return tr.t('member.record.limit', { ban, stage: step.nextLevel });
    const after = step.left === 1 ? tr.t('member.record.oneAfter', { ban }) : tr.tp('member.record.moreAfter', step.left, { ban });
    return `${tr.t('member.record.would', { n: step.warnNumber, max: step.threshold })} ${after}`;
}

/**
 * The embed fields for a standing ("My record"), in the member's language (`lang`; English is
 * the text as before). Pure, for tests.
 */
export function standingFields(standing, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const { ladder, warns, activeBan, activeMute, appeals } = standing;
    const threshold = ladder.level === 0 ? enforcementConfig.warnsPerLevel : 1;

    const warnLines = warns.slice(0, 10).map((warn) => `\`${warn.case_code}\` · ${truncate(warn.reason, 80)} · ${day(warn.created_at)}`);
    if (warns.length > 10) warnLines.push(tr.t('member.record.andMore', { n: warns.length - 10 }));
    const warnsValue = [
        ladder.enabled === false
            ? tr.t('member.record.ladderOff')
            : ladder.warns_since_level
                ? tr.t('member.record.counted', { n: ladder.warns_since_level, threshold })
                : tr.t('member.record.noneCounted'),
        ...warnLines,
        tr.t('member.record.expiry'),
    ].join('\n');

    const ladderValue = [
        tr.t('member.record.stage', { stage: stageLabelIn(ladder.level, tr) }),
        tr.t('member.record.next', { text: nextWarningIn(ladder, { lang: tr.lang }) }),
    ].join('\n');

    const active = [];
    if (activeBan) {
        active.push(activeBan.expires_at
            ? tr.t('member.record.banEnds', { code: activeBan.case_code, date: day(activeBan.expires_at), relative: relative(activeBan.expires_at) })
            : tr.t('member.record.banPermanent', { code: activeBan.case_code }));
    }
    if (activeMute) active.push(tr.t('member.record.muteEnds', { code: activeMute.case_code, date: day(activeMute.expires_at), relative: relative(activeMute.expires_at) }));

    const appealLines = appeals.map((appeal) => tr.t('member.record.appealLine', {
        code: appeal.case_code,
        type: CASE_TYPES.has(appeal.type) ? tr.t(`member.appeal.type.${appeal.type}`) : appeal.type,
        status: APPEAL_STATUSES.has(appeal.status) ? tr.t(`member.record.status.${appeal.status}`) : appeal.status,
        date: day(appeal.created_at),
        decided: appeal.decided_at ? tr.t('member.record.appealDecided', { date: day(appeal.decided_at) }) : '',
    }));

    return [
        { name: tr.t('member.record.field.warns'), value: truncate(warnsValue, 1024) },
        { name: tr.t('member.record.field.ladder'), value: truncate(ladderValue, 1024) },
        { name: tr.t('member.record.field.active'), value: truncate(active.length ? active.join('\n') : tr.t('member.record.none'), 1024) },
        { name: tr.t('member.record.field.appeals'), value: truncate(appealLines.length ? appealLines.join('\n') : tr.t('member.record.noneFiled'), 1024) },
    ];
}
