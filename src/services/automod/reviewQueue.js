// reviewQueue.js — open (unreviewed) review cards for /automod queue: the cards
// posted since startup (reviewRegistry.js) plus, after a restart, the bot's recent
// messages in the review channel that still have buttons. Compact lines are left out:
// they are a record with an Undo button, not a decision.

import { cardTitle } from './reviewFormat.js';
import { getCard, openCards } from './reviewRegistry.js';
import { reviewChannel } from './reviewCards.js';
import { truncate } from '../enforcement/format.js';

const SCAN_LIMIT = 50;
const MAX_LISTED = 20;

/** [{ title, url, at, count }] newest first. */
export async function collectOpenReviews(client) {
    const items = openCards().map((entry) => ({ title: cardTitle(entry), url: entry.url, at: entry.firstAt, count: entry.count }));
    const channel = await reviewChannel(client).catch(() => null);
    const recent = channel ? await channel.messages.fetch({ limit: SCAN_LIMIT }).catch(() => null) : null;
    for (const message of recent?.values() || []) {
        if (message.author?.id !== client.user.id || !message.components?.length || !message.embeds?.length) continue;
        if (getCard(message.id)) continue; // known: already listed if open
        items.push({ title: message.embeds[0].title || 'Review card', url: message.url, at: message.createdTimestamp, count: 1 });
    }
    return items.sort((a, b) => b.at - a.at);
}

const linkText = (text) => String(text || '').replace(/[[\]]/g, '');

/** The queue as embed description text. */
export function formatQueue(items) {
    if (!items.length) return 'Nothing is waiting for review.';
    const lines = items.slice(0, MAX_LISTED).map((item) => {
        const age = `<t:${Math.floor(item.at / 1000)}:R>`;
        const count = item.count > 1 ? ` · ${item.count} messages` : '';
        return `• [${truncate(linkText(item.title), 120)}](${item.url}) · ${age}${count}`;
    });
    if (items.length > MAX_LISTED) lines.push(`…and ${items.length - MAX_LISTED} more.`);
    return lines.join('\n');
}
