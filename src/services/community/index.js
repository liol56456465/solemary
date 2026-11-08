// index.js — startup loading for the community features' in-memory caches.

import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { loadStickies } from './stickyService.js';
import { loadTags } from './tagService.js';
import { loadCommunitySettings } from './settingsService.js';
import { loadStarboardPosts } from './starboardService.js';
import { loadFeeds } from './feedService.js';

const LOADERS = [
    ['settings', loadCommunitySettings],
    ['stickies', loadStickies],
    ['tags', loadTags],
    ['starboard posts', loadStarboardPosts],
    ['feeds', loadFeeds],
];

// Which caches loaded (a loader that threw, or returned null because the database was down,
// is not loaded). The dashboard asks ensureCommunityCaches() before it shows or changes
// anything here, so an outage at boot never shows empty defaults as the real settings.
const loaded = new Set();
let lastRetryAt = 0;
export const COMMUNITY_RETRY_MS = 30 * 1000;

async function runLoader(name, load, client) {
    const count = await load(client);
    if (count == null) return null;
    loaded.add(name);
    return count;
}

/** Loads every community cache; one failing loader does not stop the others. Returns a summary line. */
export async function loadCommunityCaches(client) {
    const parts = [];
    for (const [name, load] of LOADERS) {
        try {
            const count = await runLoader(name, load, client);
            parts.push(`${name} ${count == null ? 'not loaded (database unavailable)' : count}`);
        } catch (error) {
            logger.error(`Community cache ${name} could not be loaded: ${error.message}`);
            parts.push(`${name} failed`);
        }
    }
    return parts.join(', ');
}

/** True when every community cache was read from the database. */
export function communityCachesLoaded() {
    return LOADERS.every(([name]) => loaded.has(name));
}

/**
 * For the dashboard: resolves when every community cache is loaded. A cache that failed at
 * startup is loaded again here (at most every COMMUNITY_RETRY_MS); while one is still missing
 * this throws a database error ("not responding, nothing was changed"), never defaults.
 */
export async function ensureCommunityCaches(client, { now = Date.now() } = {}) {
    if (communityCachesLoaded()) return;
    if (now - lastRetryAt >= COMMUNITY_RETRY_MS) {
        lastRetryAt = now;
        for (const [name, load] of LOADERS) {
            if (loaded.has(name)) continue;
            try {
                await runLoader(name, load, client);
            } catch (error) {
                logger.warn(`Community cache ${name} still not loaded: ${error.message}`);
            }
        }
    }
    if (!communityCachesLoaded()) {
        throw createError('Community caches not loaded', ErrorTypes.DATABASE,
            'The database is not responding right now, so the community settings cannot be shown or changed. Please try again in a minute.',
            { missing: LOADERS.map(([name]) => name).filter((name) => !loaded.has(name)), expected: true });
    }
}

/** For tests: mark caches loaded (names, or all) / forget them, and reset the retry timer. */
export function setCommunityCachesLoadedForTests(names = LOADERS.map(([name]) => name)) {
    loaded.clear();
    for (const name of names) loaded.add(name);
    lastRetryAt = 0;
}
