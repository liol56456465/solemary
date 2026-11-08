import { SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { listStickies, removeSticky, setSticky, STICKY_MAX_LENGTH } from '../../services/community/stickyService.js';
import { updateCommunitySettings } from '../../services/community/settingsService.js';
import { starboardSettingsPatch, STARBOARD_MAX_THRESHOLD } from '../../services/community/starboardService.js';
import { addFeed, listFeeds, removeFeed, renderFeedMessage, FEED_TEMPLATE_MAX } from '../../services/community/feedService.js';
import { textForInteraction } from '../../utils/botText.js';
import { describe } from '../../utils/commandLocalizations.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const FEED_TOKENS = { title: '{title}', url: '{url}', author: '{author}', game: '{game}' };

function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** /community sticky set | remove | list */
async function handleSticky(interaction, sub, tr) {
    if (sub === 'set') {
        const channel = interaction.options.getChannel('channel', true);
        const { posted } = await setSticky({
            guildId: interaction.guildId,
            channel,
            content: interaction.options.getString('message', true),
            updatedBy: interaction.user.id,
            lang: tr.lang,
        });
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('community.sticky.savedTitle'), posted
                ? tr.t('community.sticky.posted', { channel: String(channel) })
                : tr.t('community.sticky.notPosted', { channel: String(channel) }))],
        });
    }
    if (sub === 'remove') {
        const channel = interaction.options.getChannel('channel', true);
        const removed = await removeSticky({ channelId: channel.id, channel });
        return InteractionHelper.safeEditReply(interaction, {
            content: removed ? tr.t('community.sticky.removed', { channel: String(channel) }) : tr.t('community.sticky.none', { channel: String(channel) }),
        });
    }
    if (sub === 'list') {
        const lines = listStickies(interaction.guildId).map((sticky) => `<#${sticky.channelId}> · ${truncate(sticky.content.replace(/\s+/g, ' '), 120)}`);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: tr.t('community.sticky.listTitle', { count: lines.length }),
                description: lines.join('\n') || tr.t('community.sticky.listEmpty'),
                color: 'primary',
            })],
        });
    }
}

/** /community suggestions channel [channel] */
async function handleSuggestions(interaction, sub, tr) {
    if (sub === 'channel') {
        const channel = interaction.options.getChannel('channel');
        await updateCommunitySettings(interaction.guildId, { suggestionsChannelId: channel?.id ?? null }, interaction.user.id);
        return InteractionHelper.safeEditReply(interaction, {
            content: channel
                ? tr.t('community.suggestions.channelSet', { channel: String(channel) })
                : tr.t('community.suggestions.off'),
        });
    }
}

/** /community starboard set | off */
async function handleStarboard(interaction, sub, tr) {
    if (sub === 'set') {
        const channel = interaction.options.getChannel('channel', true);
        const settings = await updateCommunitySettings(interaction.guildId, starboardSettingsPatch({
            channelId: channel.id,
            emoji: interaction.options.getString('emoji'),
            threshold: interaction.options.getInteger('threshold'),
        }, { lang: tr.lang }), interaction.user.id);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('community.starboard.onTitle'), [
                tr.t('community.starboard.onLine', { threshold: settings.starboardThreshold, emoji: settings.starboardEmoji, channel: String(channel) }),
                tr.t('community.starboard.rules'),
            ].join('\n'))],
        });
    }
    if (sub === 'off') {
        await updateCommunitySettings(interaction.guildId, { starboardChannelId: null }, interaction.user.id);
        return InteractionHelper.safeEditReply(interaction, { content: tr.t('community.starboard.offDone') });
    }
}

const PLATFORM_LABELS = { youtube: 'YouTube', twitch: 'Twitch' };
const platformName = (kind) => PLATFORM_LABELS[kind] || kind;

/** /community feed add | remove | list */
async function handleFeed(interaction, sub, tr) {
    if (sub === 'add') {
        const channel = interaction.options.getChannel('channel', true);
        const platform = interaction.options.getString('platform') || 'youtube';
        const { feed, latest, live } = await addFeed({
            guildId: interaction.guildId,
            platform,
            sourceInput: interaction.options.getString('source', true),
            channelId: channel.id,
            template: interaction.options.getString('message'),
            createdBy: interaction.user.id,
            lang: tr.lang,
        });
        // The preview shows the default message in the server's language, as it will be posted.
        const postLang = textForInteraction(interaction, { purpose: 'public' }).lang;
        if (platform === 'twitch') {
            const preview = renderFeedMessage(feed.template, latest, 'twitch', { lang: postLang });
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('community.feed.addedTitle', { id: feed.id }), [
                    tr.t('community.feed.twitchWatch', { channel: String(channel), author: latest.author }),
                    live ? tr.t('community.feed.liveNow') : '',
                    tr.t('community.feed.previewTwitch', { source: live ? tr.t('community.feed.withCurrent') : tr.t('community.feed.withExample'), preview: truncate(preview, 1500) }),
                ].filter(Boolean).join('\n'))],
            });
        }
        const preview = latest ? renderFeedMessage(feed.template, latest, 'youtube', { lang: postLang }) : null;
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('community.feed.addedTitle', { id: feed.id }), [
                tr.t('community.feed.youtubeWatch', { author: latest?.author || feed.sourceId, channel: String(channel) }),
                preview ? tr.t('community.feed.previewYoutube', { preview: truncate(preview, 1500) }) : tr.t('community.feed.noVideos'),
            ].join('\n'))],
        });
    }
    if (sub === 'remove') {
        const id = interaction.options.getInteger('id', true);
        const removed = await removeFeed(interaction.guildId, id);
        return InteractionHelper.safeEditReply(interaction, { content: removed ? tr.t('community.feed.removed', { id }) : tr.t('community.feed.notFound', { id }) });
    }
    if (sub === 'list') {
        const lines = listFeeds(interaction.guildId).map((feed) =>
            `**#${feed.id}** ${platformName(feed.kind)} \`${feed.sourceId}\` → <#${feed.channelId}>${feed.template ? ` · "${truncate(feed.template.replace(/\s+/g, ' '), 60)}"` : ''}`);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: tr.t('community.feed.listTitle', { count: lines.length }),
                description: lines.join('\n') || tr.t('community.feed.listEmpty'),
                color: 'primary',
            })],
        });
    }
}

