// caseNotesService.js: private staff notes and tags on a case.
//
// Tags: short lowercase labels ("scam", "alt", "raid") in mod_cases.tags, used to group and
// search cases. Notes: free text in mod_case_notes, newest last. Both are staff-only: never
// in member DMs, My record or the member's data export.

import { query as defaultQuery, T } from './db.js';
import { pgConfig } from '../../config/database/postgres.js';

export const MAX_TAGS = 10;
export const TAG_MAX = 20;
export const NOTE_MAX = 1000;
export const NOTES_SHOWN = 15;

export class CaseNoteError extends Error {
    constructor(message) { super(message); this.userMessage = message; }
}

/** "Scam, alt ,raid" → ['alt', 'raid', 'scam']; "none" or "" → []. Throws on bad tags. */
export function normalizeTags(input) {
    const text = String(input ?? '').trim().toLowerCase();
    if (!text || text === 'none' || text === '-') return [];
    const tags = [...new Set(text.split(/[,\s]+/).map((t) => t.replace(/^#/, '')).filter(Boolean))];
    for (const tag of tags) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(tag) || tag.length > TAG_MAX) {
            throw new CaseNoteError(`"${tag.slice(0, 30)}" is not a valid tag. Use letters, numbers and dashes, up to ${TAG_MAX} characters.`);
        }
    }
    if (tags.length > MAX_TAGS) throw new CaseNoteError(`A case can have at most ${MAX_TAGS} tags.`);
    return tags.sort();
}

export function createCaseNotes({ query = defaultQuery, notesTable = pgConfig.tables.mod_case_notes } = {}) {
    async function caseInGuild(guildId, caseCode) {
        const { rows: [row] } = await query(`SELECT case_code, guild_id, tags FROM ${T.cases} WHERE case_code = $1`, [caseCode]);
        if (!row || row.guild_id !== guildId) throw new CaseNoteError(`No case with code \`${caseCode}\` in this server.`);
        return row;
    }
    return {
        async addNote(guildId, caseCode, author, text) {
            const clean = String(text ?? '').trim();
            if (!clean) throw new CaseNoteError('The note is empty.');
            if (clean.length > NOTE_MAX) throw new CaseNoteError(`Keep notes under ${NOTE_MAX} characters.`);
            await caseInGuild(guildId, caseCode);
            const { rows: [row] } = await query(
                `INSERT INTO ${notesTable} (case_code, author_id, author_username, text) VALUES ($1, $2, $3, $4) RETURNING *`,
                [caseCode, author.id, author.username, clean],
            );
            return row;
        },
        async listNotes(caseCode, limit = NOTES_SHOWN) {
            const { rows } = await query(`SELECT * FROM ${notesTable} WHERE case_code = $1 ORDER BY created_at DESC, id DESC LIMIT ${Number(limit)}`, [caseCode]);
            return rows.reverse();
        },
        async countNotes(caseCode) {
            const { rows: [row] } = await query(`SELECT COUNT(*)::int AS n FROM ${notesTable} WHERE case_code = $1`, [caseCode]);
            return row?.n || 0;
        },
        /** Replaces a case's tags. Returns { before, after }. */
        async setTags(guildId, caseCode, tags) {
            const current = await caseInGuild(guildId, caseCode);
            const { rows: [row] } = await query(`UPDATE ${T.cases} SET tags = $2 WHERE case_code = $1 RETURNING tags`, [caseCode, tags]);
            return { before: current.tags || [], after: row?.tags || [] };
        },
        /** The tags used in a server, most used first (for autocomplete). */
        async usedTags(guildId, prefix = '', limit = 25) {
            const { rows } = await query(
                `SELECT tag, COUNT(*)::int AS n FROM ${T.cases}, unnest(tags) AS tag
                 WHERE guild_id = $1 AND tag LIKE $2 GROUP BY tag ORDER BY n DESC, tag LIMIT ${Number(limit)}`,
                [guildId, `${String(prefix).toLowerCase().replace(/[^a-z0-9-]/g, '')}%`],
            );
            return rows.map((r) => r.tag);
        },
    };
}

export const caseNotes = createCaseNotes();

/** "#alt #scam" or "none". */
export function tagsText(tags) {
    return tags?.length ? tags.map((t) => `#${t}`).join(' ') : 'none';
}
