import { AutoModerationActionType, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { AUTOMOD_RULES } from '../../config/automod.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import {
    exemptChannelIdsOf, getAutomodSettings, getTrustedRoleProblem, isLegacyAutomodGuild, setAutomodEnabled, setAutomodMode, setChannelRuleMode,
    setExemptChannel, setInviteAllowlist, setJoinGateCheck, setMoodAlerts, setPanic, setRuleMode, setSecondChance, setStaffGuard, setTrusted,
} from '../../services/automod/automodSettings.js';
import { endLockdown, getLockdownState } from '../../services/automod/raidService.js';
import { describeStep } from '../../services/automod/reviewCards.js';
import { automodStats, formatAutomodStats } from '../../services/automod/automodReport.js';
import { collectOpenReviews, formatQueue } from '../../services/automod/reviewQueue.js';
import { endProbation, getProbation } from '../../services/automod/probationService.js';
import { DEFAULT_GATE_DAYS, JOIN_GATE_CHECKS, describeJoinGate, normalizeJoinGate } from '../../services/automod/joinGate.js';
import { loadNativePolicies, policyFor, setNativePolicy, triggerLabel } from '../../services/automod/nativeBridge.js';
import { actionLabel, limitForPlan, overLimitIds, resetCustomRulesCache, storedCustomRules } from '../../services/automod/customRules.js';
import { addRule, editRule, removeRule, toggleRule } from '../../services/automod/customRuleEdits.js';
import { guildPlan } from '../../services/billing/premiumEffects.js';
import { planName } from '../../services/billing/premiumService.js';
import { updateSettings } from '../../services/settings/guildSettings.js';
import { hasRuleOverride, isRelaxableRule, ruleMode } from '../../services/automod/policy.js';
import { snapshotOnGuardEnabled } from '../../services/structureBackupService.js';

const RULE_CHOICES = Object.entries(AUTOMOD_RULES)
    .sort(([, a], [, b]) => b.severity - a.severity)
    .map(([key, rule]) => ({ name: rule.label.slice(0, 100), value: key }));

const MODE_LABELS = { on: 'on', monitor: "report only (don't delete)", off: 'off' };

const CUSTOM_ACTION_CHOICES = [
    { name: 'delete', value: 'delete' },
    { name: 'delete + warn', value: 'warn' },
    { name: 'delete + mute', value: 'mute' },
];

