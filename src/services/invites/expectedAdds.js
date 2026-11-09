// expectedAdds.js — "Mewvo itself is about to add this member" markers for invite tracking.
//
// The OAuth member backup (oauthVerification.js addMemberWithStoredToken, guilds.join) puts a
// member into a server without any invite. Right before that REST call it marks (guild, user);
// the join that follows within EXPECT_MS is recorded with source 'bot' and never consumes an
// invite use. Memory only, bounded; a restart in between just gives 'unknown'.
// No imports beyond BoundedMap, so oauthVerification.js can use it without a cycle.

import { BoundedMap } from '../../utils/boundedMap.js';

export const EXPECT_MS = 60_000;
const MAX_MARKERS = 5000;
const markers = new BoundedMap(MAX_MARKERS); // `${guildId}:${userId}` → until (ms)

/** Marks that Mewvo is adding userId to guildId now (OAuth guilds.join). */
export function expectBotAdd(guildId, userId, now = Date.now()) {
    if (!guildId || !userId) return;
    markers.set(`${guildId}:${userId}`, now + EXPECT_MS);
}

/** True (once) when this join was Mewvo's own add; the marker is used up either way. */
export function takeExpectedBotAdd(guildId, userId, now = Date.now()) {
    const key = `${guildId}:${userId}`;
    const until = markers.get(key);
    if (until === undefined) return false;
    markers.delete(key);
    return until >= now;
}

/** Drops the marker again (the add failed or the member was already there). */
export function clearExpectedBotAdd(guildId, userId) {
    markers.delete(`${guildId}:${userId}`);
}

export function resetExpectedAddsForTests() {
    markers.clear();
}
