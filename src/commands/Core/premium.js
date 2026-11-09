// /premium — a member's own Mewvo plan (TEST CHECKOUT; services/billing/premiumService.js).
//   /premium status       your plan, its end date, the limits it gives a server you own
//   /premium redeem key:  redeem a key (same rules as the website); then role + DM follow
//   /premium gift user: plan: [period] [message]  a test-mode gift key, DMed to them (3 an hour)
// Everyone may use it (EVERYONE_COMMANDS); every reply is ephemeral. Redeem is limited to
// 5 tries a minute per user. Off (a short notice) unless PREMIUM_TEST_CHECKOUT=true.

import { SlashCommandBuilder, MessageFlags, escapeMarkdown } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { PLANS } from '../../config/site/plans.js';
import { PremiumError, planName, premiumSettings, premiumStore } from '../../services/billing/premiumService.js';
import { afterPremiumChange } from '../../services/billing/premiumEffects.js';
import { premiumErrorText } from '../../services/site/billing.js';
import { BoundedMap } from '../../utils/boundedMap.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { sendLoggedDm } from '../../services/botDm/dmLog.js';
import { localized, replyText } from '../../utils/commandLocalizations.js';

const REDEEM_LIMIT = 5;
const REDEEM_WINDOW_MS = 60_000;
// Bounded (utils/boundedMap.js): a public bot sees many users; losing the oldest entry only
// restarts that user's window.
const tries = new BoundedMap(10_000); // user id → [timestamps]

/** True while a user may try another redeem (5 a minute). Exported for tests. */
export function allowRedeem(userId, now = Date.now(), store = tries) {
    const recent = (store.get(userId) || []).filter((t) => now - t < REDEEM_WINDOW_MS);
    if (recent.length >= REDEEM_LIMIT) {
        store.set(userId, recent);
        return false;
    }
    recent.push(now);
    store.set(userId, recent);
    return true;
}

const GIFT_LIMIT = 3;
const GIFT_WINDOW_MS = 60 * 60_000;
const gifts = new BoundedMap(10_000); // user id → [timestamps]

/** For tests: the two rate-limit stores. */
export const _rateLimitStores = { tries, gifts };

/** True while a user may send another gift (3 an hour: each one DMs someone). Exported for tests. */
export function allowGift(userId, now = Date.now(), store = gifts) {
    const recent = (store.get(userId) || []).filter((t) => now - t < GIFT_WINDOW_MS);
    if (recent.length >= GIFT_LIMIT) {
        store.set(userId, recent);
        return false;
    }
    recent.push(now);
    store.set(userId, recent);
    return true;
}

/**
 * Text a member typed, made safe for a DM that comes from the bot: no markdown (so no masked
 * "[click here](…)" links or fake headings), no links at all, no mentions. Pure.
 */
export function plainUserText(text, { lang = 'en' } = {}) {
    const removed = botText(lang).t('core.premium.linkRemoved');
    return escapeMarkdown(String(text ?? ''))
        .replace(/(?:https?:\/\/|www\.)\S+/gi, removed)
        .replace(/discord\.gg\/\S+/gi, removed)
        .replace(/@(everyone|here)/gi, '@\u200b$1')
        .replace(/[[\]]/g, (c) => `\\${c}`);
}

/** The buyer's gift message as the DM shows it: made safe (plainUserText), on one line. */
export function giftNoteText(message, { lang = 'en' } = {}) {
    return message ? plainUserText(message, { lang }).replace(/\n+/g, ' ') : '';
}

/**
 * The DM the gifted person gets (in `lang`, default English). The sender is a mention (can't be faked). Pure, for tests.
 * `safeNote`: the message already made safe (giftNoteText), used as it is: a re-rendering in
 * another language (botDm/dmRenderers.js 'premium.gift') keeps the note exactly as first shown.
 */
