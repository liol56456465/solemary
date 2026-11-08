// databaseLookupView.js — the /database reply: one embed page plus Previous / Next buttons.
// customId: dblookup:<ownerId>:<nonce>:<prev|next>:<page>. The button handler re-checks that
// the clicker is that owner, in OWNER_IDS and in the owner-tools server.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { botText } from '../utils/botText.js';

export const LOOKUP_BUTTON_ID = 'dblookup';
export const LOOKUP_EXPIRED = 'This result expired, run /database again.';
export const LOOKUP_DB_ERROR = 'The database is not responding right now, so nothing was changed. Try again in a moment.';
// The same two texts in the owner's Discord language (the replies are ephemeral).
export const lookupExpired = ({ lang = 'en' } = {}) => botText(lang).t('owner.database.expired');
export const lookupDbError = ({ lang = 'en' } = {}) => botText(lang).t('owner.database.dbError');

export function lookupCustomId(ownerId, nonce, direction, page) {
    return `${LOOKUP_BUTTON_ID}:${ownerId}:${nonce}:${direction}:${page}`;
}

/** Parses a lookup button's customId args (after the prefix), or null. */
export function parseLookupArgs(args = []) {
    const [ownerId, nonce, direction, page] = args;
    if (!/^\d{17,20}$/.test(ownerId || '') || !/^[a-z0-9]{6,16}$/.test(nonce || '')) return null;
    if (direction !== 'prev' && direction !== 'next') return null;
    const n = Number.parseInt(page, 10);
    return Number.isInteger(n) && n >= 0 ? { ownerId, nonce, page: n } : null;
}

/** The message for page `index` of a stored entry ({ title, pages }). No mentions. */
export function lookupMessage({ title, pages }, index, { ownerId, nonce, lang = 'en' }) {
    const tr = botText(lang);
    const total = pages.length || 1;
    const page = Math.min(Math.max(0, index), total - 1);
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(pages[page] || tr.t('owner.database.nothingFound'))
        .setColor(0x5865f2)
        .setFooter({ text: tr.t('owner.database.footer', { page: page + 1, total }) });
    const components = total > 1 ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(lookupCustomId(ownerId, nonce, 'prev', Math.max(0, page - 1)))
            .setLabel(tr.t('owner.database.previous')).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(lookupCustomId(ownerId, nonce, 'next', Math.min(total - 1, page + 1)))
            .setLabel(tr.t('owner.database.next')).setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
    )] : [];
    // No flags: this goes to editReply on an already ephemeral (deferred) reply.
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}
