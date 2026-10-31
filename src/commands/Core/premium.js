// /premium — a member's own Mewvo plan (TEST CHECKOUT; services/billing/premiumService.js).
//   /premium status       your plan, its end date, the limits it gives a server you own
//   /premium redeem key:  redeem a key (same rules as the website); then role + DM follow
// Everyone may use it (EVERYONE_COMMANDS); every reply is ephemeral. Redeem is limited to
// 5 tries a minute per user. Off (a short notice) unless PREMIUM_TEST_CHECKOUT=true.

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
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

const ts = (date, style) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

/** The status embed fields. Pure, for tests. */
export function statusText(subscription, publicUrl = '') {
    const site = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/pricing` : null;
    if (!subscription) {
        return `You are on **Free**.${site ? ` Plans: ${site}` : ''}\nHave a key? Use \`/premium redeem\`.`;
    }
    const plan = PLANS.find((p) => p.id === subscription.plan_id);
    const limits = plan?.limits ? `\nIn servers you own: ${plan.limits.tags} tags, ${plan.limits.stickies} sticky messages, ${plan.limits.feeds} YouTube feeds, ${plan.limits.scheduled} scheduled messages.` : '';
    return `**Mewvo ${planName(subscription.plan_id)}** until ${ts(subscription.expires_at, 'F')} (${ts(subscription.expires_at, 'R')}).${limits}`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('premium')
        .setDescription('Your Mewvo plan')
        .addSubcommand((sub) => sub.setName('status').setDescription('Show your plan and when it ends'))
        .addSubcommand((sub) => sub.setName('redeem').setDescription('Redeem a Mewvo key')
            .addStringOption((option) => option.setName('key').setDescription('MEWVO-XXXX-XXXX-XXXX').setRequired(true).setMaxLength(40))),

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
            if (!allowRedeem(user.id)) return reply('Too many tries. Wait a minute and try again.', 'warning');
            const result = await store.redeem({ code: interaction.options.getString('key', true), userId: user.id, username: user.globalName || user.username });
            await after(result, 'key');
            const up = result.next?.converted ? ` Your remaining ${planName(result.next.converted.fromPlanId)} time was converted.` : '';
            logger.info(`Premium key …${result.key.code.slice(-4)} redeemed by ${user.id} (slash command)`);
            return reply(`Key redeemed: **Mewvo ${planName(result.key.plan_id)}**, ${result.key.duration_days} days added.${up}\nActive until ${ts(result.subscription.expires_at, 'F')}.`, 'success', 'Key redeemed');
        } catch (error) {
            if (error instanceof PremiumError) return reply(error.userMessage, 'error', 'Not redeemed');
            logger.error(`/premium ${sub} failed for ${user.id}: ${error.message}`);
            return reply('The database is not responding. Nothing was changed; try again in a few minutes.', 'error', 'Try again later');
        }
    },
};
