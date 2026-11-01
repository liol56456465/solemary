// /profile [user]: one card with a member's level and XP, rank in the server, the next level
// role reward and how much XP is left, birthday,
// Mewvo plan and when they joined. Everyone may see their own; another member's profile is
// for administrators (like /rank). Parts that can't be read are left out, never guessed.

import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { isBotOwner } from '../../config/bot.js';
import { hasAdministrator } from '../../utils/commandGate.js';
import { getLevelingConfig, getUserLevelData, getXpForLevel } from '../../services/leveling/leveling.js';
import { getGuildBirthdays, getMonthName } from '../../utils/database.js';
import { planOf } from '../../services/billing/premiumEffects.js';
import { planName } from '../../services/billing/premiumService.js';
import { pgConfig } from '../../config/database/postgres.js';
import { query } from '../../services/enforcement/db.js';

const ts = (date, style) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

/** "▰▰▰▱▱▱▱▱▱▱ 30%" */
export function progressLine(xp, needed, length = 10) {
    const pct = needed > 0 ? Math.max(0, Math.min(100, Math.floor((xp / needed) * 100))) : 0;
    const filled = Math.round((pct / 100) * length);
    return `${'▰'.repeat(filled)}${'▱'.repeat(length - filled)} ${pct}%`;
}

/** The next role reward above `level` and the XP still needed for it, or null. Pure. */
export function nextReward(level, roleRewards = {}) {
    if (!level) return null;
    const next = Object.keys(roleRewards || {}).map(Number).filter((l) => Number.isInteger(l) && l > level.level && roleRewards[l]).sort((a, b) => a - b)[0];
    if (!next) return null;
    let xp = Math.max(0, getXpForLevel(level.level) - level.xp);
    for (let l = level.level + 1; l < next; l += 1) xp += getXpForLevel(l);
    return { level: next, roleId: roleRewards[next], xp };
}

/** The profile embed fields from plain data. Pure, for tests. */
export function profileFields({ level, rank, birthday, planId, joinedAt, createdAt, reward = null }) {
    const fields = [];
    if (level) {
        const needed = getXpForLevel(level.level);
        fields.push({ name: 'Level', value: `**${level.level}** · ${level.xp}/${needed} XP\n${progressLine(level.xp, needed)}`, inline: false });
        fields.push({ name: 'Total XP', value: String(level.totalXp), inline: true });
        if (rank) fields.push({ name: 'Rank', value: `#${rank}`, inline: true });
        if (reward) fields.push({ name: 'Next reward', value: `<@&${reward.roleId}> at level ${reward.level}, ${reward.xp} XP to go`, inline: false });
    }
    if (birthday) fields.push({ name: 'Birthday', value: `${birthday.day} ${getMonthName(birthday.month)}`, inline: true });
    if (planId && planId !== 'free') fields.push({ name: 'Mewvo plan', value: planName(planId), inline: true });
    if (joinedAt) fields.push({ name: 'Joined', value: `${ts(joinedAt, 'D')} (${ts(joinedAt, 'R')})`, inline: true });
    if (createdAt) fields.push({ name: 'Account created', value: ts(createdAt, 'D'), inline: true });
    return fields;
}

/** 1-based position by total XP, or null. */
async function rankOf(guildId, userId) {
    const t = pgConfig.tables.user_levels;
    const { rows: [row] } = await query(
        `SELECT 1 + (SELECT COUNT(*) FROM ${t} o WHERE o.guild_id = $1 AND o.total_xp > m.total_xp)::int AS rank
         FROM ${t} m WHERE m.guild_id = $1 AND m.user_id = $2`,
        [guildId, userId],
    );
    return row ? Number(row.rank) : null;
}

export default {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Your level, rank, birthday and plan in one card')
        .addUserOption((o) => o.setName('user').setDescription('Someone else (administrators only)')),
    category: 'Leveling',

    async execute(interaction, config, client) {
        const target = interaction.options.getUser('user') || interaction.user;
        if (target.id !== interaction.user.id
            && !isBotOwner(interaction.user.id)
            && !hasAdministrator({ guild: interaction.guild, userId: interaction.user.id, permissions: interaction.memberPermissions })) {
            throw new TitanBotError(`Non-admin ${interaction.user.id} tried to view the profile of ${target.id}`, ErrorTypes.PERMISSION,
                'Only admins can see someone else\'s profile. Use `/profile` without a user to see yours.');
        }
        await InteractionHelper.safeDefer(interaction);
        const guildId = interaction.guildId;
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!member) throw new TitanBotError(`User ${target.id} not in guild`, ErrorTypes.USER_INPUT, 'That person is not in this server.');

        // Each part on its own: one that can't be read is left out, the rest still shows.
        const part = async (name, fn) => {
            try { return await fn(); } catch (error) { logger.warn(`/profile: ${name} not available: ${error.message}`); return null; }
        };
        const leveling = await part('leveling config', () => getLevelingConfig(client, guildId));
        const level = leveling?.enabled ? await part('level', async () => {
            const d = await getUserLevelData(client, guildId, target.id);
            return { level: d?.level ?? 0, xp: d?.xp ?? 0, totalXp: d?.totalXp ?? 0 };
        }) : null;
        const rank = level ? await part('rank', () => rankOf(guildId, target.id)) : null;
        const reward = level ? nextReward(level, leveling?.roleRewards) : null;
        const birthday = await part('birthday', async () => (await getGuildBirthdays(client, guildId))?.[target.id] || null);

        const embed = createEmbed({
            title: member.displayName,
            description: target.id === interaction.user.id ? null : `<@${target.id}>`,
            fields: profileFields({ level, rank, reward, birthday, planId: planOf(target.id), joinedAt: member.joinedAt, createdAt: target.createdAt }),
            color: 'primary',
        });
        embed.setThumbnail(member.displayAvatarURL({ size: 128 }));
        return InteractionHelper.safeEditReply(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
    },
};
