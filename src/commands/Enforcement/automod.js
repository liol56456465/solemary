import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { getAutomodSettings, updateAutomodSettings } from '../../services/automod/automodSettings.js';
import { endLockdown, getLockdownState } from '../../services/automod/raidService.js';
import { describeStep } from '../../services/automod/reviewCards.js';
import { automodStats, formatAutomodStats } from '../../services/automod/automodReport.js';
import { collectOpenReviews, formatQueue } from '../../services/automod/reviewQueue.js';
import { RULE_MODES, hasRuleOverride, ruleMode } from '../../services/automod/policy.js';

const RULE_CHOICES = Object.entries(AUTOMOD_RULES)
    .sort(([, a], [, b]) => b.severity - a.severity)
    .map(([key, rule]) => ({ name: rule.label.slice(0, 100), value: key }));

const MODE_LABELS = { on: 'on', monitor: '👀 monitor', off: '⛔ off' };

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

async function statusEmbed(guildId) {
    const settings = await getAutomodSettings(guildId);
    const lockdown = await getLockdownState(guildId);
    const exempt = [...new Set([...automodConfig.exemptChannelIds, ...settings.exemptChannelIds])];
    const rules = Object.entries(AUTOMOD_RULES)
        .sort(([, a], [, b]) => b.severity - a.severity)
        .map(([key, rule]) => {
            const mode = ruleMode(settings, key);
            const tag = hasRuleOverride(settings, key) ? ` · **${MODE_LABELS[mode]}**` : mode === 'on' ? '' : ` · ${MODE_LABELS[mode]}`;
            return `**${rule.label}:** ${rule.steps.map(describeStep).join(' → ')}${tag}`;
        });
    return createEmbed({
        title: 'Automod',
        description: [
            `**Status:** ${settings.enabled ? 'on' : 'off'}`,
            `**Mode:** ${settings.mode === 'monitor' ? 'monitor (cards only, nothing is done)' : 'enforce (acts, then posts a review card)'}`,
            `**Lockdown:** ${lockdown?.active ? `active since <t:${Math.floor(new Date(lockdown.startedAt).getTime() / 1000)}:R>, ${lockdown.joinerIds.length} raid joiner(s)` : 'off'}`,
            `**Exempt channels:** ${exempt.length ? exempt.map((id) => `<#${id}>`).join(', ') : 'none'}`,
            '',
            '**Punishments** (1st → 2nd → 3rd+ offence within 30 days). A mode in **bold** is set for that rule with `/automod rule`; the others follow the global mode:',
            ...rules,
        ].join('\n'),
        color: settings.enabled ? 'primary' : 'secondary',
    });
}

