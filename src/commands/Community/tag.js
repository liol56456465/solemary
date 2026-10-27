import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { userError } from '../../services/community/db.js';
import {
    createTag, deleteTag, editTag, listTags, useTag, TAG_CONTENT_MAX,
} from '../../services/community/tagService.js';
import { parseChannelList, REGEX_TRIGGER_MAX } from '../../services/community/tagMatcher.js';

function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const nameOption = (option) => option.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true).setMaxLength(32);
const triggerOptions = (sub, { kindChoices }) => sub
    .addStringOption((option) => option.setName('trigger_kind').setDescription('Post this tag automatically when a message matches')
        .addChoices(...kindChoices.map((kind) => ({ name: kind, value: kind }))))
    .addStringOption((option) => option.setName('trigger').setDescription('Word/phrase, or regex (case-insensitive)').setMaxLength(REGEX_TRIGGER_MAX))
    .addStringOption((option) => option.setName('allow_channels').setDescription('Only trigger in these channels (#mentions; "none" clears)').setMaxLength(1000))
    .addStringOption((option) => option.setName('deny_channels').setDescription('Never trigger in these channels (#mentions; "none" clears)').setMaxLength(1000))
    .addIntegerOption((option) => option.setName('cooldown').setDescription('Seconds between auto-posts per channel (default 60)').setMinValue(0).setMaxValue(86400));

function describeTag(tag) {
    const lines = [`**Uses:** ${tag.uses}`, `**Created by:** <@${tag.createdBy}>`];
    if (tag.triggerKind !== 'none') {
        lines.push(`**Trigger:** ${tag.triggerKind} \`${truncate(tag.trigger, 100)}\`${tag.pattern ? '' : ' (disabled)'}`);
        lines.push(`**Cooldown:** ${tag.cooldownS}s per channel`);
        if (tag.allowChannels.length) lines.push(`**Only in:** ${tag.allowChannels.map((id) => `<#${id}>`).join(' ')}`);
        if (tag.denyChannels.length) lines.push(`**Never in:** ${tag.denyChannels.map((id) => `<#${id}>`).join(' ')}`);
    }
    return lines.join('\n');
}

function readChannels(interaction, name) {
    const raw = interaction.options.getString(name);
    if (raw == null) return undefined;
    const ids = parseChannelList(raw);
    if (!ids.length && !/^\s*(none|-)\s*$/i.test(raw)) throw userError(`Could not read any channels from ${name}; mention them like #general, or write "none".`);
    return ids;
}

export default {
    // show/list: everyone (commandAccess.js). create/edit/delete: admin-only.
    scope: 'main',
    slashOnly: true,
    category: 'Community',
    data: new SlashCommandBuilder()
        .setName('tag')
        .setDescription('Saved answers anyone can post, optionally sent automatically on a keyword')
        .addSubcommand((sub) => sub.setName('show').setDescription('Post a tag in this channel').addStringOption(nameOption)
            .addUserOption((option) => option.setName('for').setDescription('Mention a member with it')))
        .addSubcommand((sub) => sub.setName('list').setDescription('List the tags'))
        .addSubcommand((sub) => triggerOptions(sub.setName('create').setDescription('Create a tag')
            .addStringOption((option) => option.setName('name').setDescription('Short name: lowercase letters, digits, - and _').setRequired(true).setMaxLength(32))
            .addStringOption((option) => option.setName('content').setDescription('The text').setRequired(true).setMaxLength(TAG_CONTENT_MAX)),
        { kindChoices: ['word', 'regex'] }))
        .addSubcommand((sub) => triggerOptions(sub.setName('edit').setDescription('Change a tag (only the options you give)')
            .addStringOption(nameOption)
            .addStringOption((option) => option.setName('content').setDescription('New text').setMaxLength(TAG_CONTENT_MAX)),
        { kindChoices: ['none', 'word', 'regex'] }))
        .addSubcommand((sub) => sub.setName('delete').setDescription('Delete a tag').addStringOption(nameOption))
        .setDMPermission(false),

    async autocomplete(interaction) {
        const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
        await interaction.respond(listTags(interaction.guildId).filter((tag) => tag.name.includes(typed)).slice(0, 25)
            .map((tag) => ({ name: tag.name, value: tag.name })));
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const name = interaction.options.getString('name')?.trim().toLowerCase();

        if (sub === 'show') {
            const tag = useTag(interaction.guildId, name);
            if (!tag) throw userError(`There is no tag called **${name}**. See \`/tag list\`.`);
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
            const lines = tags.map((tag) => `\`${tag.name}\`${tag.triggerKind !== 'none' ? ` · auto: ${tag.triggerKind}` : ''} · ${tag.uses} uses`);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: `Tags (${tags.length})`,
                    description: truncate(lines.join('\n') || 'No tags yet.', 4096),
                    color: 'primary',
                })],
            });
        }

        if (sub === 'delete') {
            const removed = await deleteTag(interaction.guildId, name);
            return InteractionHelper.safeEditReply(interaction, { content: removed ? `Deleted tag **${name}**.` : `There is no tag called **${name}**.` });
        }

        const fields = {
            guildId: interaction.guildId,
            name,
            content: interaction.options.getString('content') ?? undefined,
            triggerKind: interaction.options.getString('trigger_kind') ?? undefined,
            trigger: interaction.options.getString('trigger') ?? undefined,
            allowChannels: readChannels(interaction, 'allow_channels'),
            denyChannels: readChannels(interaction, 'deny_channels'),
            cooldownS: interaction.options.getInteger('cooldown') ?? undefined,
        };

        if (sub === 'create') {
            if (fields.trigger && !fields.triggerKind) fields.triggerKind = 'word';
            if (fields.triggerKind && !fields.trigger) throw userError('Give the trigger text too.');
            const tag = await createTag({
                ...fields,
                triggerKind: fields.triggerKind ?? 'none',
                allowChannels: fields.allowChannels ?? [],
                denyChannels: fields.denyChannels ?? [],
                cooldownS: fields.cooldownS ?? null,
                createdBy: interaction.user.id,
            });
            return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(`Tag ${tag.name} created`, describeTag(tag))] });
        }

        if (sub === 'edit') {
            const tag = await editTag(fields);
            if (!tag) throw userError(`There is no tag called **${name}**.`);
            return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(`Tag ${tag.name} updated`, describeTag(tag))] });
        }
    },
};
