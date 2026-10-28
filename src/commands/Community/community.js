import { SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { listStickies, removeSticky, setSticky, STICKY_MAX_LENGTH } from '../../services/community/stickyService.js';
import { updateCommunitySettings } from '../../services/community/settingsService.js';
import { starboardSettingsPatch, STARBOARD_MAX_THRESHOLD } from '../../services/community/starboardService.js';
import { addFeed, listFeeds, removeFeed, renderFeedMessage, FEED_TEMPLATE_MAX } from '../../services/community/feedService.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** /community sticky set | remove | list */
async function handleSticky(interaction, sub) {
    if (sub === 'set') {
        const channel = interaction.options.getChannel('channel', true);
        const { posted } = await setSticky({
            guildId: interaction.guildId,
            channel,
            content: interaction.options.getString('message', true),
            updatedBy: interaction.user.id,
        });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Sticky message saved', posted
                ? `It is now pinned to the bottom of ${channel} and is reposted after members talk there (at most every 15 seconds).`
                : `Saved, but I could not post in ${channel}. Check that I can view the channel, send messages and embed links there.`)],
        });
    }
    if (sub === 'remove') {
        const channel = interaction.options.getChannel('channel', true);
        const removed = await removeSticky({ channelId: channel.id, channel });
        return InteractionHelper.safeEditReply(interaction, {
            content: removed ? `Removed the sticky message from ${channel}.` : `${channel} has no sticky message.`,
        });
    }
    if (sub === 'list') {
        const lines = listStickies(interaction.guildId).map((sticky) => `<#${sticky.channelId}> · ${truncate(sticky.content.replace(/\s+/g, ' '), 120)}`);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: `Sticky messages (${lines.length})`,
                description: lines.join('\n') || 'None. Add one with `/community sticky set`.',
                color: 'primary',
            })],
        });
    }
}

/** /community suggestions channel [channel] */
async function handleSuggestions(interaction, sub) {
    if (sub === 'channel') {
        const channel = interaction.options.getChannel('channel');
        await updateCommunitySettings(interaction.guildId, { suggestionsChannelId: channel?.id ?? null }, interaction.user.id);
        return InteractionHelper.safeEditReply(interaction, {
            content: channel
                ? `Suggestions from \`/suggest new\` now go to ${channel}. Make sure I can send messages and embeds there.`
                : 'Suggestions are turned off (no channel).',
        });
    }
}

/** /community starboard set | off */
async function handleStarboard(interaction, sub) {
    if (sub === 'set') {
        const channel = interaction.options.getChannel('channel', true);
        const settings = await updateCommunitySettings(interaction.guildId, starboardSettingsPatch({
            channelId: channel.id,
            emoji: interaction.options.getString('emoji'),
            threshold: interaction.options.getInteger('threshold'),
        }), interaction.user.id);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Starboard on', [
                `Messages with **${settings.starboardThreshold}** ${settings.starboardEmoji} reactions are copied to ${channel}.`,
                "The author's own reaction and bots don't count; bot messages are never starred.",
            ].join('\n'))],
        });
    }
    if (sub === 'off') {
        await updateCommunitySettings(interaction.guildId, { starboardChannelId: null }, interaction.user.id);
        return InteractionHelper.safeEditReply(interaction, { content: 'Starboard turned off. Existing starboard posts stay where they are.' });
    }
}

/** /community feed add | remove | list */
async function handleFeed(interaction, sub) {
    if (sub === 'add') {
        const channel = interaction.options.getChannel('channel', true);
        const { feed, latest } = await addFeed({
            guildId: interaction.guildId,
            sourceInput: interaction.options.getString('youtube_channel_id', true),
            channelId: channel.id,
            template: interaction.options.getString('message'),
            createdBy: interaction.user.id,
        });
        const preview = latest ? renderFeedMessage(feed.template, latest) : null;
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(`Feed #${feed.id} added`, [
                `New videos from **${latest?.author || feed.sourceId}** will be posted in ${channel} (checked every 15 minutes).`,
                preview ? `\n**Preview** (with the latest video, not posted):\n${truncate(preview, 1500)}` : '\nThe channel has no videos yet.',
            ].join('\n'))],
        });
    }
    if (sub === 'remove') {
        const id = interaction.options.getInteger('id', true);
        const removed = await removeFeed(interaction.guildId, id);
        return InteractionHelper.safeEditReply(interaction, { content: removed ? `Removed feed #${id}.` : `There is no feed #${id}. See \`/community feed list\`.` });
    }
    if (sub === 'list') {
        const lines = listFeeds(interaction.guildId).map((feed) =>
            `**#${feed.id}** YouTube \`${feed.sourceId}\` → <#${feed.channelId}>${feed.template ? ` · "${truncate(feed.template.replace(/\s+/g, ' '), 60)}"` : ''}`);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: `Feeds (${lines.length})`,
                description: lines.join('\n') || 'None. Add one with `/community feed add`.',
                color: 'primary',
            })],
        });
    }
}