export default {
    // Registered as a guild command in MAIN_GUILD_ID only.
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('automod')
        .setDescription('Automatic moderation: status, modes per rule and channel, review queue, raid lockdown')
        .addSubcommand((sub) => sub.setName('status').setDescription('Show the automod settings and punishments'))
        .addSubcommand((sub) => sub.setName('enable').setDescription('Turn automod on or off')
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand((sub) => sub.setName('mode').setDescription('Global mode: enforce (act automatically) or monitor (only review cards)')
            .addStringOption((option) => option.setName('mode').setDescription('Mode').setRequired(true)
                .addChoices({ name: 'enforce', value: 'enforce' }, { name: 'monitor', value: 'monitor' })))
        .addSubcommand((sub) => sub.setName('rule').setDescription('Set one rule to on, monitor or off (default: follow the global mode)')
            .addStringOption((option) => option.setName('rule').setDescription('Rule').setRequired(true).addChoices(...RULE_CHOICES))
            .addStringOption((option) => option.setName('mode').setDescription('Mode for this rule').setRequired(true)
                .addChoices(
                    { name: 'on (act and post a card)', value: 'on' },
                    { name: 'monitor (card only)', value: 'monitor' },
                    { name: 'off (ignore this rule)', value: 'off' },
                    { name: 'default (follow the global mode)', value: 'default' },
                )))
        .addSubcommand((sub) => sub.setName('exempt').setDescription('Add or remove a channel automod ignores')
            .addChannelOption((option) => option.setName('channel').setDescription('Channel or category').setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory)))
        .addSubcommand((sub) => sub.setName('stats').setDescription('Automod actions, undos and top offenders')
            .addIntegerOption((option) => option.setName('days').setDescription('How far back (default 7)').setMinValue(1).setMaxValue(90)))
        .addSubcommand((sub) => sub.setName('queue').setDescription('Review cards still waiting for a decision, newest first'))
        .addSubcommand((sub) => sub.setName('lockdown-end').setDescription('End a join-raid lockdown and restore the verification level')),

    async execute(interaction) {
        if (interaction.guildId !== enforcementConfig.mainGuildId) {
            throw new TitanBotError('Wrong guild for /automod', ErrorTypes.PERMISSION, 'This command only works in the main server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION, 'You need the Administrator permission to manage automod.', { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const guildId = interaction.guildId;
        const sub = interaction.options.getSubcommand();
        let note = null;

        if (sub === 'stats') {
            const stats = await automodStats(guildId, interaction.options.getInteger('days') || 7);
            const text = formatAutomodStats(stats);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: `Automod, last ${stats.days} day(s): ${stats.total} action(s)`,
                    fields: [
                        { name: 'Per rule', value: text.rules.slice(0, 1024) },
                        { name: 'Most actions against', value: text.offenders.slice(0, 1024) },
                    ],
                    footer: { text: text.footer },
                    color: 'primary',
                })],
            });
        }

        if (sub === 'queue') {
            const items = await collectOpenReviews(interaction.client);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: `Review queue: ${items.length} open`,
                    description: formatQueue(items),
                    footer: { text: 'Cards posted since the bot started, plus the review channel\'s last 50 messages that still have buttons. Low-severity lines are not listed.' },
                    color: items.length ? 'warning' : 'success',
                })],
            });
        }

        if (sub === 'enable') {
            const enabled = interaction.options.getBoolean('enabled');
            await updateAutomodSettings(guildId, { enabled });
            note = `Automod is now **${enabled ? 'on' : 'off'}**.`;
        } else if (sub === 'mode') {
            const mode = interaction.options.getString('mode');
            await updateAutomodSettings(guildId, { mode });
            note = mode === 'monitor'
                ? 'Monitor mode: automod only posts review cards; nothing is deleted or punished until you apply it. Rules with their own mode (`/automod rule`) keep it.'
                : 'Enforce mode: automod deletes and punishes automatically and posts a review card for every decision. Rules with their own mode (`/automod rule`) keep it.';
        } else if (sub === 'rule') {
            const rule = interaction.options.getString('rule');
            const mode = interaction.options.getString('mode');
            if (!AUTOMOD_RULES[rule]) throw userError('Unknown rule.');
            if (mode !== 'default' && !RULE_MODES.includes(mode)) throw userError('Unknown mode.');
            await updateAutomodSettings(guildId, (current) => {
                const ruleModes = { ...current.ruleModes };
                if (mode === 'default') delete ruleModes[rule]; else ruleModes[rule] = mode;
                return { ...current, ruleModes };
            });
            const label = AUTOMOD_RULES[rule].label;
            note = mode === 'default'
                ? `**${label}** follows the global mode again.`
                : `**${label}** is now **${mode}**${mode === 'monitor' ? ': cards only, nothing is done until you apply it' : mode === 'off' ? ': automod ignores it' : ''}.`;
        } else if (sub === 'exempt') {
            const channel = interaction.options.getChannel('channel');
            const settings = await getAutomodSettings(guildId);
            const ids = new Set(settings.exemptChannelIds);
            const adding = !ids.has(channel.id);
            if (adding) ids.add(channel.id); else ids.delete(channel.id);
            await updateAutomodSettings(guildId, { exemptChannelIds: [...ids] });
            note = adding ? `Automod now ignores <#${channel.id}>.` : `Automod checks <#${channel.id}> again.`;
        } else if (sub === 'lockdown-end') {
            const ended = await endLockdown(interaction.guild, interaction.user);
            if (!ended) throw userError('There is no lockdown right now.');
            note = 'Lockdown ended. The verification level is back to what it was.';
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: note ? [successEmbed('Automod updated', note), await statusEmbed(guildId)] : [await statusEmbed(guildId)],
        });
    },
};
