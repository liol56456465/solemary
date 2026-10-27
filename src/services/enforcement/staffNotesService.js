// staffNotesService.js — staff notes about a member (formerly /usernotes), shown in
// /background and on the dashboard's user page. Stored as one list per member under
// the usernotes key: [{ id, content, type, author, authorId, timestamp }].
// Every write goes through db.update (serialized per key).

import { db } from '../../utils/database/wrapper.js';
import { getUserNotesKey } from '../../utils/database/keys.js';

export const NOTE_MAX = 1000;

export async function listNotes(guildId, userId) {
    const notes = await db.get(getUserNotesKey(guildId, userId), []);
    return Array.isArray(notes) ? notes : [];
}

/** Adds a note; author: { id, tag }. Returns the stored note. */
export async function addNote(guildId, userId, content, author) {
    const text = String(content || '').trim().slice(0, NOTE_MAX);
    if (!text) return null;
    const note = {
        id: Date.now(),
        content: text,
        type: 'neutral',
        author: author.tag,
        authorId: author.id,
        timestamp: new Date().toISOString(),
    };
    await db.update(getUserNotesKey(guildId, userId), (notes) => [...(Array.isArray(notes) ? notes : []), note], []);
    return note;
}

/**
 * Removes one note, chosen by its 1-based position ({ number }, as /background shows
 * it) or by its id ({ id }, the dashboard: stable even when another note is removed
 * meanwhile). Returns the removed note or null.
 */
export async function removeNote(guildId, userId, { number = null, id = null } = {}) {
    let removed = null;
    await db.update(getUserNotesKey(guildId, userId), (notes) => {
        const list = Array.isArray(notes) ? [...notes] : [];
        const index = id !== null
            ? list.findIndex((note) => String(note?.id) === String(id))
            : (Number.isInteger(number) && number >= 1 && number <= list.length ? number - 1 : -1);
        if (index >= 0) [removed] = list.splice(index, 1);
        return list;
    }, []);
    return removed;
}