export default {
    // Admin-only (not in commandAccess.js): community feature setup.
    slashOnly: true,
    category: 'Community',
    data: describe(new SlashCommandBuilder()
        .setName('community'), 'community.cmd.community.desc')
        .addSubcommandGroup((group) => describe(group.setName('sticky'), 'community.cmd.community.sticky.desc')
            .addSubcommand((sub) => describe(sub.setName('set'), 'community.cmd.community.sticky.set')
                .addChannelOption((option) => describe(option.setName('channel'), 'community.cmd.community.channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
                .addStringOption((option) => describe(option.setName('message'), 'community.cmd.community.sticky.message')
                    .setRequired(true).setMaxLength(STICKY_MAX_LENGTH)))
            .addSubcommand((sub) => describe(sub.setName('remove'), 'community.cmd.community.sticky.remove')
                .addChannelOption((option) => describe(option.setName('channel'), 'community.cmd.community.channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)))
            .addSubcommand((sub) => describe(sub.setName('list'), 'community.cmd.community.sticky.list')))
        .addSubcommandGroup((group) => describe(group.setName('suggestions'), 'community.cmd.community.suggestions.desc')
            .addSubcommand((sub) => describe(sub.setName('channel'), 'community.cmd.community.suggestions.channel')
                .addChannelOption((option) => describe(option.setName('channel'), 'community.cmd.community.channel').addChannelTypes(...TEXT_CHANNELS))))
        .addSubcommandGroup((group) => describe(group.setName('starboard'), 'community.cmd.community.starboard.desc')
            .addSubcommand((sub) => describe(sub.setName('set'), 'community.cmd.community.starboard.set')
                .addChannelOption((option) => describe(option.setName('channel'), 'community.cmd.community.starboard.channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
                .addStringOption((option) => describe(option.setName('emoji'), 'community.cmd.community.starboard.emoji').setMaxLength(64))
                .addIntegerOption((option) => describe(option.setName('threshold'), 'community.cmd.community.starboard.threshold')
                    .setMinValue(1).setMaxValue(STARBOARD_MAX_THRESHOLD)))
            .addSubcommand((sub) => describe(sub.setName('off'), 'community.cmd.community.starboard.off')))
        .addSubcommandGroup((group) => describe(group.setName('feed'), 'community.cmd.community.feed.desc')
            .addSubcommand((sub) => describe(sub.setName('add'), 'community.cmd.community.feed.add')
                .addStringOption((option) => describe(option.setName('source'), 'community.cmd.community.feed.source')
                    .setRequired(true).setMaxLength(200))
                .addChannelOption((option) => describe(option.setName('channel'), 'community.cmd.community.feed.channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
                .addStringOption((option) => describe(option.setName('platform'), 'community.cmd.community.feed.platform')
                    .addChoices({ name: 'YouTube', value: 'youtube' }, { name: 'Twitch', value: 'twitch' }))
                // The {title} {url} {author} {game} tokens are typed by admins: passed as params so they stay as written.
                .addStringOption((option) => describe(option.setName('message'), 'community.cmd.community.feed.message', FEED_TOKENS)
                    .setMaxLength(FEED_TEMPLATE_MAX)))
            .addSubcommand((sub) => describe(sub.setName('remove'), 'community.cmd.community.feed.remove')
                .addIntegerOption((option) => describe(option.setName('id'), 'community.cmd.community.feed.id').setRequired(true).setMinValue(1)))
            .addSubcommand((sub) => describe(sub.setName('list'), 'community.cmd.community.feed.list')))
        .setDMPermission(false),

    async execute(interaction) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();
        const tr = textForInteraction(interaction);
        if (group === 'sticky') return handleSticky(interaction, sub, tr);
        if (group === 'suggestions') return handleSuggestions(interaction, sub, tr);
        if (group === 'starboard') return handleStarboard(interaction, sub, tr);
        if (group === 'feed') return handleFeed(interaction, sub, tr);
    },
};