/** Autocomplete entries for the custom rule names. Pure, for tests. */
export function customRuleChoices(rules, focused = '') {
    return (rules || [])
        .filter((rule) => !focused || rule.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((rule) => ({ name: `${rule.name} (${actionLabel(rule)}${rule.enabled === false ? ', off' : ''})`.slice(0, 100), value: rule.id }));
}

/** The /automod custom list text. Pure, for tests. */
export function customRulesText(rules, limit, plan) {
    if (!rules.length) {
        return limit
            ? `No custom rules yet. Add one with \`/automod custom add\`. The ${plan} plan allows ${limit}.`
            : 'No custom rules. They come with the Normal, Pro and Max plans, on the server owner\'s plan.';
    }
    const over = new Set(overLimitIds(rules, limit));
    const lines = rules.map((rule) => {
        const state = rule.enabled === false ? 'off' : over.has(rule.id) ? 'over the plan limit, not running' : 'on';
        const words = rule.words.join(', ');
        return `**${rule.name}**: ${actionLabel(rule)}, ${state}\n${words.length > 180 ? `${words.slice(0, 179)}…` : words}`;
    });
    return [`${rules.length} rule${rules.length === 1 ? '' : 's'}, up to ${limit} run on the ${plan} plan.`, ...lines].join('\n\n').slice(0, 4000);
}

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** "<#1>: English only off, Excessive caps report only (don't delete); <#2>: …" */
function channelExceptions(settings) {
    const parts = Object.entries(settings.channelRules || {}).map(([channelId, rules]) => {
        const list = Object.entries(rules).map(([rule, mode]) => `${AUTOMOD_RULES[rule]?.label || rule} ${MODE_LABELS[mode] || mode}`);
        return list.length ? `<#${channelId}>: ${list.join(', ')}` : null;
    }).filter(Boolean);
    return parts.length ? parts.join('; ') : 'none';
}

function relaxedRuleLabels() {
    return Object.keys(AUTOMOD_RULES).filter((key) => isRelaxableRule(key)).map((key) => AUTOMOD_RULES[key].label).join(', ');
}

/** The invite allowlist as text: codes as `code`, server ids as `id (server)`. */
export function inviteAllowlistText(list, maxChars = 300) {
    if (!list?.length) return 'none';
    const parts = list.map((entry) => (/^\d{17,20}$/.test(entry) ? `\`${entry}\` (server)` : `\`${entry}\``));
    let text = '';
    for (let i = 0; i < parts.length; i += 1) {
        const next = text ? `${text}, ${parts[i]}` : parts[i];
        if (next.length > maxChars) return `${text}, …and ${parts.length - i} more`;
        text = next;
    }
    return text;
}

/** Only the server owner may switch the staff guard off (directly or by turning automod off). */
export const STAFF_GUARD_OWNER_ONLY = 'Only the server owner can turn the staff guard off (or turn automod off while the staff guard is on).';

function staffGuardText(guildId, settings) {
    if (isLegacyAutomodGuild(guildId)) return 'always on in this server';
    if (!settings.staffGuard) return 'off';
    return settings.enabled ? 'on' : 'on, but only while automod is on';
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
    const exempt = exemptChannelIdsOf(guildId, settings);
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
            `**Mode:** ${settings.mode === 'monitor' ? "report only (don't delete): review cards only, nothing is done" : 'enforce (acts, then posts a review card)'}`,
            `**Lockdown:** ${lockdown?.active ? `active since <t:${Math.floor(new Date(lockdown.startedAt).getTime() / 1000)}:R>, ${lockdown.joinerIds.length} raid joiner(s)` : 'off'}`,
            `**Exempt channels:** ${exempt.length ? exempt.map((id) => `<#${id}>`).join(', ') : 'none'}`,
            `**Channel exceptions:** ${channelExceptions(settings)}`,
            `**Trusted members** (skip ${relaxedRuleLabels()}): ${trustedText(settings.trusted)}`,
            `**Friendly notice for a first small offence** (a notice, no warning): ${settings.secondChance ? 'on' : 'off'}`,
            `**Mood alerts** (calm-down note + slowmode in heated channels): ${settings.moodAlerts ? 'on' : 'off'}`,
            `**Join gate** (new members): ${describeJoinGate(settings.joinGate)}`,
            `**Raid panic mode** (lockdown also pauses invites and DMs): ${settings.panic.enabled ? `on, for ${settings.panic.hours} h` : 'off'}`,
            `**Allowed invites** (besides this server's own): ${inviteAllowlistText(settings.inviteAllowlist)}`,
            `**Staff guard** (anti-nuke: staff who mass-ban, mass-delete or add bots lose their staff roles): ${staffGuardText(guildId, settings)}`,
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
        timeout ? 'has a native timeout; the bot mutes with the Muted role, consider removing it' : null,
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
        .addSubcommand((sub) => sub.setName('mode').setDescription("Global mode: enforce (act automatically) or report only (don't delete): review cards only")
            .addStringOption((option) => option.setName('mode').setDescription('Mode').setRequired(true)
                .addChoices({ name: 'enforce', value: 'enforce' }, { name: "report only (don't delete)", value: 'monitor' })))
        .addSubcommand((sub) => sub.setName('rule').setDescription("Set one rule to on, report only (don't delete) or off (default: follow the global mode)")
            .addStringOption((option) => option.setName('rule').setDescription('Rule').setRequired(true).addChoices(...RULE_CHOICES))
            .addStringOption((option) => option.setName('mode').setDescription('Mode for this rule').setRequired(true)
                .addChoices(
                    { name: 'on (act and post a card)', value: 'on' },
                    { name: "report only (don't delete): review card only", value: 'monitor' },
                    { name: 'off (ignore this rule)', value: 'off' },
                    { name: 'default (follow the global mode)', value: 'default' },
                )))
        .addSubcommand((sub) => sub.setName('channel').setDescription("Set one rule to off or report only (don't delete) in one channel or category")
            .addChannelOption((option) => option.setName('channel').setDescription('Channel or category').setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory, ChannelType.GuildVoice))
            .addStringOption((option) => option.setName('rule').setDescription('Rule').setRequired(true).addChoices(...RULE_CHOICES))
            .addStringOption((option) => option.setName('mode').setDescription('Mode in this channel').setRequired(true)
                .addChoices(
                    { name: 'off (ignore this rule here)', value: 'off' },
                    { name: "report only (don't delete): review card only here", value: 'monitor' },
                    { name: 'default (remove the exception)', value: 'default' },
                )))
        .addSubcommand((sub) => sub.setName('trusted').setDescription('Members with this role or level skip the low-severity rules (caps, characters, English only)')
            .addRoleOption((option) => option.setName('role').setDescription('Trusted role'))
            .addIntegerOption((option) => option.setName('min_level').setDescription('Or at least this leveling level (0 = no level criterion)').setMinValue(0).setMaxValue(1000))
            .addBooleanOption((option) => option.setName('clear').setDescription('Remove the trusted role and level')))
        .addSubcommand((sub) => sub.setName('friendlynotice').setDescription('Friendly notice for a first small offence in 30 days, instead of a warning')
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand((sub) => sub.setName('mood').setDescription('Calm-down note and brief slowmode when a channel heats up')
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand((sub) => sub.setName('extrawatch').setDescription('Show or end a member\'s extra-watch period after a ban (they rejoined)')
            .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
            .addBooleanOption((option) => option.setName('end').setDescription('End the extra-watch period now')))
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
        .addSubcommand((sub) => sub.setName('invites').setDescription("Invites automod allows besides this server's own (codes, invite links or server ids)")
            .addStringOption((option) => option.setName('action').setDescription('What to do').setRequired(true)
                .addChoices({ name: 'list', value: 'list' }, { name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'clear', value: 'clear' }))
            .addStringOption((option) => option.setName('invite').setDescription('Invite link, invite code or server id').setMaxLength(100)))
        .addSubcommand((sub) => sub.setName('staffguard').setDescription('Anti-nuke: staff who mass-ban, mass-delete channels or roles, or add bots lose their staff roles')
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true)))
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
                    .setMinValue(0).setMaxValue(1440))))
        .addSubcommandGroup((group) => group.setName('custom').setDescription('Your own word filters (paid plans)')
            .addSubcommand((sub) => sub.setName('list').setDescription('List the custom rules'))
            .addSubcommand((sub) => sub.setName('add').setDescription('Add a custom rule')
                .addStringOption((option) => option.setName('name').setDescription('Short name').setRequired(true).setMaxLength(40))
                .addStringOption((option) => option.setName('words').setDescription('Words, comma separated').setRequired(true).setMaxLength(3000))
                .addStringOption((option) => option.setName('action').setDescription('What happens').setRequired(true).addChoices(...CUSTOM_ACTION_CHOICES))
                .addStringOption((option) => option.setName('mute_for').setDescription('Mute time, like 1h').setMaxLength(10)))
            .addSubcommand((sub) => sub.setName('edit').setDescription('Change a rule\'s words or action')
                .addStringOption((option) => option.setName('name').setDescription('The rule').setRequired(true).setAutocomplete(true))
                .addStringOption((option) => option.setName('words').setDescription('New words, comma separated (replaces)').setMaxLength(3000))
                .addStringOption((option) => option.setName('action').setDescription('New action').addChoices(...CUSTOM_ACTION_CHOICES))
                .addStringOption((option) => option.setName('mute_for').setDescription('Mute time, like 1h').setMaxLength(10)))
            .addSubcommand((sub) => sub.setName('toggle').setDescription('Turn a rule on or off')
                .addStringOption((option) => option.setName('name').setDescription('The rule').setRequired(true).setAutocomplete(true))
                .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true)))
            .addSubcommand((sub) => sub.setName('remove').setDescription('Remove a rule')
                .addStringOption((option) => option.setName('name').setDescription('The rule').setRequired(true).setAutocomplete(true)))),

    async autocomplete(interaction) {
        // Any server (multi-server B1): each server reads and changes only its own rules.
        if (!interaction.guildId || !isAdministrator(interaction.member)) return interaction.respond([]);
        const focused = String(interaction.options.getFocused() || '').toLowerCase();
        if (interaction.options.getSubcommandGroup(false) === 'custom') {
            return interaction.respond(customRuleChoices(storedCustomRules(interaction.guildId), focused)).catch(() => {});
        }
        const rules = await interaction.guild.autoModerationRules.fetch().catch(() => null);
        const choices = [...(rules?.values() || [])]
            .filter((rule) => !focused || rule.name.toLowerCase().includes(focused) || rule.id.includes(focused))
            .slice(0, 25)
            .map((rule) => ({ name: `${rule.name} (${triggerLabel(rule.triggerType)})`.slice(0, 100), value: rule.id }));
        return interaction.respond(choices).catch(() => {});
    },

    async execute(interaction) {
        // Every server (multi-server B1): settings, state and posts are this server's own. Automod
        // is off by default outside the main server until /automod enable turns it on.
        if (!interaction.guildId) {
            throw new TitanBotError('/automod outside a server', ErrorTypes.PERMISSION, 'Use this command in a server.', { expected: true });
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
            const items = await collectOpenReviews(interaction.client, interaction.guildId);
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
        if (interaction.options.getSubcommandGroup(false) === 'custom') {
            return handleCustom(interaction, sub);
        }

        if (sub === 'extrawatch') {
            const user = interaction.options.getUser('user');
            const end = interaction.options.getBoolean('end');
            const record = end ? await endProbation(guildId, user.id) : await getProbation(guildId, user.id);
            const until = record ? `<t:${Math.floor(Number(record.until) / 1000)}:F>` : null;
            let text;
            if (end) text = record ? `The extra-watch period for <@${user.id}> ended early (it ran until ${until}).` : `<@${user.id}> was not in an extra-watch period.`;
            else if (record) text = `<@${user.id}> is in an extra-watch period after a ban until ${until}${record.caseCode ? ` (ban \`${record.caseCode}\` ${record.how || 'ended'})` : ''}. Automod uses the next step of the ladder for them. End it with \`end: true\`.`;
            else text = `<@${user.id}> is not in an extra-watch period.`;
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [end && record ? successEmbed('Extra-watch period ended', text) : createEmbed({ title: 'Extra-watch period after a ban', description: text, color: record ? 'warning' : 'primary' })],
            });
        }

        if (sub === 'enable') {
            const enabled = interaction.options.getBoolean('enabled');
            // Turning automod off also stops the staff guard, so it is owner-only while the guard is on.
            if (!enabled && !isLegacyAutomodGuild(guildId) && interaction.user.id !== interaction.guild.ownerId) {
                const current = await getAutomodSettings(guildId);
                if (current.staffGuard) throw userError(STAFF_GUARD_OWNER_ONLY);
            }
            await setAutomodEnabled(guildId, enabled);
            note = `Automod is now **${enabled ? 'on' : 'off'}**.`;
        } else if (sub === 'mode') {
            const mode = interaction.options.getString('mode');
            await setAutomodMode(guildId, mode);
            note = mode === 'monitor'
                ? "Report only (don't delete) mode: automod only posts review cards; nothing is deleted or punished until you apply it. Rules with their own mode (`/automod rule`) keep it."
                : 'Enforce mode: automod deletes and punishes automatically and posts a review card for every decision. Rules with their own mode (`/automod rule`) keep it.';
        } else if (sub === 'rule') {
            const rule = interaction.options.getString('rule');
            const mode = interaction.options.getString('mode');
            await setRuleMode(guildId, rule, mode);
            const label = AUTOMOD_RULES[rule].label;
            note = mode === 'default'
                ? `**${label}** follows the global mode again.`
                : `**${label}** is now **${MODE_LABELS[mode] || mode}**${mode === 'monitor' ? ': cards only, nothing is done until you apply it' : mode === 'off' ? ': automod ignores it' : ''}.`;
        } else if (sub === 'channel') {
            const channel = interaction.options.getChannel('channel');
            const rule = interaction.options.getString('rule');
            const mode = interaction.options.getString('mode');
            await setChannelRuleMode(guildId, channel.id, rule, mode);
            const label = AUTOMOD_RULES[rule].label;
            note = mode === 'default'
                ? `**${label}** in <#${channel.id}> follows the rule's normal mode again.`
                : `**${label}** is **${MODE_LABELS[mode] || mode}** in <#${channel.id}>${channel.type === ChannelType.GuildCategory ? ' and the channels in it' : ''} (threads included).`;
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
        } else if (sub === 'friendlynotice') {
            const enabled = interaction.options.getBoolean('enabled');
            await setSecondChance(guildId, enabled);
            note = enabled
                ? 'Friendly notice for a first small offence is **on**: a member\'s first offence in 30 days on caps, characters, English only or mild language (no slurs) gets a short notice instead of a warning.'
                : 'Friendly notice for a first small offence is **off**: every offence gets the usual punishment.';
        } else if (sub === 'invites') {
            const action = interaction.options.getString('action');
            const saved = action === 'list'
                ? await getAutomodSettings(guildId)
                : await setInviteAllowlist(guildId, action, interaction.options.getString('invite'));
            note = `Allowed invites (besides this server's own): ${inviteAllowlistText(saved.inviteAllowlist)}`;
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
                ? `Raid panic mode is **on**: when a join raid starts a lockdown, invites and DMs are paused for **${saved.panic.hours} h** (lifted again by \`/automod lockdown-end\`).${canPause ? '' : '\nI don\'t have **Manage Server**, so the pause will fail until I get it.'}`
                : 'Raid panic mode is **off**: a lockdown only raises the verification level.';
        } else if (sub === 'staffguard') {
            const enabled = interaction.options.getBoolean('enabled');
            if (isLegacyAutomodGuild(guildId)) throw userError('The staff guard is always on in this server.');
            // A rogue admin must not be able to switch off the guard that limits them (anti-nuke).
            if (!enabled && interaction.user.id !== interaction.guild.ownerId) throw userError(STAFF_GUARD_OWNER_ONLY);
            const before = await getAutomodSettings(guildId);
            const saved = await setStaffGuard(guildId, enabled);
            // A first structure snapshot when the guard goes from off to on and none is from the
            // last 24 h, so "Show what changed" / "Revert…" work before the daily job reaches it.
            snapshotOnGuardEnabled(interaction.guild, before, saved)?.catch(() => {});
            const me = interaction.guild.members.me;
            const canAct = me?.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog]);
            note = enabled
                ? `Staff guard is **on**${saved.enabled ? '' : ' (it starts working once automod is on: `/automod enable`)'}: an admin who mass-bans, mass-kicks or mass-deletes channels or roles loses their staff roles, and a bot added by a non-owner is kicked. The server owner is never affected. I keep a daily snapshot of the channels and roles, so a nuke alert can show what changed and revert it.${canAct ? '' : '\nI need **Manage Roles** and **View Audit Log** for it to work.'}`
                : 'Staff guard is **off**.';
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

