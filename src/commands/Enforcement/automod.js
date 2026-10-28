import { AutoModerationActionType, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import {
    getAutomodSettings, getTrustedRoleProblem, setAutomodEnabled, setAutomodMode, setChannelRuleMode,
    setExemptChannel, setJoinGateCheck, setMoodAlerts, setPanic, setRuleMode, setSecondChance, setTrusted,
} from '../../services/automod/automodSettings.js';
import { endLockdown, getLockdownState } from '../../services/automod/raidService.js';
import { describeStep } from '../../services/automod/reviewCards.js';
import { automodStats, formatAutomodStats } from '../../services/automod/automodReport.js';
import { collectOpenReviews, formatQueue } from '../../services/automod/reviewQueue.js';
import { endProbation, getProbation } from '../../services/automod/probationService.js';
import { DEFAULT_GATE_DAYS, JOIN_GATE_CHECKS, describeJoinGate, normalizeJoinGate } from '../../services/automod/joinGate.js';
import { loadNativePolicies, policyFor, setNativePolicy, triggerLabel } from '../../services/automod/nativeBridge.js';
import { hasRuleOverride, isRelaxableRule, ruleMode } from '../../services/automod/policy.js';

const RULE_CHOICES = Object.entries(AUTOMOD_RULES)
    .sort(([, a], [, b]) => b.severity - a.severity)
    .map(([key, rule]) => ({ name: rule.label.slice(0, 100), value: key }));

const MODE_LABELS = { on: 'on', monitor: '👀 monitor', off: '⛔ off' };

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** "<#1>: English only off, Excessive caps monitor; <#2>: …" */
function channelExceptions(settings) {
    const parts = Object.entries(settings.channelRules || {}).map(([channelId, rules]) => {
        const list = Object.entries(rules).map(([rule, mode]) => `${AUTOMOD_RULES[rule]?.label || rule} ${mode}`);
        return list.length ? `<#${channelId}>: ${list.join(', ')}` : null;
    }).filter(Boolean);
    return parts.length ? parts.join('; ') : 'none';
}

function relaxedRuleLabels() {
    return Object.keys(AUTOMOD_RULES).filter((key) => isRelaxableRule(key)).map((key) => AUTOMOD_RULES[key].label).join(', ');
}

function trustedText(trusted) {
    const parts = [];
    if (trusted?.roleId) parts.push(`<@&${trusted.roleId}>`);
    if (trusted?.minLevel > 0) parts.push(`level ${trusted.minLevel}+`);
    return parts.length ? parts.join(' or ') : 'not set';
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
            `**Channel exceptions:** ${channelExceptions(settings)}`,
            `**Trusted members** (skip ${relaxedRuleLabels()}): ${trustedText(settings.trusted)}`,
            `**Second chance** (first small offence: a notice, no warning): ${settings.secondChance ? 'on' : 'off'}`,
            `**Mood alerts** (calm-down note + slowmode in heated channels): ${settings.moodAlerts ? 'on' : 'off'}`,
            `**Join gate** (new members): ${describeJoinGate(settings.joinGate)}`,
            `**Raid panic mode** (lockdown also pauses invites and DMs): ${settings.panic.enabled ? `on, for ${settings.panic.hours} h` : 'off'}`,
            '',
            '**Punishments** (1st → 2nd → 3rd+ offence within 30 days). A mode in **bold** is set for that rule with `/automod rule`; the others follow the global mode:',
            ...rules,
        ].join('\n'),
        color: settings.enabled ? 'primary' : 'secondary',
    });
}

const POLICY_TEXT = {
    ignore: 'ignore',
    log: 'log (a line in the review channel)',
    warn: 'warn (a warning and a review card)',
};

/** One native rule's line: name, trigger, policy, dedupe, and a note on native timeouts. */
function nativeRuleLine(rule, policies) {
    const { policy, dedupeMinutes } = policyFor(policies, rule.id);
    const stored = policies.has(rule.id) ? '' : ' (default)';
    const blocks = rule.actions.some((action) => action.type === AutoModerationActionType.BlockMessage);
    const timeout = rule.actions.some((action) => action.type === AutoModerationActionType.Timeout);
    const notes = [
        rule.enabled ? null : 'disabled',
        blocks ? null : 'does not block messages, so the bot never sees it',
        timeout ? '⚠️ has a native timeout; the bot mutes with the Muted role, consider removing it' : null,
    ].filter(Boolean);
    return `**${rule.name}** · ${triggerLabel(rule.triggerType)} · \`${rule.id}\`\n`
        + `→ ${POLICY_TEXT[policy]}${stored}, once per ${dedupeMinutes} min per member${notes.length ? `\n-# ${notes.join(' · ')}` : ''}`;
}

