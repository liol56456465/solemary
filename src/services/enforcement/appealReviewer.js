// appealReviewer.js — independent appeal review (the per-server setting
// `independentAppealReview`, default off). When it is on, the moderator who issued a
// punishment may not decide its appeal: another staff member has to. decideAppeal()
// enforces it for every path (Accept / Deny buttons, /appeals, the dashboard); the pages
// and the dossier use the same helpers to show it.
//
// Exceptions:
//   - OWNER_IDS may decide anyway (emergency override, logged as an owner override).
//   - Cases with no human moderator (warn-ladder bans, automod and other bot actions:
//     is_auto, or the bot's own id as moderator) never conflict.
//
// Pure apart from the settings cache read: no database, no Discord calls. A non-home server
// whose settings could not be read throws (SettingsUnavailableError) instead of assuming off.

import { hasOwnerPower } from '../../utils/ownerPower.js';
import { resolveSetting } from '../settings/guildSettings.js';

export const SECOND_REVIEWER_MESSAGE = 'You issued this punishment, so another staff member has to decide this appeal.';

/**
 * The setting for the case's server (resolveSetting: only that server's own value, never the
 * main server's). No guild → off. Throws SettingsUnavailableError when a non-home server's
 * settings could not be read: the decision is refused then, never decided on a guessed "off".
 */
export function isIndependentReviewOn(guildId) {
    if (!guildId) return false;
    return resolveSetting(String(guildId), 'independentAppealReview') === true;
}

/** True when a person (not the bot, not the warn ladder) issued the case. */
export function hasHumanIssuer(record, botUserId = null) {
    if (!record || record.is_auto || !record.moderator_id) return false;
    return !(botUserId && String(record.moderator_id) === String(botUserId));
}

/** True when the setting is on and this case needs someone other than its issuer to decide. */
export function needsSecondReviewer(record, { botUserId = null, enabled = isIndependentReviewOn(record?.guild_id) } = {}) {
    return Boolean(enabled && hasHumanIssuer(record, botUserId));
}

/**
 * May `deciderId` decide the appeal on `record`?
 *   { allowed: true }                          no conflict (or the setting is off)
 *   { allowed: true, ownerOverride: true }     the issuer is a bot owner: allowed, must be logged
 *   { allowed: false, message }                the issuer may not decide
 */
// The owner override only applies to cases of Mewvo's own servers (utils/ownerPower.js).
export function checkAppealReviewer(record, deciderId, { botUserId = null, enabled = isIndependentReviewOn(record?.guild_id), isOwner = (id) => hasOwnerPower(id, record?.guild_id) } = {}) {
    if (!needsSecondReviewer(record, { botUserId, enabled })) return { allowed: true };
    if (String(record.moderator_id) !== String(deciderId)) return { allowed: true };
    if (isOwner(deciderId)) return { allowed: true, ownerOverride: true };
    return { allowed: false, message: SECOND_REVIEWER_MESSAGE };
}
