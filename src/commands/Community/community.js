import { SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { listStickies, removeSticky, setSticky, STICKY_MAX_LENGTH } from '../../services/community/stickyService.js';

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

export default {
    // Admin-only (not in commandAccess.js): community feature setup.
    scope: 'main',
    slashOnly: true,
    category: 'Community',
    data: new SlashCommandBuilder()
        .setName('community')
        .setDescription('Set up sticky messages and other community features')
        .addSubcommandGroup((group) => group.setName('sticky').setDescription('Messages kept at the bottom of a channel')
            .addSubcommand((sub) => sub.setName('set').setDescription('Set (or replace) the sticky message of a channel')
                .addChannelOption((option) => option.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
                .addStringOption((option) => option.setName('message').setDescription('The text to keep at the bottom')
                    .setRequired(true).setMaxLength(STICKY_MAX_LENGTH)))
            .addSubcommand((sub) => sub.setName('remove').setDescription('Remove the sticky message of a channel')
                .addChannelOption((option) => option.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)))
            .addSubcommand((sub) => sub.setName('list').setDescription('List sticky messages')))
        .setDMPermission(false),

    async execute(interaction) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();
        if (group === 'sticky') return handleSticky(interaction, sub);
    },
};
