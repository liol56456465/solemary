// reviewCards.js — the staff review card posted for every automod decision and
// member report, and what its buttons do. Administrators in the main server only.
//
//   amreview:keep:<code>                 keep the automatic action
//   amreview:undo:<code>                 reverse it (unban/unmute/remove warn, DM the user)
//   amreview:change:<code>               (select) reverse it and apply another punishment
//   amreview:apply:<rule>:<userId>       (select) apply a punishment (monitor mode, reports, failed actions)
//   amreview:delete:<channelId>:<msgId>  delete a reported message
//   amreview:dismiss                     close the card without acting

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { AUTOMOD_RULES, REVIEW_ACTIONS, automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { formatDuration, truncate } from '../enforcement/format.js';
import { getCaseByCode } from '../enforcement/caseService.js';
import { createRejoinInvite, executeAction, sendDm } from '../enforcement/enforcementService.js';
import { liftCase } from '../enforcement/appealService.js';

const REPORT_RULE = 'report';

function userError(message) {
    return createError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

/** "Warn", "Mute 1 hour", "Ban 7 days", "Permanent ban". */
export function describeStep(step) {
    if (step.type === 'warn') return 'Warn';
    if (step.type === 'kick') return 'Kick';
    if (step.type === 'mute') return `Mute ${formatDuration(step.durationMs)}`;
    return step.durationMs ? `Ban ${formatDuration(step.durationMs)}` : 'Permanent ban';
}

/** The staff channel for review cards: AUTOMOD_REVIEW_CHANNEL_ID, else the mod log channel. */
export async function reviewChannel(client) {
    const channelId = automodConfig.reviewChannelId || enforcementConfig.modLogChannelId;
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!channelId || !guild) return null;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    return channel?.isTextBased?.() ? channel : null;
}

function actionSelect(customId, placeholder, suggestedKey = null) {
    return new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(Object.entries(REVIEW_ACTIONS).map(([key, action]) => ({
            label: action.label,
            value: key,
            default: false,
            description: key === suggestedKey ? 'Suggested by the rule ladder' : undefined,
        })));
}

function actionKeyFor(step) {
    return Object.entries(REVIEW_ACTIONS).find(([, action]) =>
        action.step.type === step?.type && (action.step.durationMs ?? null) === (step?.durationMs ?? null))?.[0] || null;
}

/**
 * Posts a card. p: { guild, rule, evidence, targetUser, channelId, messageUrl, content,
 * step?, result?, offence?, monitor?, suggested?, raid?, report?: { reporter, messageId, removed } }
 */
export async function postReviewCard(p) {
    const channel = await reviewChannel(p.guild.client);
    if (!channel) {
        logger.warn(`Automod review card not posted (no review channel): ${p.rule} on ${p.targetUser.id}`);
        return null;
    }

    const rule = AUTOMOD_RULES[p.rule];
    const record = p.result?.record || p.result?.banRecord || null;
    const failed = p.result?.error;
    const fields = [
        { name: 'User', value: `<@${p.targetUser.id}> ${p.targetUser.username} (\`${p.targetUser.id}\`)`, inline: true },
        { name: 'Channel', value: p.channelId ? `<#${p.channelId}>` : '—', inline: true },
    ];
    if (p.offence) fields.push({ name: 'Offence in 30 days', value: `#${p.offence}`, inline: true });
    fields.push({ name: 'Why', value: truncate(p.evidence || '—', 1024) });
    fields.push({ name: 'Message', value: truncate(p.content || '(no text)', 1000) });
    if (p.messageUrl && (p.monitor || p.report || !rule?.deleteMessage)) {
        fields.push({ name: 'Jump', value: p.messageUrl });
    }

    let title;
    let color = 'warning';
    const components = [];
    if (p.report) {
        title = 'Member report';
        fields.push({ name: 'Reported by', value: p.report.reporter, inline: true });
        if (p.report.removed) fields.push({ name: 'Message', value: 'Removed by member reports', inline: true });
        components.push(new ActionRowBuilder().addComponents(actionSelect(`amreview:apply:${REPORT_RULE}:${p.targetUser.id}`, 'Punish the author…')));
        const buttons = [new ButtonBuilder().setCustomId('amreview:dismiss').setLabel('Dismiss').setStyle(ButtonStyle.Secondary)];
        if (!p.report.removed && p.report.messageId) {
            buttons.unshift(new ButtonBuilder().setCustomId(`amreview:delete:${p.channelId}:${p.report.messageId}`).setLabel('Delete message').setStyle(ButtonStyle.Danger));
        }
        components.push(new ActionRowBuilder().addComponents(buttons));
    } else if (p.monitor) {
        title = `Automod (monitor mode): ${rule.label}`;
        color = 'secondary';
        fields.push({ name: 'Would do', value: `${describeStep(p.suggested)} (nothing was done; monitor mode)` });
        components.push(new ActionRowBuilder().addComponents(actionSelect(`amreview:apply:${p.rule}:${p.targetUser.id}`, 'Apply a punishment…', actionKeyFor(p.suggested))));
        components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('amreview:dismiss').setLabel('Dismiss').setStyle(ButtonStyle.Secondary)));
    } else {
        title = `Automod: ${rule.label}${p.raid ? ' (raid joiner)' : ''}`;
        color = failed ? 'error' : 'warning';
        const done = failed
            ? `Not applied: ${failed.userMessage || failed.message}`
            : `${describeStep(p.step)}${record ? ` — case \`${record.case_code}\`` : ''}`;
        fields.push({ name: 'Action', value: truncate(done, 1024) });
        if (p.result?.banRecord) fields.push({ name: 'Warning limit', value: `This warn reached the limit: automatic ban \`${p.result.banRecord.case_code}\`` });
        if (record) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`amreview:keep:${record.case_code}`).setLabel('Keep').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`amreview:undo:${record.case_code}`).setLabel('Undo').setStyle(ButtonStyle.Danger),
            ));
            components.push(new ActionRowBuilder().addComponents(actionSelect(`amreview:change:${record.case_code}`, 'Change to…')));
        } else {
            components.push(new ActionRowBuilder().addComponents(actionSelect(`amreview:apply:${p.rule}:${p.targetUser.id}`, 'Apply a punishment…', actionKeyFor(p.step))));
            components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('amreview:dismiss').setLabel('Dismiss').setStyle(ButtonStyle.Secondary)));
        }
    }

    return channel.send({
        embeds: [createEmbed({ title: truncate(title, 256), fields, color, timestamp: true })],
        components,
        allowedMentions: { parse: [] },
    }).catch((error) => {
        logger.warn(`Automod review card failed: ${error.message}`);
        return null;
    });
}