export function giftDm({ fromId, fromName, planId, days, code, message, safeNote, redeemUrl, lang = 'en' }) {
    const tr = botText(lang);
    const from = fromId ? `<@${fromId}>` : plainUserText(fromName, { lang });
    const note = safeNote ?? giftNoteText(message, { lang });
    return [
        tr.tp('core.premium.giftDm.gave', days, { from, plan: planName(planId) }),
        note ? tr.t('core.premium.giftDm.note', { note }) : null,
        tr.t('core.premium.giftDm.key', { code }),
        redeemUrl ? tr.t('core.premium.giftDm.redeemOrUrl', { url: redeemUrl }) : tr.t('core.premium.giftDm.redeem'),
    ].filter(Boolean).join('\n');
}

const ts = (date, style) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

/** The status embed text (in `lang`, default English). Pure, for tests. */
export function statusText(subscription, publicUrl = '', { lang = 'en' } = {}) {
    const tr = botText(lang);
    const site = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/pricing` : null;
    if (!subscription) {
        return `${tr.t('core.premium.free')}${site ? ` ${tr.t('core.premium.plans', { url: site })}` : ''}\n${tr.t('core.premium.haveKey')}`;
    }
    const plan = PLANS.find((p) => p.id === subscription.plan_id);
    const limits = plan?.limits ? `\n${tr.t('core.premium.limits', { tags: plan.limits.tags, stickies: plan.limits.stickies, feeds: plan.limits.feeds, scheduled: plan.limits.scheduled })}` : '';
    return `${tr.t('core.premium.active', { plan: planName(subscription.plan_id), until: ts(subscription.expires_at, 'F'), relative: ts(subscription.expires_at, 'R') })}${limits}`;
}

/** /premium gift: a test-mode gift key, DMed to the person; the buyer sees it too (DMs can be closed). */
async function gift(interaction, client, { store, env, reply, tr }) {
    const buyer = interaction.user;
    const target = interaction.options.getUser('user', true);
    if (target.bot) return reply(tr.t('core.premium.giftBot'), 'warning');
    if (target.id === buyer.id) return reply(tr.t('core.premium.giftSelf'), 'warning');
    if (!allowGift(buyer.id)) return reply(tr.t('core.premium.giftLimit'), 'warning');
    const planId = interaction.options.getString('plan', true);
    const period = interaction.options.getString('period') || 'monthly';
    const message = interaction.options.getString('message') || '';
    const result = await store.purchase({
        userId: buyer.id, username: buyer.globalName || buyer.username, planId, period, kind: 'gift',
        giftTo: (target.globalName || target.username || '').slice(0, 50), giftMessage: message,
    });
    const origin = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
    const redeemUrl = origin && /^https?:\/\//.test(origin) ? `${origin}/me/redeem?code=${encodeURIComponent(result.key.code)}` : null;
    let delivered = false;
    // A DM to the gifted member: their language role, else the server's language (English when
    // run outside a server). Logged for a language change (botDm/dmLog.js; only in a server).
    const guildId = interaction.guildId ?? null;
    const targetMember = guildId ? interaction.options.getMember?.('user') ?? null : null;
    const dmLang = textForGuild(guildId, { member: targetMember, userId: target.id, purpose: 'dm' }).lang;
    try {
        delivered = await sendLoggedDm(target, {
            key: 'premium.gift',
            params: {
                fromId: buyer.id, fromName: buyer.globalName || buyer.username, planId, days: result.key.duration_days,
                code: result.key.code, safeNote: giftNoteText(message, { lang: dmLang }), redeemUrl,
            },
            guildId,
            member: targetMember,
            label: 'premium gift',
        });
    } catch {
        delivered = false;
    }
    logger.info(`Premium gift …${result.key.code.slice(-4)} from ${buyer.id} to ${target.id} (slash command, test), DM ${delivered ? 'delivered' : 'not delivered'}`);
    const params = { name: target.username, plan: planName(planId), code: result.key.code };
    return reply(delivered
        ? tr.tp('core.premium.giftSent', result.key.duration_days, params)
        : tr.tp('core.premium.giftClosed', result.key.duration_days, params),
    'success', tr.t('core.premium.giftReadyTitle'));
}

export default {
    data: new SlashCommandBuilder()
        .setName('premium')
        .setDescription('Your Mewvo plan')
        .setDescriptionLocalizations(localized('core.slash.premium.description'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Show your plan and when it ends')
            .setDescriptionLocalizations(localized('core.slash.premium.sub.status.description')))
        .addSubcommand((sub) => sub.setName('redeem').setDescription('Redeem a Mewvo key')
            .setDescriptionLocalizations(localized('core.slash.premium.sub.redeem.description'))
            .addStringOption((option) => option.setName('key').setDescription('MEWVO-XXXX-XXXX-XXXX')
                .setDescriptionLocalizations(localized('core.slash.premium.sub.redeem.options.key')).setRequired(true).setMaxLength(40)))
        .addSubcommand((sub) => sub.setName('gift').setDescription('Give someone a plan (test mode, nothing is charged)')
            .setDescriptionLocalizations(localized('core.slash.premium.sub.gift.description'))
            .addUserOption((option) => option.setName('user').setDescription('Who gets it')
                .setDescriptionLocalizations(localized('core.slash.premium.sub.gift.options.user')).setRequired(true))
            .addStringOption((option) => option.setName('plan').setDescription('Which plan')
                .setDescriptionLocalizations(localized('core.slash.premium.sub.gift.options.plan')).setRequired(true)
                .addChoices({ name: 'Normal', value: 'normal' }, { name: 'Pro', value: 'pro' }, { name: 'Max', value: 'max' }))
            .addStringOption((option) => option.setName('period').setDescription('How long (default: a month)')
                .setDescriptionLocalizations(localized('core.slash.premium.sub.gift.options.period'))
                .addChoices({ name: 'A month', value: 'monthly' }, { name: 'A year', value: 'yearly' }))
            .addStringOption((option) => option.setName('message').setDescription('A short note with the gift')
                .setDescriptionLocalizations(localized('core.slash.premium.sub.gift.options.message')).setMaxLength(300))),

    // (interaction, guildConfig, client) from the dispatcher; the 4th argument is for tests.
    async execute(interaction, guildConfig, client, { store = premiumStore, env = process.env, after = afterPremiumChange } = {}) {
        // Every reply is ephemeral: the user's Discord language.
        const tr = replyText(interaction);
        const reply = (description, color = 'primary', title = tr.t('core.premium.title')) => InteractionHelper.safeReply(interaction, {
            embeds: [createEmbed({ title, description, color })], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        });
        if (!premiumSettings(env).testCheckout) return reply(tr.t('core.premium.off'), 'info');
        const sub = interaction.options.getSubcommand();
        const user = interaction.user;
        try {
            if (sub === 'status') {
                const account = await store.accountOf(user.id);
                return reply(statusText(account.subscription, env.PUBLIC_URL || '', { lang: tr.lang }));
            }
            if (sub === 'gift') return await gift(interaction, client, { store, env, reply, tr });
            if (!allowRedeem(user.id)) return reply(tr.t('core.premium.tooManyTries'), 'warning');
            const result = await store.redeem({ code: interaction.options.getString('key', true), userId: user.id, username: user.globalName || user.username });
            await after(result, 'key');
            const up = result.next?.converted ? ` ${tr.t('core.premium.converted', { plan: planName(result.next.converted.fromPlanId) })}` : '';
            logger.info(`Premium key …${result.key.code.slice(-4)} redeemed by ${user.id} (slash command)`);
            return reply(tr.tp('core.premium.redeemed', result.key.duration_days, { plan: planName(result.key.plan_id), converted: up, until: ts(result.subscription.expires_at, 'F') }),
                'success', tr.t('core.premium.redeemedTitle'));
        } catch (error) {
            // English: the service's own text (as before); other languages: the website's text for its code.
            if (error instanceof PremiumError) return reply(tr.lang === 'en' ? error.userMessage : premiumErrorText(error, { lang: tr.lang }), 'error', sub === 'gift' ? tr.t('core.premium.notSentTitle') : tr.t('core.premium.notRedeemedTitle'));
            logger.error(`/premium ${sub} failed for ${user.id}: ${error.message}`);
            return reply(tr.t('core.premium.databaseDown'), 'error', tr.t('core.premium.databaseDownTitle'));
        }
    },
};
