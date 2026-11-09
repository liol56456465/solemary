// purgePreview.js — /purge asks before it deletes (audit 3.8).
//
// /purge amount → an ephemeral preview: "Delete N messages from the last 14 days in #channel?"
// (plus how many of the newest `amount` are older than 14 days and will be skipped: Discord does
// not bulk-delete those), with Delete / Cancel buttons (customId purge:<confirm|cancel>:<nonce>).
// The preview remembers exactly which messages it counted (bounded in-memory map, 2 minutes);
// Delete removes only those, so messages posted after the preview are never touched. Every click
// is acknowledged first (deferUpdate, 3 s), then re-checked: the clicker must be the moderator who
// ran /purge and must still pass the Administrator gate (hasAdminAccess, the same rule as the
// command). An expired or unknown preview says so and deletes nothing.

import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { BULK_DELETE_MAX_AGE_MS } from '../channelToolsService.js';

export const PURGE_BUTTON = 'purge';
export const PURGE_PREVIEW_TTL_MS = 2 * 60 * 1000;
export const PURGE_PREVIEW_MAX = 500;

/** Pure: the fetched messages split into what bulk delete can remove and what is too old. */
export function splitByAge(messages, now = Date.now()) {
    const fresh = [];
    const old = [];
    for (const message of messages) {
        if (!message?.id) continue;
        const created = Number(message.createdTimestamp ?? now);
        (now - created < BULK_DELETE_MAX_AGE_MS ? fresh : old).push({ id: String(message.id), createdTimestamp: created });
    }
    return { fresh, old };
}

/** A bounded TTL map of open previews: nonce → { guildId, channelId, userId, fresh, old, requested, expiresAt }. */
export function createPurgePreviewStore({ ttlMs = PURGE_PREVIEW_TTL_MS, max = PURGE_PREVIEW_MAX, nonce = () => randomBytes(6).toString('hex') } = {}) {
    const entries = new Map();
    function sweep(now) {
        for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
        while (entries.size >= max) entries.delete(entries.keys().next().value);
    }
    return {
        entries,
        ttlMs,
        create(state, now = Date.now()) {
            sweep(now);
            const id = nonce();
            entries.set(id, { ...state, expiresAt: now + ttlMs });
            return { nonce: id, expiresAt: now + ttlMs };
        },
        /** The preview, or null when unknown/expired (an expired one is dropped). */
        peek(id, now = Date.now()) {
            const entry = entries.get(id);
            if (!entry) return null;
            if (entry.expiresAt <= now) { entries.delete(id); return null; }
            return entry;
        },
        /** Takes the preview out (one click wins; a second click finds nothing). */
        take(id, now = Date.now()) {
            const entry = this.peek(id, now);
            if (entry) entries.delete(id);
            return entry;
        },
    };
}

export const purgePreviews = createPurgePreviewStore();

export function purgeButtons(nonce, tr) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PURGE_BUTTON}:confirm:${nonce}`).setLabel(tr.t('moderation.purge.confirmButton')).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${PURGE_BUTTON}:cancel:${nonce}`).setLabel(tr.t('moderation.purge.cancelButton')).setStyle(ButtonStyle.Secondary),
    );
}

/** The preview text (moderator's language). */
export function previewText(tr, { fresh, old, channel, expiresAt }) {
    const lines = [tr.tp('moderation.purge.preview', fresh, { channel: String(channel) })];
    if (old > 0) lines.push(tr.tp('moderation.purge.previewOld', old));
    lines.push(tr.t('moderation.purge.previewNote'));
    lines.push(tr.t('moderation.purge.previewExpires', { time: `<t:${Math.floor(expiresAt / 1000)}:R>` }));
    return lines.join('\n');
}

/**
 * Deletes the previewed messages that are still under 14 days old. Returns
 * { deleted, skippedOld, skippedGone }: skippedOld = too old (at preview time or since),
 * skippedGone = already deleted by someone else.
 */
export async function deletePreviewed(channel, entry, now = Date.now()) {
    const { fresh, old } = splitByAge(entry.fresh, now);
    const skippedOld = entry.old.length + old.length;
    if (!fresh.length) return { deleted: 0, skippedOld, skippedGone: 0 };
    const ids = fresh.map((m) => m.id);
    let deleted;
    if (ids.length === 1) {
        // discord.js turns a one-message bulk delete into a single delete, which throws on a gone message.
        deleted = await channel.messages.delete(ids[0]).then(() => 1).catch((error) => {
            if (error?.code === 10008) return 0;
            throw error;
        });
    } else {
        const result = await channel.bulkDelete(ids, true).catch((error) => {
            if (error?.code === 10008) return { size: 0 };
            throw error;
        });
        // discord.js returns one entry per requested id, so a message someone else removed meanwhile
        // still counts as deleted here; "already deleted" is only known on the one-message path.
        deleted = result?.size ?? ids.length;
    }
    return { deleted, skippedOld, skippedGone: Math.max(0, ids.length - deleted) };
}

/** The result line (moderator's language). */
export function resultText(tr, { deleted, skippedOld, skippedGone, channel }) {
    let text = tr.tp('moderation.purge.done', deleted, { channel: String(channel) });
    if (skippedOld > 0) text += ` ${tr.tp('moderation.purge.skippedOld', skippedOld)}`;
    if (skippedGone > 0) text += ` ${tr.tp('moderation.purge.skippedGone', skippedGone)}`;
    return text;
}