/** Closes a card: keeps its embed, adds who reviewed it, removes the controls. */
export async function closeCard(message, outcome) {
    const [embed] = message.embeds;
    const data = embed?.toJSON?.() || {};
    const fields = [...(data.fields || []), { name: 'Review', value: truncate(outcome, 1024) }];
    await message.edit({ embeds: [{ ...data, fields }], components: [] }).catch((error) =>
        logger.warn(`Could not update review card ${message.id}: ${error.message}`));
}

function flowFor(step, { reason, reasonKey, targetUser }) {
    return {
        type: step.type,
        reason,
        reasonSource: 'custom',
        reasonKey,
        durationMs: step.durationMs ?? null,
        unappealable: false,
        name: `${targetUser.username} ${step.type}`,
        nameIsDefault: true,
    };
}

async function reverse(client, record, admin, verb) {
    if (record.status === 'revoked') return { notes: ['It was already lifted.'] };
    if (record.type === 'kick') {
        const guild = client.guilds.cache.get(record.guild_id);
        const invite = guild ? await createRejoinInvite(guild, `Automod kick ${record.case_code} ${verb}`) : null;
        return { notes: ['A kick cannot be undone; the user was sent an invite back.'], invite };
    }
    const notes = await liftCase(client, record, admin, {
        reason: `Automod decision ${verb} by ${admin.username}`,
        via: 'automod review',
    });
    const guild = client.guilds.cache.get(record.guild_id);
    const invite = record.type === 'ban' && guild ? await createRejoinInvite(guild, `Automod ban ${record.case_code} ${verb}`) : null;
    return { notes, invite };
}