async function handleNative(interaction, sub) {
    const guild = interaction.guild;
    if (sub === 'list') {
        const [rules, policies] = await Promise.all([
            guild.autoModerationRules.fetch(),
            loadNativePolicies(guild.id),
        ]);
        const lines = [...rules.values()].map((rule) => nativeRuleLine(rule, policies));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: `Native AutoMod rules: ${rules.size}`,
                description: (lines.join('\n\n') || 'This server has no native AutoMod rules.').slice(0, 4000),
                footer: { text: 'Change one with /automod native set. The bot needs Manage Server to receive these events.' },
                color: 'primary',
            })],
        });
    }
    const ruleId = interaction.options.getString('rule');
    const policy = interaction.options.getString('policy');
    const dedupeMinutes = interaction.options.getInteger('dedupe_minutes');
    if (!/^\d{17,20}$/.test(ruleId || '')) throw userError('Pick a native AutoMod rule from the list.');
    const rule = await guild.autoModerationRules.fetch(ruleId).catch(() => null);
    if (!rule) throw userError('That native AutoMod rule no longer exists.');
    await setNativePolicy(guild.id, ruleId, policy, dedupeMinutes, interaction.user.id);
    const policies = await loadNativePolicies(guild.id);
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Native AutoMod rule updated', nativeRuleLine(rule, policies))],
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
        .addSubcommand((sub) => sub.setName('channel').setDescription('Turn one rule off or to monitor in one channel or category (e.g. English only in #international)')
            .addChannelOption((option) => option.setName('channel').setDescription('Channel or category').setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory, ChannelType.GuildVoice))
            .addStringOption((option) => option.setName('rule').setDescription('Rule').setRequired(true).addChoices(...RULE_CHOICES))
            .addStringOption((option) => option.setName('mode').setDescription('Mode in this channel').setRequired(true)
                .addChoices(
                    { name: 'off (ignore this rule here)', value: 'off' },
                    { name: 'monitor (card only here)', value: 'monitor' },
                    { name: 'default (remove the exception)', value: 'default' },
                )))
        .addSubcommand((sub) => sub.setName('trusted').setDescription('Members with this role or level skip the low-severity rules (caps, characters, English only)')
            .addRoleOption((option) => option.setName('role').setDescription('Trusted role'))
            .addIntegerOption((option) => option.setName('min_level').setDescription('Or at least this leveling level (0 = no level criterion)').setMinValue(0).setMaxValue(1000))
            .addBooleanOption((option) => option.setName('clear').setDescription('Remove the trusted role and level')))
        .addSubcommand((sub) => sub.setName('secondchance').setDescription('First small offence in 30 days: a notice instead of a warning')
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand((sub) => sub.setName('mood').setDescription('Calm-down note and brief slowmode when a channel heats up')
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand((sub) => sub.setName('probation').setDescription('Show or end a member\'s probation (rejoined after a ban)')
            .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
            .addBooleanOption((option) => option.setName('end').setDescription('End the probation now')))
        .addSubcommand((sub) => sub.setName('exempt').setDescription('Add or remove a channel automod ignores completely (all rules)')
            .addChannelOption((option) => option.setName('channel').setDescription('Channel or category').setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory)))
        .addSubcommand((sub) => sub.setName('stats').setDescription('Automod actions, undos and top offenders')
            .addIntegerOption((option) => option.setName('days').setDescription('How far back (default 7)').setMinValue(1).setMaxValue(90)))
        .addSubcommand((sub) => sub.setName('queue').setDescription('Review cards still waiting for a decision, newest first'))
        .addSubcommand((sub) => sub.setName('joingate').setDescription('Checks on new members: flag them for staff or kick them (with a DM)')
            .addStringOption((option) => option.setName('check').setDescription('Which check').setRequired(true)
                .addChoices(...Object.entries(JOIN_GATE_CHECKS).map(([value, { label }]) => ({ name: label, value }))))
            .addStringOption((option) => option.setName('action').setDescription('What to do when it hits').setRequired(true)
                .addChoices(
                    { name: 'off', value: 'off' },
                    { name: 'flag (a line in the review channel)', value: 'flag' },
                    { name: 'kick (with a DM saying how to come back)', value: 'kick' },
                ))
            .addIntegerOption((option) => option.setName('days').setDescription(`New account check: younger than this many days (default ${DEFAULT_GATE_DAYS})`).setMinValue(1).setMaxValue(365)))
        .addSubcommand((sub) => sub.setName('panic').setDescription('Raid panic mode: a lockdown also pauses invites and DMs (Discord incident actions)')
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true))
            .addIntegerOption((option) => option.setName('hours').setDescription('How long the pause lasts (default 2, max 24)').setMinValue(1).setMaxValue(24)))
        .addSubcommand((sub) => sub.setName('lockdown-end').setDescription('End a join-raid lockdown: restore the verification level, resume invites and DMs'))
        .addSubcommandGroup((group) => group.setName('native').setDescription('Discord\'s own AutoMod rules: what the bot does when one blocks a message')
            .addSubcommand((sub) => sub.setName('list').setDescription('List the server\'s native AutoMod rules and their policy'))
            .addSubcommand((sub) => sub.setName('set').setDescription('Ignore, log or warn when a native AutoMod rule blocks a message')
                .addStringOption((option) => option.setName('rule').setDescription('Native AutoMod rule').setRequired(true).setAutocomplete(true))
                .addStringOption((option) => option.setName('policy').setDescription('What the bot does').setRequired(true)
                    .addChoices(
                        { name: 'ignore', value: 'ignore' },
                        { name: 'log (a line in the review channel)', value: 'log' },
                        { name: 'warn (a warning and a review card)', value: 'warn' },
                    ))
                .addIntegerOption((option) => option.setName('dedupe_minutes').setDescription('At most one action per member and rule in this many minutes (default 10)')
                    .setMinValue(0).setMaxValue(1440)))),

    async autocomplete(interaction) {
        if (interaction.guildId !== enforcementConfig.mainGuildId || !isAdministrator(interaction.member)) return interaction.respond([]);
        const focused = String(interaction.options.getFocused() || '').toLowerCase();
        const rules = await interaction.guild.autoModerationRules.fetch().catch(() => null);
        const choices = [...(rules?.values() || [])]
            .filter((rule) => !focused || rule.name.toLowerCase().includes(focused) || rule.id.includes(focused))
            .slice(0, 25)
            .map((rule) => ({ name: `${rule.name} (${triggerLabel(rule.triggerType)})`.slice(0, 100), value: rule.id }));
        return interaction.respond(choices).catch(() => {});
    },

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

        if (interaction.options.getSubcommandGroup(false) === 'native') {
            return handleNative(interaction, sub);
        }

        if (sub === 'probation') {
            const user = interaction.options.getUser('user');
            const end = interaction.options.getBoolean('end');
            const record = end ? await endProbation(guildId, user.id) : await getProbation(guildId, user.id);
            const until = record ? `<t:${Math.floor(Number(record.until) / 1000)}:F>` : null;
            let text;
            if (end) text = record ? `Probation for <@${user.id}> ended early (it ran until ${until}).` : `<@${user.id}> was not on probation.`;
            else if (record) text = `<@${user.id}> is on probation until ${until}${record.caseCode ? ` (ban \`${record.caseCode}\` ${record.how || 'ended'})` : ''}. Automod uses the next step of the ladder for them. End it with \`end: true\`.`;
            else text = `<@${user.id}> is not on probation.`;
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [end && record ? successEmbed('Probation ended', text) : createEmbed({ title: 'Probation', description: text, color: record ? 'warning' : 'primary' })],
            });
        }

        if (sub === 'enable') {
            const enabled = interaction.options.getBoolean('enabled');
            await setAutomodEnabled(guildId, enabled);
            note = `Automod is now **${enabled ? 'on' : 'off'}**.`;
        } else if (sub === 'mode') {
            const mode = interaction.options.getString('mode');
            await setAutomodMode(guildId, mode);
            note = mode === 'monitor'
                ? 'Monitor mode: automod only posts review cards; nothing is deleted or punished until you apply it. Rules with their own mode (`/automod rule`) keep it.'
                : 'Enforce mode: automod deletes and punishes automatically and posts a review card for every decision. Rules with their own mode (`/automod rule`) keep it.';
        } else if (sub === 'rule') {
            const rule = interaction.options.getString('rule');
            const mode = interaction.options.getString('mode');
            await setRuleMode(guildId, rule, mode);
            const label = AUTOMOD_RULES[rule].label;
            note = mode === 'default'
                ? `**${label}** follows the global mode again.`
                : `**${label}** is now **${mode}**${mode === 'monitor' ? ': cards only, nothing is done until you apply it' : mode === 'off' ? ': automod ignores it' : ''}.`;
        } else if (sub === 'channel') {
            const channel = interaction.options.getChannel('channel');
            const rule = interaction.options.getString('rule');
            const mode = interaction.options.getString('mode');
            await setChannelRuleMode(guildId, channel.id, rule, mode);
            const label = AUTOMOD_RULES[rule].label;
            note = mode === 'default'
                ? `**${label}** in <#${channel.id}> follows the rule's normal mode again.`
                : `**${label}** is **${mode}** in <#${channel.id}>${channel.type === ChannelType.GuildCategory ? ' and the channels in it' : ''} (threads included).`;
        } else if (sub === 'trusted') {
            const role = interaction.options.getRole('role');
            const minLevel = interaction.options.getInteger('min_level');
            const clear = interaction.options.getBoolean('clear');
            if (!clear && !role && minLevel === null) throw userError('Give a role, a minimum level, or clear: true.');
            const roleProblem = role ? getTrustedRoleProblem(interaction.guild, role) : null;
            if (roleProblem) throw userError(roleProblem);
            const saved = await setTrusted(guildId, {
                roleId: role ? role.id : undefined,
                minLevel: minLevel ?? undefined,
                clear: Boolean(clear),
            });
            note = clear || (!saved.trusted.roleId && !saved.trusted.minLevel)
                ? 'No trusted members: everyone is held to every rule.'
                : `Trusted: ${trustedText(saved.trusted)}. They skip ${relaxedRuleLabels()}.`;
        } else if (sub === 'secondchance') {
            const enabled = interaction.options.getBoolean('enabled');
            await setSecondChance(guildId, enabled);
            note = enabled
                ? 'Second chance is **on**: a member\'s first offence in 30 days on caps, characters, English only or mild language (no slurs) gets a short notice instead of a warning.'
                : 'Second chance is **off**: every offence gets the usual punishment.';
        } else if (sub === 'mood') {
            const enabled = interaction.options.getBoolean('enabled');
            await setMoodAlerts(guildId, enabled);
            note = enabled
                ? 'Mood alerts are **on**: when insults or caps floods from 3+ members pile up in a channel, the bot posts one calm-down note, turns on slowmode for a few minutes and tells the alerts channel.'
                : 'Mood alerts are **off**.';
        } else if (sub === 'joingate') {
            const check = interaction.options.getString('check');
            const action = interaction.options.getString('action');
            const days = interaction.options.getInteger('days');
            const saved = await setJoinGateCheck(guildId, check, action, days);
            const gate = normalizeJoinGate(saved.joinGate);
            const ageNote = check === 'age' && action !== 'off'
                ? `\nAccounts younger than **${gate.ageDays} day(s)**. "Verify with Discord" already holds accounts younger than ${DEFAULT_GATE_DAYS} days for approval; members who verified that way are never gated.`
                : '';
            note = `Join gate: **${JOIN_GATE_CHECKS[check].label}** → **${action}**.${ageNote}\n${describeJoinGate(gate)}`;
        } else if (sub === 'panic') {
            const enabled = interaction.options.getBoolean('enabled');
            const hours = interaction.options.getInteger('hours');
            const saved = await setPanic(guildId, { enabled, hours });
            const canPause = interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild);
            note = enabled
                ? `Raid panic mode is **on**: when a join raid starts a lockdown, invites and DMs are paused for **${saved.panic.hours} h** (lifted again by \`/automod lockdown-end\`).${canPause ? '' : '\n⚠️ I don\'t have **Manage Server**, so the pause will fail until I get it.'}`
                : 'Raid panic mode is **off**: a lockdown only raises the verification level.';
        } else if (sub === 'exempt') {
            const channel = interaction.options.getChannel('channel');
            const { exempt: adding } = await setExemptChannel(guildId, channel.id, 'toggle');
            note = adding ? `Automod now ignores <#${channel.id}>.` : `Automod checks <#${channel.id}> again.`;
        } else if (sub === 'lockdown-end') {
            const ended = await endLockdown(interaction.guild, interaction.user);
            if (!ended) throw userError('There is no lockdown right now.');
            note = 'Lockdown ended. The verification level is back to what it was, and paused invites and DMs are resumed.';
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: note ? [successEmbed('Automod updated', note), await statusEmbed(guildId)] : [await statusEmbed(guildId)],
        });
    },
};
