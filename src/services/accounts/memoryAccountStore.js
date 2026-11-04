// memoryAccountStore.js — the account store's interface in memory, for tests (route tests
// without a database). Same rules as accountStore.js; every change runs one at a time
// (a promise queue stands in for the row locks). The real race test is tests/db/accounts.test.js.

import { PremiumError } from '../billing/premiumService.js';
import { AccountError, LETTERS, LETTER_CLAIM_LIMIT, PRO_BONUS_DAYS, bonusFor } from './accountCore.js';
import { UNLINKED_KEEP_MS } from './accountStore.js';
import { cleanAccountExport } from '../privacy/dataExport.js';

/**
 * grantPro(discordUserId) → premium result ({ subscription, … }) or throws PremiumError.
 * The granted subscription is what planOf() returns afterwards; setPlan(id, row|null) sets one for tests.
 */
export function createMemoryAccountStore({
    now = () => Date.now(),
    grantPro = async (userId) => ({ subscription: { user_id: userId, plan_id: 'pro', source: 'bonus', started_at: new Date(now()), expires_at: new Date(now() + PRO_BONUS_DAYS * 24 * 60 * 60 * 1000) } }),
} = {}) {
    const plans = new Map(); // discord id → premium_subscriptions-like row
    const accounts = new Map(); // id → row
    const recovery = new Map(); // id → Map(hash → used_at)
    const bonuses = new Map(); // discord id → row
    let counter = 0;
    let nextId = 1;
    let queue = Promise.resolve();
    const at = (ms = now()) => new Date(ms);
    const copy = (row) => (row ? { ...row } : null);
    function locked(fn) {
        const run = queue.then(fn, fn);
        queue = run.catch(() => {});
        return run;
    }
    const all = () => [...accounts.values()];

    async function createAccount({ username, passwordHash }) {
        return locked(async () => {
            if (all().some((a) => a.username === username)) throw new AccountError('That username is already taken. Choose another one.', 409, 'username_taken');
            const row = {
                id: String(nextId++), username, email: null, password_hash: passwordHash, age_confirmed_at: at(), terms_accepted_at: at(),
                email_confirmed_at: null, pending_email: null, discord_user_id: null, discord_username: null, discord_linked_at: null,
                totp_secret_enc: null, totp_enabled_at: null, totp_last_step: null, password_changed_at: null, last_login_at: null, created_at: at(),
            };
            accounts.set(row.id, row);
            return { account: copy(row) };
        });
    }

    const findById = async (id) => copy(accounts.get(String(id)));
    async function findByLogin(identifier) {
        const text = String(identifier || '').trim().toLowerCase();
        if (!text) return null;
        return copy(all().find((a) => a.username === text));
    }
    const findByDiscordId = async (discordUserId) => copy(all().find((a) => a.discord_user_id && a.discord_user_id === String(discordUserId || '')));

    async function recordLogin(id) {
        const account = accounts.get(String(id));
        if (account) account.last_login_at = at();
    }
    async function setPassword(id, passwordHash) {
        const account = accounts.get(String(id));
        if (!account) throw new Error('password update changed no row');
        Object.assign(account, { password_hash: passwordHash, password_changed_at: at(), pending_email: null });
    }

    async function enableTotp(id, { secretEnc, step, codeHashes }) {
        const account = accounts.get(String(id));
        if (account.totp_enabled_at) throw new AccountError('Two-step login is already on.', 409);
        Object.assign(account, { totp_secret_enc: secretEnc, totp_enabled_at: at(), totp_last_step: step });
        recovery.set(String(id), new Map(codeHashes.map((hash) => [hash, null])));
    }
    async function disableTotp(id) {
        Object.assign(accounts.get(String(id)), { totp_secret_enc: null, totp_enabled_at: null, totp_last_step: null });
        recovery.delete(String(id));
    }
    async function useTotpStep(id, step) {
        const account = accounts.get(String(id));
        if (!account?.totp_enabled_at || (account.totp_last_step !== null && account.totp_last_step >= step)) return false;
        account.totp_last_step = step;
        return true;
    }
    async function useRecoveryCode(id, codeHash) {
        const codes = recovery.get(String(id));
        if (!codes || !codes.has(codeHash) || codes.get(codeHash)) return false;
        codes.set(codeHash, at());
        return true;
    }
    const recoveryCodesLeft = async (id) => [...(recovery.get(String(id))?.values() || [])].filter((v) => !v).length;

    async function linkDiscord({ accountId, discordUserId, discordUsername = null }) {
        return locked(async () => {
            const account = accounts.get(String(accountId));
            if (!account) throw new AccountError('This account no longer exists.', 404, 'missing');
            if (account.discord_user_id && account.discord_user_id !== discordUserId) {
                throw new AccountError('This account is already linked to another Discord account. Unlink it first in Account settings.', 409, 'has_other');
            }
            if (all().some((a) => a.discord_user_id === discordUserId && a.id !== account.id)) {
                throw new AccountError('That Discord account is already linked to another Mewvo account.', 409, 'linked_elsewhere');
            }
            if (account.discord_user_id !== discordUserId) account.discord_linked_at = at();
            Object.assign(account, { discord_user_id: discordUserId, discord_username: discordUsername });
            const existing = bonuses.get(discordUserId);
            if (existing && !existing.account_id) existing.account_id = account.id;
            if (existing) return { account: copy(account), bonus: { kind: 'repeat', linkNumber: existing.link_number, pro: false, proNote: null, letter: false }, premium: null };
            counter += 1;
            const linkNumber = counter;
            const wins = bonusFor(linkNumber);
            let premium = null;
            let proNote = null;
            if (wins.pro) {
                try {
                    premium = await grantPro(discordUserId);
                    if (premium?.subscription) plans.set(String(discordUserId), { ...premium.subscription });
                } catch (error) {
                    if (!(error instanceof PremiumError)) throw error;
                    proNote = error.userMessage;
                }
            }
            bonuses.set(discordUserId, {
                discord_user_id: discordUserId, account_id: account.id, link_number: linkNumber, pro_granted_at: premium ? at() : null, pro_skip_reason: proNote,
                letter_eligible: wins.letter, letter_claimed: null, letter_claimed_at: null, letter_declined_at: null, created_at: at(),
            });
            return { account: copy(account), bonus: { kind: 'new', linkNumber, pro: Boolean(premium), proNote, letter: wins.letter }, premium };
        });
    }

    async function unlinkDiscord(accountId) {
        const account = accounts.get(String(accountId));
        if (!account) return null;
        Object.assign(account, { discord_user_id: null, discord_username: null, discord_linked_at: null });
        return copy(account);
    }
    const bonusOf = async (discordUserId) => copy(bonuses.get(String(discordUserId)));
    async function planOf(discordUserId) {
        const row = plans.get(String(discordUserId));
        return row?.plan_id && row.expires_at && new Date(row.expires_at).getTime() > now() ? copy(row) : null;
    }
    const setPlan = (discordUserId, row) => { if (row) plans.set(String(discordUserId), { user_id: String(discordUserId), ...row }); else plans.delete(String(discordUserId)); };
    function canClaimLetter(bonus, account) {
        return Boolean(bonus && account?.discord_user_id && bonus.discord_user_id === account.discord_user_id
            && bonus.letter_eligible && !bonus.letter_claimed && !bonus.letter_declined_at);
    }
    async function freeLetters() {
        const used = new Set(all().map((a) => a.username));
        return LETTERS.filter((letter) => !used.has(letter));
    }
    async function claimLetter({ accountId, letter }) {
        return locked(async () => {
            const account = accounts.get(String(accountId));
            if (!account?.discord_user_id) throw new AccountError('Link your Discord account first.', 409);
            const bonus = bonuses.get(account.discord_user_id);
            if (!canClaimLetter(bonus, account)) throw new AccountError('This account cannot claim a 1-letter username.', 409, 'not_eligible');
            if ([...bonuses.values()].filter((b) => b.letter_claimed).length >= LETTER_CLAIM_LIMIT) throw new AccountError('All 1-letter usernames have been claimed.', 409, 'all_claimed');
            if (all().some((a) => a.username === letter) || [...bonuses.values()].some((b) => b.letter_claimed === letter)) {
                throw new AccountError('Someone else just took that letter. Choose another one.', 409, 'letter_taken');
            }
            account.username = letter;
            Object.assign(bonus, { letter_claimed: letter, letter_claimed_at: at(), account_id: account.id });
            return copy(account);
        });
    }
    async function declineLetter(accountId) {
        const account = accounts.get(String(accountId));
        const bonus = account?.discord_user_id ? bonuses.get(account.discord_user_id) : null;
        if (!bonus || bonus.letter_claimed || bonus.letter_declined_at) return false;
        bonus.letter_declined_at = at();
        return true;
    }
    async function deleteAccount(id) {
        for (const bonus of bonuses.values()) if (bonus.account_id === String(id)) bonus.account_id = null;
        recovery.delete(String(id));
        return accounts.delete(String(id));
    }
    async function prune() {
        let removed = 0;
        for (const [id, a] of accounts) {
            const everLinked = [...bonuses.values()].some((b) => b.account_id === id);
            const cutoff = now() - UNLINKED_KEEP_MS;
            const idle = !a.email_confirmed_at || new Date(a.last_login_at || a.created_at).getTime() <= cutoff;
            if (!a.discord_user_id && idle && !everLinked && new Date(a.created_at).getTime() <= cutoff) { await deleteAccount(id); removed += 1; }
        }
        return { accounts: removed, tokens: 0 };
    }
    async function exportOf(accountId) {
        const a = accounts.get(String(accountId));
        if (!a) return null;
        return cleanAccountExport({
            username: a.username, email: a.email, pending_email: a.pending_email, email_confirmed_at: a.email_confirmed_at, age_confirmed_at: a.age_confirmed_at,
            terms_accepted_at: a.terms_accepted_at, discord_user_id: a.discord_user_id, discord_username: a.discord_username, discord_linked_at: a.discord_linked_at,
            two_step_login_on: Boolean(a.totp_enabled_at), totp_enabled_at: a.totp_enabled_at, password_changed_at: a.password_changed_at, last_login_at: a.last_login_at, created_at: a.created_at,
        });
    }

    return {
        createAccount, findById, findByLogin, findByDiscordId, recordLogin, setPassword, enableTotp, disableTotp, useTotpStep, useRecoveryCode, recoveryCodesLeft, linkDiscord, unlinkDiscord, bonusOf, planOf, setPlan,
        canClaimLetter, freeLetters, claimLetter, declineLetter, deleteAccount, prune, exportOf,
        // Test helpers.
        _accounts: accounts, _bonuses: bonuses, setCounter: (n) => { counter = n; },
    };
}
