// db.js — table names and query helpers for the community features (sticky
// messages, tags, suggestions, starboard, feeds). They share the enforcement
// pool helpers: reads throw when the database is down, writes resolve or throw.

import { pgConfig } from '../../config/database/postgres.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';

export { query, withTransaction, isUniqueViolation, isEnforcementDbAvailable as isCommunityDbAvailable } from '../enforcement/db.js';

export const CT = {
    sticky: pgConfig.tables.sticky_messages,
    tags: pgConfig.tables.tags,
    settings: pgConfig.tables.community_settings,
    suggestions: pgConfig.tables.suggestions,
    suggestionVotes: pgConfig.tables.suggestion_votes,
};

/** An expected, user-facing error (shown as-is by the command error handler). */
export function userError(message) {
    return createError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}
