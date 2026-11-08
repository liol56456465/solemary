import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { userError } from '../../services/community/db.js';
import {
    createTag, deleteTag, editTag, listTags, useTag, TAG_CONTENT_MAX,
} from '../../services/community/tagService.js';
import { parseChannelList, REGEX_TRIGGER_MAX } from '../../services/community/tagMatcher.js';
import { textForInteraction } from '../../utils/botText.js';
import { describe } from '../../utils/commandLocalizations.js';

function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const nameOption = (option) => describe(option.setName('name'), 'community.cmd.tag.name').setRequired(true).setAutocomplete(true).setMaxLength(32);
const triggerOptions = (sub, { kindChoices }) => sub
    // Choice names stay as typed (none / word / regex): replies and errors name them the same way.
    .addStringOption((option) => describe(option.setName('trigger_kind'), 'community.cmd.tag.triggerKind')
        .addChoices(...kindChoices.map((kind) => ({ name: kind, value: kind }))))
    .addStringOption((option) => describe(option.setName('trigger'), 'community.cmd.tag.trigger').setMaxLength(REGEX_TRIGGER_MAX))
    .addStringOption((option) => describe(option.setName('allow_channels'), 'community.cmd.tag.allowChannels').setMaxLength(1000))
    .addStringOption((option) => describe(option.setName('deny_channels'), 'community.cmd.tag.denyChannels').setMaxLength(1000))
    .addIntegerOption((option) => describe(option.setName('cooldown'), 'community.cmd.tag.cooldown').setMinValue(0).setMaxValue(86400));

function describeTag(tag, tr) {
    const lines = [tr.t('community.tag.uses', { uses: tag.uses }), tr.t('community.tag.createdBy', { userId: tag.createdBy })];
    if (tag.triggerKind !== 'none') {
        lines.push(tr.t('community.tag.trigger', { kind: tag.triggerKind, trigger: truncate(tag.trigger, 100), disabled: tag.pattern ? '' : tr.t('community.tag.disabled') }));
        lines.push(tr.t('community.tag.cooldown', { seconds: tag.cooldownS }));
        if (tag.allowChannels.length) lines.push(tr.t('community.tag.onlyIn', { channels: tag.allowChannels.map((id) => `<#${id}>`).join(' ') }));
        if (tag.denyChannels.length) lines.push(tr.t('community.tag.neverIn', { channels: tag.denyChannels.map((id) => `<#${id}>`).join(' ') }));
    }
    return lines.join('\n');
}

function readChannels(interaction, name, tr) {
    const raw = interaction.options.getString(name);
    if (raw == null) return undefined;
    const ids = parseChannelList(raw);
    if (!ids.length && !/^\s*(none|-)\s*$/i.test(raw)) throw userError(tr.t('community.tag.channelsUnreadable', { option: name }));
    return ids;
}

export default {
    // show/list: everyone (commandAccess.js). create/edit/delete: admin-only.
    slashOnly: true,
    category: 'Community',
    data: describe(new SlashCommandBuilder()
        .setName('tag'), 'community.cmd.tag.desc')
        .addSubcommand((sub) => describe(sub.setName('show'), 'community.cmd.tag.show').addStringOption(nameOption)
            .addUserOption((option) => describe(option.setName('for'), 'community.cmd.tag.for')))
        .addSubcommand((sub) => describe(sub.setName('list'), 'community.cmd.tag.list'))
        .addSubcommand((sub) => triggerOptions(describe(sub.setName('create'), 'community.cmd.tag.create')
            .addStringOption((option) => describe(option.setName('name'), 'community.cmd.tag.newName').setRequired(true).setMaxLength(32))
            .addStringOption((option) => describe(option.setName('content'), 'community.cmd.tag.content').setRequired(true).setMaxLength(TAG_CONTENT_MAX)),
        { kindChoices: ['word', 'regex'] }))
        .addSubcommand((sub) => triggerOptions(describe(sub.setName('edit'), 'community.cmd.tag.edit')
            .addStringOption(nameOption)
            .addStringOption((option) => describe(option.setName('content'), 'community.cmd.tag.newContent').setMaxLength(TAG_CONTENT_MAX)),
        { kindChoices: ['none', 'word', 'regex'] }))
        .addSubcommand((sub) => describe(sub.setName('delete'), 'community.cmd.tag.delete').addStringOption(nameOption))
        .setDMPermission(false),

    async autocomplete(interaction) {
        const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
        await interaction.respond(listTags(interaction.guildId).filter((tag) => tag.name.includes(typed)).slice(0, 25)
            .map((tag) => ({ name: tag.name, value: tag.name })));
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const name = interaction.options.getString('name')?.trim().toLowerCase();
        const tr = textForInteraction(interaction);

        if (sub === 'show') {
            const tag = useTag(interaction.guildId, name);
            if (!tag) throw userError(tr.t('community.tag.notFound', { name }));
            const target = interaction.options.getUser('for');
            return InteractionHelper.safeReply(interaction, {
                content: target ? `${target}\n${tag.content}`.slice(0, 2000) : tag.content,
                allowedMentions: { parse: [], users: target ? [target.id] : [] },
            });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (sub === 'list') {
            const tags = listTags(interaction.guildId);
            const lines = tags.map((tag) => tr.t('community.tag.listLine', {
                name: tag.name, auto: tag.triggerKind !== 'none' ? tr.t('community.tag.auto', { kind: tag.triggerKind }) : '', uses: tag.uses,
            }));
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: tr.t('community.tag.listTitle', { count: tags.length }),
                    description: truncate(lines.join('\n') || tr.t('community.tag.listEmpty'), 4096),
                    color: 'primary',
                })],
            });
        }

        if (sub === 'delete') {
            const removed = await deleteTag(interaction.guildId, name);
            return InteractionHelper.safeEditReply(interaction, { content: removed ? tr.t('community.tag.deleted', { name }) : tr.t('community.tag.missing', { name }) });
        }

        const fields = {
            guildId: interaction.guildId,
            name,
            content: interaction.options.getString('content') ?? undefined,
            triggerKind: interaction.options.getString('trigger_kind') ?? undefined,
            trigger: interaction.options.getString('trigger') ?? undefined,
            allowChannels: readChannels(interaction, 'allow_channels', tr),
            denyChannels: readChannels(interaction, 'deny_channels', tr),
            cooldownS: interaction.options.getInteger('cooldown') ?? undefined,
            lang: tr.lang,
        };

        if (sub === 'create') {
            if (fields.trigger && !fields.triggerKind) fields.triggerKind = 'word';
            if (fields.triggerKind && !fields.trigger) throw userError(tr.t('community.tag.needTrigger'));
            const tag = await createTag({
                ...fields,
                triggerKind: fields.triggerKind ?? 'none',
                allowChannels: fields.allowChannels ?? [],
                denyChannels: fields.denyChannels ?? [],
                cooldownS: fields.cooldownS ?? null,
                createdBy: interaction.user.id,
            });
            return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(tr.t('community.tag.createdTitle', { name: tag.name }), describeTag(tag, tr))] });
        }

        if (sub === 'edit') {
            const tag = await editTag(fields);
            if (!tag) throw userError(tr.t('community.tag.missing', { name }));
            return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(tr.t('community.tag.updatedTitle', { name: tag.name }), describeTag(tag, tr))] });
        }
    },
};
