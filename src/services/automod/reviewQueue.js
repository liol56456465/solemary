// reviewQueue.js — open (unreviewed) review cards for /automod queue: the cards
// posted since startup (reviewRegistry.js) plus, after a restart, the bot's recent
// messages in the review channel that still have buttons. Compact lines are left out:
// they are a record with an Undo button, not a decision.

import { cardTitle } from './reviewFormat.js';
import { getCard, openCards } from './reviewRegistry.js';
import { reviewChannel } from './reviewCards.js';
import { staffGuildId } from './channelRouting.js';
import { truncate } from '../enforcement/format.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { botText } from '../../utils/botText.js';

const SCAN_LIMIT = 50;
const MAX_LISTED = 20;

/**
 * [{ title, url, at, count }] newest first. `guildId`: whose review channel is scanned (default:
 * main). Only that server's cards are listed: the home servers share the main server's review
 * channel (as before), any other server sees only its own. `lang`: the language of the titles of
 * cards posted since startup (older cards keep the title they were posted with). Default English.
 */
export async function collectOpenReviews(client, guildId = enforcementConfig.mainGuildId, { lang = 'en' } = {}) {
    const staff = staffGuildId(guildId);
    const items = openCards().filter((entry) => staffGuildId(entry.guildId) === staff).map((entry) => ({ title: cardTitle(entry, { lang }), url: entry.url, at: entry.firstAt, count: entry.count }));
    const channel = await reviewChannel(client, guildId).catch(() => null);
    const recent = channel ? await channel.messages.fetch({ limit: SCAN_LIMIT }).catch(() => null) : null;
    for (const message of recent?.values() || []) {
        if (message.author?.id !== client.user.id || !message.components?.length || !message.embeds?.length) continue;
        if (getCard(message.id)) continue; // known: already listed if open
        items.push({ title: message.embeds[0].title || botText(lang).t('automod.review.queue.reviewCard'), url: message.url, at: message.createdTimestamp, count: 1 });
    }
    return items.sort((a, b) => b.at - a.at);
}

const linkText = (text) => String(text || '').replace(/[[\]]/g, '');

/** The queue as embed description text (`lang`: the reader's language, default English). */
export function formatQueue(items, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!items.length) return tr.t('automod.review.queue.empty');
    const lines = items.slice(0, MAX_LISTED).map((item) => {
        const age = `<t:${Math.floor(item.at / 1000)}:R>`;
        const count = item.count > 1 ? ` · ${tr.tp('automod.review.compact.messages', item.count)}` : '';
        return `• [${truncate(linkText(item.title), 120)}](${item.url}) · ${age}${count}`;
    });
    if (items.length > MAX_LISTED) lines.push(tr.tp('automod.review.queue.more', items.length - MAX_LISTED));
    return lines.join('\n');
}
