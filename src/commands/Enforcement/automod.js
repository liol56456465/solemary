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
import {
    DEFAULT_GATE_DAYS, JOIN_GATE_CHECKS, describeJoinGate, joinGateActionText, joinGateCheckText, normalizeJoinGate,
} from '../../services/automod/joinGate.js';
import { loadNativePolicies, policyFor, setNativePolicy, triggerLabel } from '../../services/automod/nativeBridge.js';
import { actionLabel, limitForPlan, overLimitIds, resetCustomRulesCache, storedCustomRules } from '../../services/automod/customRules.js';
import { addRule, editRule, removeRule, toggleRule } from '../../services/automod/customRuleEdits.js';
import { guildPlan } from '../../services/billing/premiumEffects.js';
import { planName } from '../../services/billing/premiumService.js';
import { updateSettings } from '../../services/settings/guildSettings.js';
import { hasRuleOverride, isRelaxableRule, ruleMode } from '../../services/automod/policy.js';
import { snapshotOnGuardEnabled } from '../../services/structureBackupService.js';
import { resolveChannelId } from '../../services/automod/channelRouting.js';
import { botText, textForInteraction } from '../../utils/botText.js';
import { DISCORD_LOCALES_BY_LANG, descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { BoundedMap } from '../../utils/boundedMap.js';

// Language (utils/botText.js): every /automod answer is ephemeral, in the admin's Discord language.
// Rule names, mode words and join gate checks are translated here; English is the code's own text.

// Rule names in a language (literal keys; English: config/automod.js labels, the catalog has the same).
const RULE_LABEL_TEXT = {
    scam: (tr) => tr.t('automod.cmd.rules.scam'),
    nsfw: (tr) => tr.t('automod.cmd.rules.nsfw'),
    sexual: (tr) => tr.t('automod.cmd.rules.sexual'),
    harassment: (tr) => tr.t('automod.cmd.rules.harassment'),
    privacy: (tr) => tr.t('automod.cmd.rules.privacy'),
    advertising: (tr) => tr.t('automod.cmd.rules.advertising'),
    impersonation: (tr) => tr.t('automod.cmd.rules.impersonation'),
    language: (tr) => tr.t('automod.cmd.rules.language'),
    disrespect: (tr) => tr.t('automod.cmd.rules.disrespect'),
    mentions: (tr) => tr.t('automod.cmd.rules.mentions'),
    spam: (tr) => tr.t('automod.cmd.rules.spam'),
    caps: (tr) => tr.t('automod.cmd.rules.caps'),
    characters: (tr) => tr.t('automod.cmd.rules.characters'),
    english: (tr) => tr.t('automod.cmd.rules.english'),
};
const RULE_LABEL_KEYS = Object.fromEntries(Object.keys(RULE_LABEL_TEXT).map((key) => [key, `automod.cmd.rules.${key}`]));
export { RULE_LABEL_KEYS };

/** A rule's name in the translator's language. */
function ruleLabel(key, tr) {
    const english = AUTOMOD_RULES[key]?.label || key;
    if (tr.lang === 'en' || !RULE_LABEL_TEXT[key]) return english;
    return RULE_LABEL_TEXT[key](tr);
}

/** Discord's per-locale map for a rule choice (rule names are ≤100 characters). */
function ruleChoiceLocalizations(key) {
    const out = {};
    if (!RULE_LABEL_TEXT[key]) return out;
    for (const [lang, locales] of Object.entries(DISCORD_LOCALES_BY_LANG)) {
        const text = RULE_LABEL_TEXT[key](botText(lang)).slice(0, 100);
        for (const locale of locales) out[locale] = text;
    }
    return out;
}

const RULE_CHOICES = Object.entries(AUTOMOD_RULES)
    .sort(([, a], [, b]) => b.severity - a.severity)
    .map(([key, rule]) => ({ name: rule.label.slice(0, 100), name_localizations: ruleChoiceLocalizations(key), value: key }));

const MODE_LABELS = { on: 'on', monitor: "report only (don't delete)", off: 'off' };
const MODE_TEXT = {
    on: (tr) => tr.t('automod.cmd.modeLabel.on'),
    monitor: (tr) => tr.t('automod.cmd.modeLabel.monitor'),
    off: (tr) => tr.t('automod.cmd.modeLabel.off'),
};
const modeLabel = (mode, tr) => (MODE_TEXT[mode] ? MODE_TEXT[mode](tr) : MODE_LABELS[mode] || mode);
const onOff = (value, tr) => (value ? tr.t('automod.cmd.word.on') : tr.t('automod.cmd.word.off'));

const CUSTOM_ACTION_CHOICES = [
    { name: 'delete', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceDelete'), value: 'delete' },
    { name: 'delete + warn', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceDeleteWarn'), value: 'warn' },
    { name: 'delete + mute', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceDeleteMute'), value: 'mute' },
];

const GATE_CHECK_CHOICE_LOCALIZATIONS = {
    avatar: descriptionLocalizations('automod.joinGate.check.avatar'),
    links: descriptionLocalizations('automod.joinGate.check.links'),
    botname: descriptionLocalizations('automod.joinGate.check.botname'),
    age: descriptionLocalizations('automod.joinGate.check.age'),
};

/** A custom rule's action in a language (English: customRules.actionLabel as is). */
function customActionLabel(rule, tr) {
    if (tr.lang === 'en') return actionLabel(rule);
    if (rule.action === 'mute') return tr.t('automod.cmd.custom.actionMute', { duration: rule.muteDuration });
    return rule.action === 'warn' ? tr.t('automod.cmd.custom.actionWarn') : tr.t('automod.cmd.custom.actionDelete');
}

/** Autocomplete entries for the custom rule names. Pure, for tests. */
export function customRuleChoices(rules, focused = '', { lang = 'en' } = {}) {
    const tr = botText(lang);
    return (rules || [])
        .filter((rule) => !focused || rule.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((rule) => ({ name: `${rule.name} (${customActionLabel(rule, tr)}${rule.enabled === false ? tr.t('automod.cmd.custom.choiceOff') : ''})`.slice(0, 100), value: rule.id }));
}

/** The /automod custom list text. Pure, for tests. */
export function customRulesText(rules, limit, plan, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!rules.length) {
        return limit
            ? tr.t('automod.cmd.custom.noneYet', { plan, limit })
            : tr.t('automod.cmd.custom.nonePlan');
    }
    const over = new Set(overLimitIds(rules, limit));
    const lines = rules.map((rule) => {
        const state = rule.enabled === false ? tr.t('automod.cmd.word.off') : over.has(rule.id) ? tr.t('automod.cmd.custom.overLimitState') : tr.t('automod.cmd.word.on');
        const words = rule.words.join(', ');
        return `${tr.t('automod.cmd.custom.ruleLine', { name: rule.name, action: customActionLabel(rule, tr), state })}\n${words.length > 180 ? `${words.slice(0, 179)}…` : words}`;
    });
    return [tr.tp('automod.cmd.custom.header', rules.length, { limit, plan }), ...lines].join('\n\n').slice(0, 4000);
}

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

/** "<#1>: English only off, Excessive caps report only (don't delete); <#2>: …" */
function channelExceptions(settings, tr) {
    const parts = Object.entries(settings.channelRules || {}).map(([channelId, rules]) => {
        const list = Object.entries(rules).map(([rule, mode]) => `${ruleLabel(rule, tr)} ${modeLabel(mode, tr)}`);
        return list.length ? `<#${channelId}>: ${list.join(', ')}` : null;
    }).filter(Boolean);
    return parts.length ? parts.join('; ') : tr.t('automod.cmd.word.none');
}

function relaxedRuleLabels(tr) {
    return Object.keys(AUTOMOD_RULES).filter((key) => isRelaxableRule(key)).map((key) => ruleLabel(key, tr)).join(', ');
}

/** The invite allowlist as text: codes as `code`, server ids as `id (server)`. */
export function inviteAllowlistText(list, maxChars = 300, { lang = 'en' } = {}) {
    const tr = botText(lang);
    if (!list?.length) return tr.t('automod.cmd.word.none');
    const parts = list.map((entry) => (/^\d{17,20}$/.test(entry) ? tr.t('automod.cmd.invites.server', { id: entry }) : `\`${entry}\``));
    let text = '';
    for (let i = 0; i < parts.length; i += 1) {
        const next = text ? `${text}, ${parts[i]}` : parts[i];
        if (next.length > maxChars) return `${text}${tr.t('automod.cmd.invites.more', { count: parts.length - i })}`;
        text = next;
    }
    return text;
}

/** Only the server owner may switch the staff guard off (directly or by turning automod off). */
export const STAFF_GUARD_OWNER_ONLY = 'Only the server owner can turn the staff guard off (or turn automod off while the staff guard is on).';

function staffGuardText(guildId, settings, tr) {
    if (isLegacyAutomodGuild(guildId)) return tr.t('automod.cmd.status.guardAlways');
    if (!settings.staffGuard) return tr.t('automod.cmd.word.off');
    return settings.enabled ? tr.t('automod.cmd.word.on') : tr.t('automod.cmd.status.guardWhileOn');
}

function trustedText(trusted, tr) {
    const parts = [];
    if (trusted?.roleId) parts.push(`<@&${trusted.roleId}>`);
    if (trusted?.minLevel > 0) parts.push(tr.t('automod.cmd.trusted.level', { level: trusted.minLevel }));
    return parts.length ? parts.join(tr.t('automod.cmd.trusted.or')) : tr.t('automod.cmd.trusted.notSet');
}

/** The /automod status embed's description. Pure (settings + lockdown in), for tests. */
export function statusDescription(guildId, settings, lockdown, exempt, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const rules = Object.entries(AUTOMOD_RULES)
        .sort(([, a], [, b]) => b.severity - a.severity)
        .map(([key, rule]) => {
            const mode = ruleMode(settings, key);
            const tag = hasRuleOverride(settings, key) ? ` · **${modeLabel(mode, tr)}**` : mode === 'on' ? '' : ` · ${modeLabel(mode, tr)}`;
            // describeStep (reviewFormat.js) is English unless it takes { lang }.
            return `**${ruleLabel(key, tr)}:** ${rule.steps.map((step) => describeStep(step, { lang })).join(' → ')}${tag}`;
        });
    const lockdownText = lockdown?.active
        ? tr.t('automod.cmd.status.lockdownActive', { since: `<t:${Math.floor(new Date(lockdown.startedAt).getTime() / 1000)}:R>`, count: lockdown.joinerIds.length })
        : tr.t('automod.cmd.word.off');
    return [
        tr.t('automod.cmd.status.status', { value: onOff(settings.enabled, tr) }),
        tr.t('automod.cmd.status.mode', { value: settings.mode === 'monitor' ? tr.t('automod.cmd.status.modeMonitor') : tr.t('automod.cmd.status.modeEnforce') }),
        tr.t('automod.cmd.status.lockdown', { value: lockdownText }),
        tr.t('automod.cmd.status.exempt', { value: exempt.length ? exempt.map((id) => `<#${id}>`).join(', ') : tr.t('automod.cmd.word.none') }),
        tr.t('automod.cmd.status.channelExceptions', { value: channelExceptions(settings, tr) }),
        tr.t('automod.cmd.status.trusted', { rules: relaxedRuleLabels(tr), value: trustedText(settings.trusted, tr) }),
        tr.t('automod.cmd.status.friendly', { value: onOff(settings.secondChance, tr) }),
        tr.t('automod.cmd.status.mood', { value: onOff(settings.moodAlerts, tr) }),
        tr.t('automod.cmd.status.joinGate', { value: describeJoinGate(settings.joinGate, { lang }) }),
        tr.t('automod.cmd.status.panic', { value: settings.panic.enabled ? tr.t('automod.cmd.status.panicOn', { hours: settings.panic.hours }) : tr.t('automod.cmd.word.off') }),
        tr.t('automod.cmd.status.invites', { value: inviteAllowlistText(settings.inviteAllowlist, 300, { lang }) }),
        tr.t('automod.cmd.status.staffGuard', { value: staffGuardText(guildId, settings, tr) }),
        '',
        tr.t('automod.cmd.status.punishments'),
        ...rules,
    ].join('\n').slice(0, 4096);
}

async function statusEmbed(guildId, tr) {
    const settings = await getAutomodSettings(guildId);
    const lockdown = await getLockdownState(guildId);
    const exempt = exemptChannelIdsOf(guildId, settings);
    return createEmbed({
        title: tr.t('automod.cmd.status.title'),
        description: statusDescription(guildId, settings, lockdown, exempt, { lang: tr.lang }),
        color: settings.enabled ? 'primary' : 'secondary',
    });
}

const POLICY_TEXT = {
    ignore: (tr) => tr.t('automod.cmd.policy.ignore'),
    log: (tr) => tr.t('automod.cmd.policy.log'),
    warn: (tr) => tr.t('automod.cmd.policy.warn'),
};

/** One native rule's line: name, trigger, policy, dedupe, and a note on native timeouts. */
function nativeRuleLine(rule, policies, tr) {
    const { policy, dedupeMinutes } = policyFor(policies, rule.id);
    const stored = policies.has(rule.id) ? '' : tr.t('automod.cmd.native.default');
    const blocks = rule.actions.some((action) => action.type === AutoModerationActionType.BlockMessage);
    const timeout = rule.actions.some((action) => action.type === AutoModerationActionType.Timeout);
    const notes = [
        rule.enabled ? null : tr.t('automod.cmd.native.disabled'),
        blocks ? null : tr.t('automod.cmd.native.noBlock'),
        timeout ? tr.t('automod.cmd.native.timeout') : null,
    ].filter(Boolean);
    return `**${rule.name}** · ${triggerLabel(rule.triggerType)} · \`${rule.id}\`\n`
        + `${tr.t('automod.cmd.native.policyLine', { policy: POLICY_TEXT[policy] ? POLICY_TEXT[policy](tr) : policy, stored, minutes: dedupeMinutes })}${notes.length ? `\n-# ${notes.join(' · ')}` : ''}`;
}

async function handleNative(interaction, sub, tr) {
    const guild = interaction.guild;
    if (sub === 'list') {
        const [rules, policies] = await Promise.all([
            guild.autoModerationRules.fetch(),
            loadNativePolicies(guild.id),
        ]);
        const lines = [...rules.values()].map((rule) => nativeRuleLine(rule, policies, tr));
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: tr.t('automod.cmd.native.listTitle', { count: rules.size }),
                description: (lines.join('\n\n') || tr.t('automod.cmd.native.none')).slice(0, 4000),
                footer: { text: tr.t('automod.cmd.native.footer') },
                color: 'primary',
            })],
        });
    }
    const ruleId = interaction.options.getString('rule');
    const policy = interaction.options.getString('policy');
    const dedupeMinutes = interaction.options.getInteger('dedupe_minutes');
    if (!/^\d{17,20}$/.test(ruleId || '')) throw userError(tr.t('automod.cmd.native.pick'));
    const rule = await guild.autoModerationRules.fetch(ruleId).catch(() => null);
    if (!rule) throw userError(tr.t('automod.cmd.native.gone'));
    await setNativePolicy(guild.id, ruleId, policy, dedupeMinutes, interaction.user.id);
    const policies = await loadNativePolicies(guild.id);
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(tr.t('automod.cmd.native.updated'), nativeRuleLine(rule, policies, tr))],
    });
}


