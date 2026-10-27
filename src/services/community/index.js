// index.js — startup loading for the community features' in-memory caches.

import { logger } from '../../utils/logger.js';
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

/** Loads every community cache; one failing loader does not stop the others. Returns a summary line. */
export async function loadCommunityCaches(client) {
    const parts = [];
    for (const [name, load] of LOADERS) {
        try {
            const count = await load(client);
            parts.push(`${name} ${count == null ? 'not loaded (database unavailable)' : count}`);
        } catch (error) {
            logger.error(`Community cache ${name} could not be loaded: ${error.message}`);
            parts.push(`${name} failed`);
        }
    }
    return parts.join(', ');
}