async function dmReversal(client, record, invite, replacement = null) {
    const user = await client.users.fetch(record.target_user_id).catch(() => null);
    if (!user) return false;
    const lines = [
        `**A moderator reviewed an automatic action against you in ${enforcementConfig.serverName}** (case ${record.case_code}).`,
        replacement ? `It was changed to: ${replacement}.` : 'It was reversed.',
        invite ? `Rejoin: ${invite}` : null,
    ].filter(Boolean);
    return sendDm(user, lines.join('\n'));
}

/**
 * Handles a review card component. Returns the confirmation text for the moderator.
 * `interaction.member` must be an administrator in the main server (checked by the caller).
 */
export async function handleReviewAction(interaction, args) {
    const [action, ...rest] = args;
    const { client, guild } = interaction;
    const admin = interaction.user;
    const message = interaction.message;

    if (action === 'dismiss') {
        await closeCard(message, `Dismissed by ${admin.username}`);
        return 'Dismissed.';
    }

    if (action === 'delete') {
        const [channelId, messageId] = rest;
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        const target = channel?.isTextBased?.() ? await channel.messages.fetch(messageId).catch(() => null) : null;
        if (target) await target.delete().catch(() => {});
        await closeCard(message, `Message deleted by ${admin.username}`);
        return target ? 'Message deleted.' : 'The message was already gone.';
    }

    if (action === 'keep' || action === 'undo' || action === 'change') {
        const record = await getCaseByCode(rest[0]);
        if (!record) throw userError(`Case \`${rest[0]}\` no longer exists.`);

        if (action === 'keep') {
            await closeCard(message, `Kept by ${admin.username}`);
            return `Kept \`${record.case_code}\`.`;
        }

        if (action === 'undo') {
            const { notes, invite } = await reverse(client, record, admin, 'reversed');
            const dm = await dmReversal(client, record, invite);
            await closeCard(message, `Reversed by ${admin.username}. ${notes.join(' ')} DM: ${dm ? 'delivered' : 'not delivered'}.`);
            return `Reversed \`${record.case_code}\`. ${notes.join(' ')}`;
        }

        const choice = REVIEW_ACTIONS[interaction.values?.[0]];
        if (!choice) throw userError('Pick a punishment from the list.');
        const targetUser = await client.users.fetch(record.target_user_id);
        const { notes } = await reverse(client, record, admin, 'changed');
        let result;
        try {
            result = await executeAction({
                guild,
                moderator: interaction.member,
                targetUser,
                flow: flowFor(choice.step, {
                    reason: `${record.reason} (changed by ${admin.username})`,
                    reasonKey: record.reason_key,
                    targetUser,
                }),
            });
        } catch (error) {
            await closeCard(message, `Reversed by ${admin.username}, but "${choice.label}" failed: ${error.userMessage || error.message}`);
            throw error;
        }
        await dmReversal(client, record, null, choice.label);
        const code = result.record?.case_code;
        await closeCard(message, `Changed to ${choice.label}${code ? ` (case \`${code}\`)` : ''} by ${admin.username}. ${notes.join(' ')}`);
        return `Changed to ${choice.label}${code ? ` — case \`${code}\`` : ''}.`;
    }

    if (action === 'apply') {
        const [rule, userId] = rest;
        const choice = REVIEW_ACTIONS[interaction.values?.[0]];
        if (!choice) throw userError('Pick a punishment from the list.');
        const targetUser = await client.users.fetch(userId).catch(() => null);
        if (!targetUser) throw userError('That user no longer exists.');
        const label = AUTOMOD_RULES[rule]?.label;
        const result = await executeAction({
            guild,
            moderator: interaction.member,
            targetUser,
            flow: flowFor(choice.step, {
                reason: label ? `Automod: ${label} (applied by ${admin.username})` : `Reported message (decided by ${admin.username})`,
                reasonKey: `automod:${AUTOMOD_RULES[rule]?.group || REPORT_RULE}`,
                targetUser,
            }),
        });
        const code = result.record?.case_code;
        await closeCard(message, `${choice.label}${code ? ` (case \`${code}\`)` : ''} applied by ${admin.username}`);
        return `${choice.label} applied${code ? ` — case \`${code}\`` : ''}.`;
    }

    throw userError('Unknown review action.');
}
