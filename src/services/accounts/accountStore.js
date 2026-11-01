// accountStore.js — Mewvo accounts in PostgreSQL (tables member_accounts, member_account_tokens,
// member_account_recovery_codes, member_account_bonuses, member_account_counters; schema v8).
// Accounts have no email since schema v8 (owner, 2026-11-01): the email column stays for older
// rows (nullable), nothing writes it. A forgotten password is reset through the linked Discord
// account (accountRoutes.js); member_account_tokens is no longer written either.
//
// Every multi-step change runs in one transaction with the rows it depends on locked.
// Errors are thrown (database down → the page says nothing was changed); a refusal the
// person can fix is an AccountError with a message for the page.
//
// Early-account bonuses (owner, 2026-11-01), counted per DISCORD account at link time:
//   - The first link of a Discord id takes the next number from the counter row
//     member_account_counters('discord_links'), locked with SELECT ... FOR UPDATE, so two
//     links at the same moment wait for each other and can never get the same number
//     (link_number is also UNIQUE, a second guard).
//   - 1..30 may claim a 1-letter username once; 1..100 get Mewvo Pro for 6 months (183 days) through the
//     premium store, in the SAME transaction (so a slot is never used without the plan, or
//     the other way round). 101 and later get nothing.
//   - A Discord id that already has a bonus row (linked before, to this or another account)
//     never gets a second one.

import { pgConfig } from '../../config/database/postgres.js';
import { createPremiumStore, PremiumError } from '../billing/premiumService.js';
import { cleanAccountExport } from '../privacy/dataExport.js';
import {
    AccountError, LETTERS, LETTER_CLAIM_LIMIT, PRO_BONUS_DAYS, PRO_BONUS_PLAN, bonusFor,
} from './accountCore.js';

/** An account that never linked Discord is deleted after 7 days (frees the username). */
export const UNLINKED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const COUNTER = 'discord_links';
const SNOWFLAKE = /^\d{17,20}$/;

const isUnique = (error, fragment = '') => error?.code === '23505' && String(error?.constraint || '').includes(fragment);

/** The premium grant inside the link transaction (the store bound to that client). */
function defaultPremiumGrant(client, tables) {
    return createPremiumStore({ tables, query: (text, params) => client.query(text, params), withTransaction: (fn) => fn(client) });
}

/**
 * query / withTransaction: the enforcement pool helpers by default (imported lazily so unit
 * tests stay DB-free). premiumFor(client) → an object with grant(); now() for tests.
 */
