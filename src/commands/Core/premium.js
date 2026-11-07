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

const REDEEM_LIMIT = 5;
const REDEEM_WINDOW_MS = 60_000;
const tries = new Map(); // user id → [timestamps]

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
const gifts = new Map(); // user id → [timestamps]

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
export function plainUserText(text) {
    return escapeMarkdown(String(text ?? ''))
        .replace(/(?:https?:\/\/|www\.)\S+/gi, '(link removed)')
        .replace(/discord\.gg\/\S+/gi, '(link removed)')
        .replace(/@(everyone|here)/gi, '@\u200b$1')
        .replace(/[[\]]/g, (c) => `\\${c}`);
}

/** The DM the gifted person gets. The sender is a mention (can't be faked). Pure, for tests. */
export function giftDm({ fromId, fromName, planId, days, code, message, redeemUrl }) {
    return [
        `${fromId ? `<@${fromId}>` : plainUserText(fromName)} gave you **Mewvo ${planName(planId)}** for ${days} days.`,
        message ? `Their note: ${plainUserText(message).replace(/\n+/g, ' ')}` : null,
        `Your key: \`${code}\``,
        `Redeem it with \`/premium redeem\`${redeemUrl ? ` or at ${redeemUrl}` : ''}. It can be used once, within a year.`,
    ].filter(Boolean).join('\n');
}

const ts = (date, style) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

/** The status embed fields. Pure, for tests. */
export function statusText(subscription, publicUrl = '') {
    const site = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/pricing` : null;
    if (!subscription) {
        return `You are on **Free**.${site ? ` Plans: ${site}` : ''}\nHave a key? Use \`/premium redeem\`.`;
    }
    const plan = PLANS.find((p) => p.id === subscription.plan_id);
    const limits = plan?.limits ? `\nIn servers you own: ${plan.limits.tags} tags, ${plan.limits.stickies} sticky messages, ${plan.limits.feeds} YouTube or Twitch feeds, ${plan.limits.scheduled} scheduled messages.` : '';
    return `**Mewvo ${planName(subscription.plan_id)}** until ${ts(subscription.expires_at, 'F')} (${ts(subscription.expires_at, 'R')}).${limits}`;
}

/** /premium gift: a test-mode gift key, DMed to the person; the buyer sees it too (DMs can be closed). */
async function gift(interaction, client, { store, env, reply }) {
    const buyer = interaction.user;
    const target = interaction.options.getUser('user', true);
    if (target.bot) return reply('Bots can\'t have a plan.', 'warning');
    if (target.id === buyer.id) return reply('That\'s you. To get a plan yourself, use the website, or ask someone else to gift it.', 'warning');
    if (!allowGift(buyer.id)) return reply('You can send 3 gifts an hour. Try again later.', 'warning');
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
    try {
        await target.send({
            content: giftDm({ fromId: buyer.id, fromName: buyer.globalName || buyer.username, planId, days: result.key.duration_days, code: result.key.code, message, redeemUrl }),
            allowedMentions: { parse: [] },
        });
        delivered = true;
    } catch {
        delivered = false;
    }
    logger.info(`Premium gift …${result.key.code.slice(-4)} from ${buyer.id} to ${target.id} (slash command, test), DM ${delivered ? 'delivered' : 'not delivered'}`);
    return reply(delivered
        ? `Sent. ${target.username} got a DM with the key for **Mewvo ${planName(planId)}** (${result.key.duration_days} days). Test mode: nothing was charged.\nThe key, in case they lose it: \`${result.key.code}\``
        : `Their DMs are closed, so give them this key yourself: \`${result.key.code}\`\nIt's **Mewvo ${planName(planId)}** for ${result.key.duration_days} days, redeemable once with \`/premium redeem\`. Test mode: nothing was charged.`,
    'success', 'Gift ready');
}

export default {
    data: new SlashCommandBuilder()
        .setName('premium')
        .setDescription('Your Mewvo plan')
        .addSubcommand((sub) => sub.setName('status').setDescription('Show your plan and when it ends'))
        .addSubcommand((sub) => sub.setName('redeem').setDescription('Redeem a Mewvo key')
            .addStringOption((option) => option.setName('key').setDescription('MEWVO-XXXX-XXXX-XXXX').setRequired(true).setMaxLength(40)))
        .addSubcommand((sub) => sub.setName('gift').setDescription('Give someone a plan (test mode, nothing is charged)')
            .addUserOption((option) => option.setName('user').setDescription('Who gets it').setRequired(true))
            .addStringOption((option) => option.setName('plan').setDescription('Which plan').setRequired(true)
                .addChoices({ name: 'Normal', value: 'normal' }, { name: 'Pro', value: 'pro' }, { name: 'Max', value: 'max' }))
            .addStringOption((option) => option.setName('period').setDescription('How long (default: a month)')
                .addChoices({ name: 'A month', value: 'monthly' }, { name: 'A year', value: 'yearly' }))
            .addStringOption((option) => option.setName('message').setDescription('A short note with the gift').setMaxLength(300))),

    // (interaction, guildConfig, client) from the dispatcher; the 4th argument is for tests.
    async execute(interaction, guildConfig, client, { store = premiumStore, env = process.env, after = afterPremiumChange } = {}) {
        const reply = (description, color = 'primary', title = 'Mewvo plan') => InteractionHelper.safeReply(interaction, {
            embeds: [createEmbed({ title, description, color })], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        });
        if (!premiumSettings(env).testCheckout) return reply('Plans are not available yet.', 'info');
        const sub = interaction.options.getSubcommand();
        const user = interaction.user;
        try {
            if (sub === 'status') {
                const account = await store.accountOf(user.id);
                return reply(statusText(account.subscription, env.PUBLIC_URL || ''));
            }
            if (sub === 'gift') return await gift(interaction, client, { store, env, reply });
            if (!allowRedeem(user.id)) return reply('Too many tries. Wait a minute and try again.', 'warning');
            const result = await store.redeem({ code: interaction.options.getString('key', true), userId: user.id, username: user.globalName || user.username });
            await after(result, 'key');
            const up = result.next?.converted ? ` Your remaining ${planName(result.next.converted.fromPlanId)} time was converted.` : '';
            logger.info(`Premium key …${result.key.code.slice(-4)} redeemed by ${user.id} (slash command)`);
            return reply(`Key redeemed: **Mewvo ${planName(result.key.plan_id)}**, ${result.key.duration_days} days added.${up}\nActive until ${ts(result.subscription.expires_at, 'F')}.`, 'success', 'Key redeemed');
        } catch (error) {
            if (error instanceof PremiumError) return reply(error.userMessage, 'error', sub === 'gift' ? 'Not sent' : 'Not redeemed');
            logger.error(`/premium ${sub} failed for ${user.id}: ${error.message}`);
            return reply('The database is not responding. Nothing was changed; try again in a few minutes.', 'error', 'Try again later');
        }
    },
};