// Autocomplete runs on every keystroke and must answer within 3 s: the server's AutoMod rules
// (a REST fetch) are reused for AUTOCOMPLETE_RULES_TTL_MS instead of being fetched each time.
const AUTOCOMPLETE_RULES_TTL_MS = 30 * 1000;
const autocompleteRuleCache = new BoundedMap(500);

async function autocompleteRules(guild) {
    const hit = autocompleteRuleCache.get(guild.id);
    if (hit && Date.now() - hit.at < AUTOCOMPLETE_RULES_TTL_MS) return hit.rules;
    const rules = await guild.autoModerationRules.fetch().catch(() => null);
    if (rules) autocompleteRuleCache.set(guild.id, { at: Date.now(), rules });
    return rules;
}

export default {
    data: new SlashCommandBuilder()
        .setName('automod')
        .setDescription('Automatic moderation: status, modes per rule and channel, review queue, raid lockdown')
        .setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.description'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Show the automod settings and punishments').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.status')))
        .addSubcommand((sub) => sub.setName('enable').setDescription('Turn automod on or off').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.enable'))
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.onOff')).setRequired(true)))
        .addSubcommand((sub) => sub.setName('mode').setDescription("Global mode: enforce (act automatically) or report only (don't delete): review cards only").setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.mode'))
            .addStringOption((option) => option.setName('mode').setDescription('Mode').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.modeOption')).setRequired(true)
                .addChoices(
                    { name: 'enforce', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceEnforce'), value: 'enforce' },
                    { name: "report only (don't delete)", name_localizations: descriptionLocalizations('automod.cmd.slash.choiceMonitor'), value: 'monitor' },
                )))
        .addSubcommand((sub) => sub.setName('rule').setDescription("Set one rule to on, report only (don't delete) or off (default: follow the global mode)").setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.rule'))
            .addStringOption((option) => option.setName('rule').setDescription('Rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.ruleOption')).setRequired(true).addChoices(...RULE_CHOICES))
            .addStringOption((option) => option.setName('mode').setDescription('Mode for this rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.ruleModeOption')).setRequired(true)
                .addChoices(
                    { name: 'on (act and post a card)', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceRuleOn'), value: 'on' },
                    { name: "report only (don't delete): review card only", name_localizations: descriptionLocalizations('automod.cmd.slash.choiceRuleMonitor'), value: 'monitor' },
                    { name: 'off (ignore this rule)', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceRuleOff'), value: 'off' },
                    { name: 'default (follow the global mode)', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceRuleDefault'), value: 'default' },
                )))
        .addSubcommand((sub) => sub.setName('channel').setDescription("Set one rule to off or report only (don't delete) in one channel or category").setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.channel'))
            .addChannelOption((option) => option.setName('channel').setDescription('Channel or category').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.channelOption')).setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory, ChannelType.GuildVoice))
            .addStringOption((option) => option.setName('rule').setDescription('Rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.ruleOption')).setRequired(true).addChoices(...RULE_CHOICES))
            .addStringOption((option) => option.setName('mode').setDescription('Mode in this channel').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.channelModeOption')).setRequired(true)
                .addChoices(
                    { name: 'off (ignore this rule here)', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceChannelOff'), value: 'off' },
                    { name: "report only (don't delete): review card only here", name_localizations: descriptionLocalizations('automod.cmd.slash.choiceChannelMonitor'), value: 'monitor' },
                    { name: 'default (remove the exception)', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceChannelDefault'), value: 'default' },
                )))
        .addSubcommand((sub) => sub.setName('trusted').setDescription('Members with this role or level skip the low-severity rules (caps, characters, English only)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.trusted'))
            .addRoleOption((option) => option.setName('role').setDescription('Trusted role').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.trustedRole')))
            .addIntegerOption((option) => option.setName('min_level').setDescription('Or at least this leveling level (0 = no level criterion)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.trustedLevel')).setMinValue(0).setMaxValue(1000))
            .addBooleanOption((option) => option.setName('clear').setDescription('Remove the trusted role and level').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.trustedClear'))))
        .addSubcommand((sub) => sub.setName('friendlynotice').setDescription('Friendly notice for a first small offence in 30 days, instead of a warning').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.friendly'))
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.onOff')).setRequired(true)))
        .addSubcommand((sub) => sub.setName('mood').setDescription('Calm-down note and brief slowmode when a channel heats up').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.mood'))
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.onOff')).setRequired(true)))
        .addSubcommand((sub) => sub.setName('extrawatch').setDescription('Show or end a member\'s extra-watch period after a ban (they rejoined)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.extrawatch'))
            .addUserOption((option) => option.setName('user').setDescription('Member').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.member')).setRequired(true))
            .addBooleanOption((option) => option.setName('end').setDescription('End the extra-watch period now').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.extrawatchEnd'))))
        .addSubcommand((sub) => sub.setName('exempt').setDescription('Add or remove a channel automod ignores completely (all rules)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.exempt'))
            .addChannelOption((option) => option.setName('channel').setDescription('Channel or category').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.channelOption')).setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory)))
        .addSubcommand((sub) => sub.setName('stats').setDescription('Automod actions, undos and top offenders').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.stats'))
            .addIntegerOption((option) => option.setName('days').setDescription('How far back (default 7)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.statsDays')).setMinValue(1).setMaxValue(90)))
        .addSubcommand((sub) => sub.setName('queue').setDescription('Review cards still waiting for a decision, newest first').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.queue')))
        .addSubcommand((sub) => sub.setName('joingate').setDescription('Checks on new members: flag them for staff or kick them (with a DM)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.joingate'))
            .addStringOption((option) => option.setName('check').setDescription('Which check').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.gateCheck')).setRequired(true)
                .addChoices(...Object.entries(JOIN_GATE_CHECKS).map(([value, { label }]) => ({ name: label, name_localizations: GATE_CHECK_CHOICE_LOCALIZATIONS[value], value }))))
            .addStringOption((option) => option.setName('action').setDescription('What to do when it hits').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.gateAction')).setRequired(true)
                .addChoices(
                    { name: 'off', name_localizations: descriptionLocalizations('automod.joinGate.action.off'), value: 'off' },
                    { name: 'flag (a line in the review channel)', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceGateFlag'), value: 'flag' },
                    { name: 'kick (with a DM saying how to come back)', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceGateKick'), value: 'kick' },
                ))
            .addIntegerOption((option) => option.setName('days').setDescription(`New account check: younger than this many days (default ${DEFAULT_GATE_DAYS})`).setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.gateDays', { days: DEFAULT_GATE_DAYS })).setMinValue(1).setMaxValue(365)))
        .addSubcommand((sub) => sub.setName('panic').setDescription('Raid panic mode: a lockdown also pauses invites and DMs (Discord incident actions)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.panic'))
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.onOff')).setRequired(true))
            .addIntegerOption((option) => option.setName('hours').setDescription('How long the pause lasts (default 2, max 24)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.panicHours')).setMinValue(1).setMaxValue(24)))
        .addSubcommand((sub) => sub.setName('invites').setDescription("Invites automod allows besides this server's own (codes, invite links or server ids)").setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.invites'))
            .addStringOption((option) => option.setName('action').setDescription('What to do').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.invitesAction')).setRequired(true)
                .addChoices(
                    { name: 'list', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceList'), value: 'list' },
                    { name: 'add', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceAdd'), value: 'add' },
                    { name: 'remove', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceRemove'), value: 'remove' },
                    { name: 'clear', name_localizations: descriptionLocalizations('automod.cmd.slash.choiceClear'), value: 'clear' },
                ))
            .addStringOption((option) => option.setName('invite').setDescription('Invite link, invite code or server id').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.invite')).setMaxLength(100)))
        .addSubcommand((sub) => sub.setName('staffguard').setDescription('Anti-nuke: staff who mass-ban, mass-delete channels or roles, or add bots lose their staff roles').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.staffguard'))
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.onOff')).setRequired(true)))
        .addSubcommand((sub) => sub.setName('lockdown-end').setDescription('End a join-raid lockdown: restore the verification level, resume invites and DMs').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.lockdownEnd')))
        .addSubcommandGroup((group) => group.setName('native').setDescription('Discord\'s own AutoMod rules: what the bot does when one blocks a message').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.native'))
            .addSubcommand((sub) => sub.setName('list').setDescription('List the server\'s native AutoMod rules and their policy').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.nativeList')))
            .addSubcommand((sub) => sub.setName('set').setDescription('Ignore, log or warn when a native AutoMod rule blocks a message').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.nativeSet'))
                .addStringOption((option) => option.setName('rule').setDescription('Native AutoMod rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.nativeRule')).setRequired(true).setAutocomplete(true))
                .addStringOption((option) => option.setName('policy').setDescription('What the bot does').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.nativePolicy')).setRequired(true)
                    .addChoices(
                        { name: 'ignore', name_localizations: descriptionLocalizations('automod.cmd.policy.ignore'), value: 'ignore' },
                        { name: 'log (a line in the review channel)', name_localizations: descriptionLocalizations('automod.cmd.policy.log'), value: 'log' },
                        { name: 'warn (a warning and a review card)', name_localizations: descriptionLocalizations('automod.cmd.policy.warn'), value: 'warn' },
                    ))
                .addIntegerOption((option) => option.setName('dedupe_minutes').setDescription('At most one action per member and rule in this many minutes (default 10)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.nativeDedupe'))
                    .setMinValue(0).setMaxValue(1440))))
        .addSubcommandGroup((group) => group.setName('custom').setDescription('Your own word filters (paid plans)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.custom'))
            .addSubcommand((sub) => sub.setName('list').setDescription('List the custom rules').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customList')))
            .addSubcommand((sub) => sub.setName('add').setDescription('Add a custom rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customAdd'))
                .addStringOption((option) => option.setName('name').setDescription('Short name').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customName')).setRequired(true).setMaxLength(40))
                .addStringOption((option) => option.setName('words').setDescription('Words, comma separated').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customWords')).setRequired(true).setMaxLength(3000))
                .addStringOption((option) => option.setName('action').setDescription('What happens').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customAction')).setRequired(true).addChoices(...CUSTOM_ACTION_CHOICES))
                .addStringOption((option) => option.setName('mute_for').setDescription('Mute time, like 1h').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customMuteFor')).setMaxLength(10)))
            .addSubcommand((sub) => sub.setName('edit').setDescription('Change a rule\'s words or action').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customEdit'))
                .addStringOption((option) => option.setName('name').setDescription('The rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customRule')).setRequired(true).setAutocomplete(true))
                .addStringOption((option) => option.setName('words').setDescription('New words, comma separated (replaces)').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customNewWords')).setMaxLength(3000))
                .addStringOption((option) => option.setName('action').setDescription('New action').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customNewAction')).addChoices(...CUSTOM_ACTION_CHOICES))
                .addStringOption((option) => option.setName('mute_for').setDescription('Mute time, like 1h').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customMuteFor')).setMaxLength(10)))
            .addSubcommand((sub) => sub.setName('toggle').setDescription('Turn a rule on or off').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customToggle'))
                .addStringOption((option) => option.setName('name').setDescription('The rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customRule')).setRequired(true).setAutocomplete(true))
                .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.onOff')).setRequired(true)))
            .addSubcommand((sub) => sub.setName('remove').setDescription('Remove a rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customRemove'))
                .addStringOption((option) => option.setName('name').setDescription('The rule').setDescriptionLocalizations(descriptionLocalizations('automod.cmd.slash.customRule')).setRequired(true).setAutocomplete(true)))),

    async autocomplete(interaction) {
        // Any server (multi-server B1): each server reads and changes only its own rules.
        if (!interaction.guildId || !isAdministrator(interaction.member)) return interaction.respond([]);
        const focused = String(interaction.options.getFocused() || '').toLowerCase();
        if (interaction.options.getSubcommandGroup(false) === 'custom') {
            const { lang } = textForInteraction(interaction);
            return interaction.respond(customRuleChoices(storedCustomRules(interaction.guildId), focused, { lang })).catch(() => {});
        }
        const rules = await autocompleteRules(interaction.guild);
        const choices = [...(rules?.values() || [])]
            .filter((rule) => !focused || rule.name.toLowerCase().includes(focused) || rule.id.includes(focused))
            .slice(0, 25)
            .map((rule) => ({ name: `${rule.name} (${triggerLabel(rule.triggerType)})`.slice(0, 100), value: rule.id }));
        return interaction.respond(choices).catch(() => {});
    },

    async execute(interaction) {
        // Every server (multi-server B1): settings, state and posts are this server's own. Automod
        // is off by default outside the main server until /automod enable turns it on.
        const tr = textForInteraction(interaction);
        if (!interaction.guildId) {
            throw new TitanBotError('/automod outside a server', ErrorTypes.PERMISSION, tr.t('automod.cmd.serverOnly'), { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION, tr.t('automod.cmd.noAdmin'), { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const guildId = interaction.guildId;
        const sub = interaction.options.getSubcommand();
        let note = null;

        if (sub === 'stats') {
            const stats = await automodStats(guildId, interaction.options.getInteger('days') || 7);
            // formatAutomodStats (automodReport.js) is English.
            const text = formatAutomodStats(stats);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: tr.t('automod.cmd.stats.title', { days: stats.days, total: stats.total }),
                    fields: [
                        { name: tr.t('automod.cmd.stats.perRule'), value: text.rules.slice(0, 1024) },
                        { name: tr.t('automod.cmd.stats.offenders'), value: text.offenders.slice(0, 1024) },
                    ],
                    footer: { text: text.footer },
                    color: 'primary',
                })],
            });
        }

        if (sub === 'queue') {
            const items = await collectOpenReviews(interaction.client, interaction.guildId, { lang: tr.lang });
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: tr.t('automod.cmd.queue.title', { count: items.length }),
                    description: formatQueue(items, { lang: tr.lang }),
                    footer: { text: tr.t('automod.cmd.queue.footer') },
                    color: items.length ? 'warning' : 'success',
                })],
            });
        }

        if (interaction.options.getSubcommandGroup(false) === 'native') {
            return handleNative(interaction, sub, tr);
        }
        if (interaction.options.getSubcommandGroup(false) === 'custom') {
            return handleCustom(interaction, sub, tr);
        }

        if (sub === 'extrawatch') {
            const user = interaction.options.getUser('user');
            const end = interaction.options.getBoolean('end');
            const record = end ? await endProbation(guildId, user.id) : await getProbation(guildId, user.id);
            const until = record ? `<t:${Math.floor(Number(record.until) / 1000)}:F>` : null;
            let text;
            if (end) text = record ? tr.t('automod.cmd.extrawatch.endedEarly', { userId: user.id, until }) : tr.t('automod.cmd.extrawatch.wasNot', { userId: user.id });
            else if (record) {
                const ban = record.caseCode ? tr.t('automod.cmd.extrawatch.ban', { code: record.caseCode, how: record.how || tr.t('automod.cmd.extrawatch.ended') }) : '';
                text = tr.t('automod.cmd.extrawatch.active', { userId: user.id, until, ban });
            } else text = tr.t('automod.cmd.extrawatch.isNot', { userId: user.id });
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [end && record
                    ? successEmbed(tr.t('automod.cmd.extrawatch.endedTitle'), text)
                    : createEmbed({ title: tr.t('automod.cmd.extrawatch.title'), description: text, color: record ? 'warning' : 'primary' })],
            });
        }

        if (sub === 'enable') {
            const enabled = interaction.options.getBoolean('enabled');
            // Turning automod off also stops the staff guard, so it is owner-only while the guard is on.
            if (!enabled && !isLegacyAutomodGuild(guildId) && interaction.user.id !== interaction.guild.ownerId) {
                const current = await getAutomodSettings(guildId);
                if (current.staffGuard) throw userError(tr.t('automod.cmd.staffGuardOwnerOnly'));
            }
            // Review cards need somewhere to go (review channel, else the mod log): refuse to turn on without one.
            if (enabled && !resolveChannelId(guildId, 'review')) throw userError(tr.t('automod.cmd.needReviewChannel'));
            const saved = await setAutomodEnabled(guildId, enabled);
            note = tr.t('automod.cmd.note.enabled', { state: onOff(enabled, tr) });
            // First time on in another server: Report only (automodSettings.setAutomodEnabled).
            if (saved?.startedInMonitor) note = `${note}\n${tr.t('automod.cmd.note.startedMonitor')}`;
        } else if (sub === 'mode') {
            const mode = interaction.options.getString('mode');
            await setAutomodMode(guildId, mode);
            note = mode === 'monitor' ? tr.t('automod.cmd.note.modeMonitor') : tr.t('automod.cmd.note.modeEnforce');
        } else if (sub === 'rule') {
            const rule = interaction.options.getString('rule');
            const mode = interaction.options.getString('mode');
            await setRuleMode(guildId, rule, mode);
            const label = ruleLabel(rule, tr);
            if (mode === 'default') note = tr.t('automod.cmd.note.ruleDefault', { label });
            else if (mode === 'monitor') note = tr.t('automod.cmd.note.ruleMonitor', { label, mode: modeLabel(mode, tr) });
            else if (mode === 'off') note = tr.t('automod.cmd.note.ruleOff', { label, mode: modeLabel(mode, tr) });
            else note = tr.t('automod.cmd.note.ruleSet', { label, mode: modeLabel(mode, tr) });
        } else if (sub === 'channel') {
            const channel = interaction.options.getChannel('channel');
            const rule = interaction.options.getString('rule');
            const mode = interaction.options.getString('mode');
            await setChannelRuleMode(guildId, channel.id, rule, mode);
            const label = ruleLabel(rule, tr);
            if (mode === 'default') note = tr.t('automod.cmd.note.channelDefault', { label, channelId: channel.id });
            else if (channel.type === ChannelType.GuildCategory) note = tr.t('automod.cmd.note.categorySet', { label, mode: modeLabel(mode, tr), channelId: channel.id });
            else note = tr.t('automod.cmd.note.channelSet', { label, mode: modeLabel(mode, tr), channelId: channel.id });
        } else if (sub === 'trusted') {
            const role = interaction.options.getRole('role');
            const minLevel = interaction.options.getInteger('min_level');
            const clear = interaction.options.getBoolean('clear');
            if (!clear && !role && minLevel === null) throw userError(tr.t('automod.cmd.trusted.giveOne'));
            // getTrustedRoleProblem (automodSettings.js) answers in English.
            const roleProblem = role ? getTrustedRoleProblem(interaction.guild, role) : null;
            if (roleProblem) throw userError(roleProblem);
            const saved = await setTrusted(guildId, {
                roleId: role ? role.id : undefined,
                minLevel: minLevel ?? undefined,
                clear: Boolean(clear),
            });
            note = clear || (!saved.trusted.roleId && !saved.trusted.minLevel)
                ? tr.t('automod.cmd.trusted.none')
                : tr.t('automod.cmd.trusted.set', { who: trustedText(saved.trusted, tr), rules: relaxedRuleLabels(tr) });
        } else if (sub === 'friendlynotice') {
            const enabled = interaction.options.getBoolean('enabled');
            await setSecondChance(guildId, enabled);
            note = enabled ? tr.t('automod.cmd.note.friendlyOn') : tr.t('automod.cmd.note.friendlyOff');
        } else if (sub === 'invites') {
            const action = interaction.options.getString('action');
            const saved = action === 'list'
                ? await getAutomodSettings(guildId)
                : await setInviteAllowlist(guildId, action, interaction.options.getString('invite'));
            note = tr.t('automod.cmd.invites.note', { list: inviteAllowlistText(saved.inviteAllowlist, 300, { lang: tr.lang }) });
        } else if (sub === 'mood') {
            const enabled = interaction.options.getBoolean('enabled');
            await setMoodAlerts(guildId, enabled);
            note = enabled ? tr.t('automod.cmd.note.moodOn') : tr.t('automod.cmd.note.moodOff');
        } else if (sub === 'joingate') {
            const check = interaction.options.getString('check');
            const action = interaction.options.getString('action');
            const days = interaction.options.getInteger('days');
            const saved = await setJoinGateCheck(guildId, check, action, days);
            const gate = normalizeJoinGate(saved.joinGate);
            const ageNote = check === 'age' && action !== 'off'
                ? `\n${tr.t('automod.cmd.joingate.ageNote', { days: gate.ageDays, defaultDays: DEFAULT_GATE_DAYS })}`
                : '';
            note = tr.t('automod.cmd.joingate.note', {
                check: joinGateCheckText(check, { lang: tr.lang }).label,
                action: joinGateActionText(action, { lang: tr.lang }),
                age: ageNote,
                gate: describeJoinGate(gate, { lang: tr.lang }),
            });
        } else if (sub === 'panic') {
            const enabled = interaction.options.getBoolean('enabled');
            const hours = interaction.options.getInteger('hours');
            const saved = await setPanic(guildId, { enabled, hours });
            const canPause = interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild);
            note = enabled
                ? `${tr.t('automod.cmd.note.panicOn', { hours: saved.panic.hours })}${canPause ? '' : `\n${tr.t('automod.cmd.note.panicNoPerm')}`}`
                : tr.t('automod.cmd.note.panicOff');
        } else if (sub === 'staffguard') {
            const enabled = interaction.options.getBoolean('enabled');
            if (isLegacyAutomodGuild(guildId)) throw userError(tr.t('automod.cmd.note.guardAlways'));
            // A rogue admin must not be able to switch off the guard that limits them (anti-nuke).
            if (!enabled && interaction.user.id !== interaction.guild.ownerId) throw userError(tr.t('automod.cmd.staffGuardOwnerOnly'));
            const before = await getAutomodSettings(guildId);
            const saved = await setStaffGuard(guildId, enabled);
            // A first structure snapshot when the guard goes from off to on and none is from the
            // last 24 h, so "Show what changed" / "Revert…" work before the daily job reaches it.
            snapshotOnGuardEnabled(interaction.guild, before, saved)?.catch(() => {});
            const me = interaction.guild.members.me;
            const canAct = me?.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog]);
            note = enabled
                ? `${tr.t('automod.cmd.note.guardOn', { notYet: saved.enabled ? '' : tr.t('automod.cmd.note.guardNotYet') })}${canAct ? '' : `\n${tr.t('automod.cmd.note.guardNoPerm')}`}`
                : tr.t('automod.cmd.note.guardOff');
        } else if (sub === 'exempt') {
            const channel = interaction.options.getChannel('channel');
            const { exempt: adding } = await setExemptChannel(guildId, channel.id, 'toggle');
            note = adding ? tr.t('automod.cmd.note.exemptOn', { channelId: channel.id }) : tr.t('automod.cmd.note.exemptOff', { channelId: channel.id });
        } else if (sub === 'lockdown-end') {
            const ended = await endLockdown(interaction.guild, interaction.user);
            if (!ended) throw userError(tr.t('automod.cmd.note.noLockdown'));
            note = tr.t('automod.cmd.note.lockdownEnded');
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: note ? [successEmbed(tr.t('automod.cmd.updated'), note), await statusEmbed(guildId, tr)] : [await statusEmbed(guildId, tr)],
        });
    },
};

async function handleCustom(interaction, sub, tr) {
    const guildId = interaction.guildId;
    const planId = guildPlan(guildId);
    const plan = planId === 'free' ? 'Free' : planName(planId);
    const limit = limitForPlan(planId);
    const list = storedCustomRules(guildId);
    const opt = (name) => interaction.options.getString(name);

    if (sub === 'list') {
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({ title: tr.t('automod.cmd.custom.title'), description: customRulesText(list, limit, plan, { lang: tr.lang }), color: 'primary' })],
            allowedMentions: { parse: [] },
        });
    }

    let result;
    try {
        if (sub === 'add') {
            const next = addRule(list, { name: opt('name'), words: opt('words'), action: opt('action'), muteDuration: opt('mute_for') }, { limit, planName: plan });
            const added = next[next.length - 1];
            result = { list: next, note: tr.t('automod.cmd.custom.added', { name: added.name, action: customActionLabel(added, tr) }) };
        } else if (sub === 'edit') {
            if (!opt('words') && !opt('action') && !opt('mute_for')) throw userError(tr.t('automod.cmd.custom.giveChange'));
            const { list: next, rule } = editRule(list, opt('name'), { words: opt('words'), action: opt('action'), muteDuration: opt('mute_for') });
            result = { list: next, note: tr.tp('automod.cmd.custom.changed', rule.words.length, { name: rule.name, action: customActionLabel(rule, tr) }) };
        } else if (sub === 'toggle') {
            const enabled = interaction.options.getBoolean('enabled');
            const { list: next, rule, changed } = toggleRule(list, opt('name'), enabled);
            const params = { name: rule.name, state: onOff(enabled, tr) };
            result = { list: changed ? next : null, note: changed ? tr.t('automod.cmd.custom.toggled', params) : tr.t('automod.cmd.custom.toggledAlready', params) };
        } else if (sub === 'remove') {
            const { list: next, rule } = removeRule(list, opt('name'));
            result = { list: next, note: tr.t('automod.cmd.custom.removed', { name: rule.name }) };
        }
    } catch (error) {
        // CustomRuleError texts (customRuleEdits.js) are English.
        if (error?.name === 'CustomRuleError' || error?.userMessage) throw userError(error.userMessage || error.message);
        throw error;
    }
    if (!result) throw userError(tr.t('automod.cmd.custom.unknown'));
    if (result.list) {
        await updateSettings(guildId, { automodCustomRules: result.list }, { userId: interaction.user.id, username: interaction.user.username, module: 'automod' });
        resetCustomRulesCache();
    }
    const fresh = result.list || list;
    const over = overLimitIds(fresh, limit).length;
    const extra = over ? `\n${tr.tp('automod.cmd.custom.overLimit', over, { plan, limit })}` : '';
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(tr.t('automod.cmd.updated'), `${result.note}${extra}`)],
        allowedMentions: { parse: [] },
    });
}