export function createAccountStore({
    query = null, withTransaction = null, tables = pgConfig.tables, now = () => Date.now(), premiumFor = (client) => defaultPremiumGrant(client, tables),
} = {}) {
    const A = tables.member_accounts;
    const T = tables.member_account_tokens;
    const R = tables.member_account_recovery_codes;
    const B = tables.member_account_bonuses;
    const C = tables.member_account_counters;
    let helpers = null;
    async function db() {
        if (helpers) return helpers;
        if (query && withTransaction) helpers = { query, withTransaction };
        else {
            const mod = await import('../enforcement/db.js');
            helpers = { query: query || mod.query, withTransaction: withTransaction || mod.withTransaction };
        }
        return helpers;
    }
    const at = (ms = now()) => new Date(ms);
    async function q(text, params) {
        return (await db()).query(text, params);
    }
    async function tx(fn) {
        return (await db()).withTransaction(fn);
    }

    /** A new account (username + password hash, no email). A taken username is an AccountError. */
    async function createAccount({ username, passwordHash }) {
        try {
            const { rows: [account] } = await q(
                `INSERT INTO ${A} (username, password_hash, age_confirmed_at, terms_accepted_at, created_at)
                 VALUES ($1, $2, $3, $3, $3) RETURNING *`, [username, passwordHash, at()]);
            if (!account) throw new Error('account insert returned no row');
            return { account };
        } catch (error) {
            if (isUnique(error, 'username')) throw new AccountError('That username is already taken. Choose another one.', 409, 'username_taken');
            throw error;
        }
    }

    async function findById(id) {
        if (!/^\d{1,18}$/.test(String(id ?? ''))) return null;
        const { rows: [row] } = await q(`SELECT * FROM ${A} WHERE id = $1`, [String(id)]);
        return row || null;
    }

    /** By username (lowercased here). */
    async function findByLogin(identifier) {
        const text = String(identifier || '').trim().toLowerCase();
        if (!text) return null;
        const { rows: [row] } = await q(`SELECT * FROM ${A} WHERE username = $1`, [text]);
        return row || null;
    }

    /** The account a Discord id is linked to (password reset through Discord), or null. */
    async function findByDiscordId(discordUserId) {
        if (!SNOWFLAKE.test(String(discordUserId || ''))) return null;
        const { rows: [row] } = await q(`SELECT * FROM ${A} WHERE discord_user_id = $1`, [String(discordUserId)]);
        return row || null;
    }

    async function recordLogin(id) {
        await q(`UPDATE ${A} SET last_login_at = $2 WHERE id = $1`, [id, at()]);
    }

    /** A new password (settings, or the reset through Discord). Old email links from before v8 are used up too. */
    async function setPassword(id, passwordHash) {
        return tx(async (client) => {
            const { rowCount } = await client.query(
                `UPDATE ${A} SET password_hash = $2, password_changed_at = $3, pending_email = NULL WHERE id = $1`, [id, passwordHash, at()]);
            if (rowCount !== 1) throw new Error('password update changed no row');
            await client.query(`UPDATE ${T} SET used_at = $2 WHERE account_id = $1 AND used_at IS NULL`, [id, at()]);
        });
    }

    // ── 2FA ───────────────────────────────────────────────────────────────

    /** Turns 2FA on: the encrypted secret, the step already used to confirm it, the recovery code hashes. */
    async function enableTotp(id, { secretEnc, step, codeHashes }) {
        return tx(async (client) => {
            const { rowCount } = await client.query(
                `UPDATE ${A} SET totp_secret_enc = $2, totp_enabled_at = $3, totp_last_step = $4 WHERE id = $1 AND totp_enabled_at IS NULL`,
                [id, secretEnc, at(), step]);
            if (rowCount !== 1) throw new AccountError('Two-step login is already on.', 409);
            await client.query(`DELETE FROM ${R} WHERE account_id = $1`, [id]);
            for (const hash of codeHashes) await client.query(`INSERT INTO ${R} (account_id, code_hash) VALUES ($1, $2)`, [id, hash]);
        });
    }

    async function disableTotp(id) {
        return tx(async (client) => {
            await client.query(`UPDATE ${A} SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1`, [id]);
            await client.query(`DELETE FROM ${R} WHERE account_id = $1`, [id]);
        });
    }

    /** Marks a TOTP step as used; false when it (or a later one) was used already (replay). */
    async function useTotpStep(id, step) {
        const { rowCount } = await q(
            `UPDATE ${A} SET totp_last_step = $2 WHERE id = $1 AND totp_enabled_at IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < $2)`, [id, step]);
        return rowCount === 1;
    }

    /** Uses up one recovery code; false when unknown or already used. */
    async function useRecoveryCode(id, codeHash) {
        const { rowCount } = await q(`UPDATE ${R} SET used_at = $3 WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL`, [id, codeHash, at()]);
        return rowCount === 1;
    }

    async function recoveryCodesLeft(id) {
        const { rows: [row] } = await q(`SELECT COUNT(*)::int AS n FROM ${R} WHERE account_id = $1 AND used_at IS NULL`, [id]);
        return row?.n || 0;
    }

    // ── Discord link + bonuses ────────────────────────────────────────────

    /** The next link number from the locked counter row. Inside a transaction. */
    async function nextLinkNumber(client) {
        await client.query(`INSERT INTO ${C} (name, value) VALUES ($1, 0) ON CONFLICT (name) DO NOTHING`, [COUNTER]);
        const { rows: [row] } = await client.query(`SELECT value FROM ${C} WHERE name = $1 FOR UPDATE`, [COUNTER]);
        const n = Number(row.value) + 1;
        await client.query(`UPDATE ${C} SET value = $2 WHERE name = $1`, [COUNTER, n]);
        return n;
    }

    /**
     * Binds a Discord id to the account and, the first time this Discord id is ever linked,
     * hands out its bonus. Returns { account, bonus: { kind: 'new' | 'repeat', linkNumber,
     * pro: boolean, proNote, letter: boolean }, premium (grant result or null) }.
     * AccountError when the Discord id is linked to another account, or this account already
     * has another Discord id.
     */
    async function linkDiscord({ accountId, discordUserId, discordUsername = null }) {
        if (!SNOWFLAKE.test(String(discordUserId || ''))) throw new AccountError('Discord did not return a user.', 502);
        try {
            return await tx(async (client) => {
                const { rows: [account] } = await client.query(`SELECT * FROM ${A} WHERE id = $1 FOR UPDATE`, [accountId]);
                if (!account) throw new AccountError('This account no longer exists.', 404, 'missing');
                if (account.discord_user_id && account.discord_user_id !== discordUserId) {
                    throw new AccountError('This account is already linked to another Discord account. Unlink it first in Account settings.', 409, 'has_other');
                }
                const { rows: other } = await client.query(`SELECT id FROM ${A} WHERE discord_user_id = $1 AND id <> $2`, [discordUserId, accountId]);
                if (other.length) throw new AccountError('That Discord account is already linked to another Mewvo account.', 409, 'linked_elsewhere');
                const { rows: [linked] } = await client.query(
                    `UPDATE ${A} SET discord_user_id = $2, discord_username = $3, discord_linked_at = $4 WHERE id = $1 RETURNING *`,
                    [accountId, discordUserId, discordUsername ? String(discordUsername).slice(0, 100) : null,
                        account.discord_user_id === discordUserId && account.discord_linked_at ? account.discord_linked_at : at()]);
                const { rows: [existing] } = await client.query(`SELECT * FROM ${B} WHERE discord_user_id = $1 FOR UPDATE`, [discordUserId]);
                if (existing) {
                    // The Discord id's current account (the bonus account may have been deleted).
                    if (!existing.account_id) await client.query(`UPDATE ${B} SET account_id = $2 WHERE discord_user_id = $1`, [discordUserId, accountId]);
                    return { account: linked, bonus: { kind: 'repeat', linkNumber: existing.link_number, pro: false, proNote: null, letter: false }, premium: null };
                }
                const linkNumber = await nextLinkNumber(client);
                const wins = bonusFor(linkNumber);
                let premium = null;
                let proNote = null;
                if (wins.pro) {
                    try {
                        premium = await premiumFor(client).grant({ userId: discordUserId, planId: PRO_BONUS_PLAN, days: PRO_BONUS_DAYS, actor: 'account bonus', source: 'bonus' });
                    } catch (error) {
                        // A higher plan already running: nothing is written by grant before this check.
                        if (!(error instanceof PremiumError)) throw error;
                        proNote = error.userMessage;
                    }
                }
                await client.query(
                    `INSERT INTO ${B} (discord_user_id, account_id, link_number, pro_granted_at, pro_skip_reason, letter_eligible, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [discordUserId, accountId, linkNumber, premium ? at() : null, proNote ? proNote.slice(0, 200) : null, wins.letter, at()]);
                return { account: linked, bonus: { kind: 'new', linkNumber, pro: Boolean(premium), proNote, letter: wins.letter }, premium };
            });
        } catch (error) {
            if (isUnique(error, 'discord_user_id')) throw new AccountError('That Discord account is already linked to another Mewvo account.', 409, 'linked_elsewhere');
            throw error;
        }
    }

    async function unlinkDiscord(accountId) {
        const { rows: [row] } = await q(
            `UPDATE ${A} SET discord_user_id = NULL, discord_username = NULL, discord_linked_at = NULL WHERE id = $1 RETURNING *`, [accountId]);
        return row || null;
    }

    async function bonusOf(discordUserId) {
        if (!SNOWFLAKE.test(String(discordUserId || ''))) return null;
        const { rows: [row] } = await q(`SELECT * FROM ${B} WHERE discord_user_id = $1`, [discordUserId]);
        return row || null;
    }

    /** True when this account may pick a 1-letter name now. */
    function canClaimLetter(bonus, account) {
        return Boolean(bonus && account?.discord_user_id && bonus.discord_user_id === account.discord_user_id
            && bonus.letter_eligible && !bonus.letter_claimed && !bonus.letter_declined_at);
    }

    /** The 1-letter names nobody uses. */
    async function freeLetters() {
        const { rows } = await q(`SELECT username FROM ${A} WHERE length(username) = 1`, []);
        const used = new Set(rows.map((r) => r.username));
        return LETTERS.filter((letter) => !used.has(letter));
    }

    /** Claims a 1-letter username (once per Discord account, only for link numbers 1..30). */
    async function claimLetter({ accountId, letter }) {
        try {
            return await tx(async (client) => {
                const { rows: [account] } = await client.query(`SELECT * FROM ${A} WHERE id = $1 FOR UPDATE`, [accountId]);
                if (!account?.discord_user_id) throw new AccountError('Link your Discord account first.', 409);
                const { rows: [bonus] } = await client.query(`SELECT * FROM ${B} WHERE discord_user_id = $1 FOR UPDATE`, [account.discord_user_id]);
                if (!canClaimLetter(bonus, account)) throw new AccountError('This account cannot claim a 1-letter username.', 409, 'not_eligible');
                const { rows: [count] } = await client.query(`SELECT COUNT(*)::int AS n FROM ${B} WHERE letter_claimed IS NOT NULL`, []);
                if (count.n >= LETTER_CLAIM_LIMIT) throw new AccountError('All 1-letter usernames have been claimed.', 409, 'all_claimed');
                const { rows: [updated] } = await client.query(`UPDATE ${A} SET username = $2 WHERE id = $1 RETURNING *`, [accountId, letter]);
                await client.query(`UPDATE ${B} SET letter_claimed = $2, letter_claimed_at = $3, account_id = $4 WHERE discord_user_id = $1`,
                    [account.discord_user_id, letter, at(), accountId]);
                return updated;
            });
        } catch (error) {
            if (isUnique(error, 'username') || isUnique(error, 'letter')) throw new AccountError('Someone else just took that letter. Choose another one.', 409, 'letter_taken');
            throw error;
        }
    }

    async function declineLetter(accountId) {
        const account = await findById(accountId);
        if (!account?.discord_user_id) return false;
        const { rowCount } = await q(
            `UPDATE ${B} SET letter_declined_at = $2 WHERE discord_user_id = $1 AND letter_claimed IS NULL AND letter_declined_at IS NULL`,
            [account.discord_user_id, at()]);
        return rowCount === 1;
    }

    /** Deletes the account (tokens and recovery codes go with it). The bonus row and any plan stay with the Discord id. */
    async function deleteAccount(id) {
        return tx(async (client) => {
            await client.query(`UPDATE ${B} SET account_id = NULL WHERE account_id = $1`, [id]);
            const { rowCount } = await client.query(`DELETE FROM ${A} WHERE id = $1`, [id]);
            return rowCount === 1;
        });
    }

    /**
     * Daily: accounts older than 7 days that never linked Discord (no Discord id now, and no
     * bonus row ever pointed at them; accounts confirmed by email before v8 are kept), and
     * old email-link tokens from before v8.
     */
    async function prune() {
        const { rowCount: accounts } = await q(
            `DELETE FROM ${A} a WHERE a.discord_user_id IS NULL AND a.email_confirmed_at IS NULL AND a.created_at <= $1
             AND NOT EXISTS (SELECT 1 FROM ${B} b WHERE b.account_id = a.id)`, [at(now() - UNLINKED_KEEP_MS)]);
        const dayAgo = at(now() - 24 * 60 * 60 * 1000);
        const { rowCount: tokens } = await q(`DELETE FROM ${T} WHERE expires_at <= $1 OR used_at <= $1`, [dayAgo]);
        return { accounts: accounts || 0, tokens: tokens || 0 };
    }

    /** "Download my data": the account fields (never the password hash, the 2FA secret or codes; email fields only when set). */
    async function exportOf(accountId) {
        const { rows: [row] } = await q(
            `SELECT username, email, pending_email, email_confirmed_at, age_confirmed_at, terms_accepted_at, discord_user_id, discord_username,
                    discord_linked_at, (totp_enabled_at IS NOT NULL) AS two_step_login_on, totp_enabled_at, password_changed_at, last_login_at, created_at
             FROM ${A} WHERE id = $1`, [accountId]);
        return cleanAccountExport(row);
    }

    return {
        createAccount, findById, findByLogin, findByDiscordId, recordLogin, setPassword, enableTotp, disableTotp, useTotpStep, useRecoveryCode, recoveryCodesLeft, linkDiscord, unlinkDiscord, bonusOf,
        canClaimLetter, freeLetters, claimLetter, declineLetter, deleteAccount, prune, exportOf,
    };
}

export const accountStore = createAccountStore();