export default {
    // Admin-only (not in commandAccess.js): community feature setup.
    scope: 'main',
    slashOnly: true,
    category: 'Community',
    data: new SlashCommandBuilder()
        .setName('community')
        .setDescription('Set up sticky messages, suggestions, the starboard and feeds')
        .addSubcommandGroup((group) => group.setName('sticky').setDescription('Messages kept at the bottom of a channel')
            .addSubcommand((sub) => sub.setName('set').setDescription('Set (or replace) the sticky message of a channel')
                .addChannelOption((option) => option.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
                .addStringOption((option) => option.setName('message').setDescription('The text to keep at the bottom')
                    .setRequired(true).setMaxLength(STICKY_MAX_LENGTH)))
            .addSubcommand((sub) => sub.setName('remove').setDescription('Remove the sticky message of a channel')
                .addChannelOption((option) => option.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)))
            .addSubcommand((sub) => sub.setName('list').setDescription('List sticky messages')))
        .addSubcommandGroup((group) => group.setName('suggestions').setDescription('Member suggestions (/suggest)')
            .addSubcommand((sub) => sub.setName('channel').setDescription('Set the suggestions channel (leave empty to turn suggestions off)')
                .addChannelOption((option) => option.setName('channel').setDescription('Channel').addChannelTypes(...TEXT_CHANNELS))))
        .addSubcommandGroup((group) => group.setName('starboard').setDescription('Copy popular messages to a starboard channel')
            .addSubcommand((sub) => sub.setName('set').setDescription('Turn the starboard on or change it')
                .addChannelOption((option) => option.setName('channel').setDescription('Starboard channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
                .addStringOption((option) => option.setName('emoji').setDescription('Reaction that counts (default ⭐)').setMaxLength(64))
                .addIntegerOption((option) => option.setName('threshold').setDescription('Reactions needed (default 3)')
                    .setMinValue(1).setMaxValue(STARBOARD_MAX_THRESHOLD)))
            .addSubcommand((sub) => sub.setName('off').setDescription('Turn the starboard off')))
        .addSubcommandGroup((group) => group.setName('feed').setDescription('Post new YouTube videos in a channel')
            .addSubcommand((sub) => sub.setName('add').setDescription('Follow a YouTube channel')
                .addStringOption((option) => option.setName('youtube_channel_id').setDescription('Channel id (UC…) or youtube.com/channel/UC… link')
                    .setRequired(true).setMaxLength(200))
                .addChannelOption((option) => option.setName('channel').setDescription('Where to post').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
                .addStringOption((option) => option.setName('message').setDescription('Message with {title} {url} {author}; may mention a role')
                    .setMaxLength(FEED_TEMPLATE_MAX)))
            .addSubcommand((sub) => sub.setName('remove').setDescription('Stop following a YouTube channel')
                .addIntegerOption((option) => option.setName('id').setDescription('Feed number (#) from /community feed list').setRequired(true).setMinValue(1)))
            .addSubcommand((sub) => sub.setName('list').setDescription('List feeds')))
        .setDMPermission(false),

    async execute(interaction) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();
        if (group === 'sticky') return handleSticky(interaction, sub);
        if (group === 'suggestions') return handleSuggestions(interaction, sub);
        if (group === 'starboard') return handleStarboard(interaction, sub);
        if (group === 'feed') return handleFeed(interaction, sub);
    },
};