async function handleCustom(interaction, sub) {
    const guildId = interaction.guildId;
    const planId = guildPlan(guildId);
    const plan = planId === 'free' ? 'Free' : planName(planId);
    const limit = limitForPlan(planId);
    const list = storedCustomRules(guildId);
    const opt = (name) => interaction.options.getString(name);

    if (sub === 'list') {
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({ title: 'Custom automod rules', description: customRulesText(list, limit, plan), color: 'primary' })],
            allowedMentions: { parse: [] },
        });
    }

    let result;
    try {
        if (sub === 'add') {
            const next = addRule(list, { name: opt('name'), words: opt('words'), action: opt('action'), muteDuration: opt('mute_for') }, { limit, planName: plan });
            result = { list: next, note: `Custom rule **${next[next.length - 1].name}** added (${actionLabel(next[next.length - 1])}).` };
        } else if (sub === 'edit') {
            if (!opt('words') && !opt('action') && !opt('mute_for')) throw userError('Give new words, a new action, or a new mute time.');
            const { list: next, rule } = editRule(list, opt('name'), { words: opt('words'), action: opt('action'), muteDuration: opt('mute_for') });
            result = { list: next, note: `Custom rule **${rule.name}** changed: ${actionLabel(rule)}, ${rule.words.length} word${rule.words.length === 1 ? '' : 's'} or phrase${rule.words.length === 1 ? '' : 's'}.` };
        } else if (sub === 'toggle') {
            const enabled = interaction.options.getBoolean('enabled');
            const { list: next, rule, changed } = toggleRule(list, opt('name'), enabled);
            result = { list: changed ? next : null, note: `Custom rule **${rule.name}** is ${enabled ? 'on' : 'off'}${changed ? '' : ' already'}.` };
        } else if (sub === 'remove') {
            const { list: next, rule } = removeRule(list, opt('name'));
            result = { list: next, note: `Custom rule **${rule.name}** removed.` };
        }
    } catch (error) {
        if (error?.name === 'CustomRuleError' || error?.userMessage) throw userError(error.userMessage || error.message);
        throw error;
    }
    if (!result) throw userError('Unknown option.');
    if (result.list) {
        await updateSettings(guildId, { automodCustomRules: result.list }, { userId: interaction.user.id, username: interaction.user.username, module: 'automod' });
        resetCustomRulesCache();
    }
    const fresh = result.list || list;
    const over = overLimitIds(fresh, limit).length;
    const extra = over ? `\n${over} turned-on rule${over === 1 ? ' is' : 's are'} over the ${plan} plan limit of ${limit} and ${over === 1 ? 'does' : 'do'} not run.` : '';
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Automod updated', `${result.note}${extra}`)],
        allowedMentions: { parse: [] },
    });
}
