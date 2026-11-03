// /rules post [channel] | update | preview: the server rules post from Discord, the same post
// as the dashboard Rules page ("Post to Discord"). The design (title, colour, intro, footer,
// layout, banner, thumbnail) and the rules are edited on the dashboard; this command only
// posts, updates or previews them through the same service (services/rules/rulesPost.js):
// one rules change at a time, the message ids saved after Discord accepted the post, a failed
// save undoes what was sent, left-over messages are deleted only after the save.
//
// Administrator-only (unlisted access keys default to Administrator in commandAccess.js).
// One top-level command with subcommands, to keep the server's command count low.
// Every reply and post uses allowedMentions { parse: [] }.

import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { getConfiguredSetting, guildIdFor, isSettingsLoaded, updateSettings } from '../../services/settings/guildSettings.js';
import { numberedRules } from '../../services/rules/serverRules.js';
import {
    postAndSaveRules, postRulesMessages, rulesMessagesFor, rulesPostDesign, serializedRules, updateAndSaveRules, updateRulesMessages,
} from '../../services/rules/rulesPost.js';
import { resolveWelcomeImageUrl } from '../../utils/welcomeImageStore.js';

const NO_MENTIONS = Object.freeze({ parse: [] });

/** The services the command uses (tests replace them; nothing reaches Discord or the DB). */
export const rulesCommandDeps = {
    getConfiguredSetting, guildIdFor, isSettingsLoaded, updateSettings, resolveWelcomeImageUrl, postRulesMessages, updateRulesMessages,
};

const userError = (message, type = ErrorTypes.VALIDATION) => new TitanBotError(message, type, message, { expected: true });
const isReadable = (error) => Boolean(error?.userMessage) || ['validation', 'permission', 'user_input', 'configuration'].includes(error?.type);
const clip = (value, max = 200) => {
    const t = String(value ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const plural = (n) => `${n} ${n === 1 ? 'message' : 'messages'}`;

/** A Discord-side call; an unexpected Discord error becomes a readable refusal (like the dashboard). */
async function discordCall(task, refusal) {
    try {
        return await task();
    } catch (error) {
        if (isReadable(error)) throw error;
        logger.warn(`/rules: ${error.message}`);
        throw userError(`${refusal} Discord said: ${clip(error.message)}`, ErrorTypes.DISCORD_API);
    }
}

/** The main server's saved rules and design; refuses outside the main server or before settings loaded. */
function readState(interaction) {
    const mainId = rulesCommandDeps.guildIdFor('main');
    if (!mainId || interaction.guildId !== mainId) throw userError('The rules can only be posted from the main server.');
    // Settings not read from the database yet: never post the defaults instead of the saved design.
    if (!rulesCommandDeps.isSettingsLoaded()) throw userError('The saved settings are not loaded (database not responding). Nothing was changed.', ErrorTypes.DATABASE);
    const { rules } = numberedRules(rulesCommandDeps.getConfiguredSetting('serverRules'));
    const design = rulesPostDesign(rulesCommandDeps.getConfiguredSetting('rulesPost'));
    return { mainId, rules, design };
}

function messagesFor(client, { mainId, rules, design }) {
    return rulesMessagesFor({ client, guildId: mainId, rules, design, resolve: rulesCommandDeps.resolveWelcomeImageUrl });
}

/** Saves the new posted ids; a database error says what was undone (`undone`). */
function saver(interaction, mainId, design, undone) {
    return async (posted) => {
        try {
            await rulesCommandDeps.updateSettings(mainId, { rulesPost: { ...design, posted } },
                { userId: interaction.user.id, username: interaction.user.username, module: 'rules' });
        } catch (error) {
            if (isReadable(error)) throw error;
            logger.warn(`/rules: saving the posted ids failed: ${error.message}`);
            throw userError(`Could not save the post (database not responding). ${undone}`, ErrorTypes.DATABASE);
        }
    };
}

async function post(interaction, client) {
    const state = readState(interaction);
    const { design } = state;
    const picked = interaction.options.getChannel('channel');
    const channelId = picked?.id || design.channelId;
    if (!channelId) throw userError('No rules channel is saved. Pick one with the channel option, or save one on the dashboard Rules page.');
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel) {
        throw userError(picked ? 'I cannot see that channel. Pick another one.' : 'The saved rules channel no longer exists. Pick one with the channel option, or save another on the dashboard Rules page.');
    }
    const messages = await messagesFor(client, state);
    const { posted } = await postAndSaveRules({
        guild: interaction.guild, channel, messages,
        post: (guild, ch, msgs) => discordCall(() => rulesCommandDeps.postRulesMessages(guild, ch, msgs), 'Discord refused the post. Nothing was posted.'),
        save: saver(interaction, state.mainId, design, 'The post was removed again. Nothing was changed.'),
    });
    const earlier = design.posted ? ` The earlier post in <#${design.posted.channelId}> stays where it is. Next time, use /rules update to change the post instead.` : '';
    return `The rules were posted in <#${channel.id}> (${plural(posted.messageIds.length)}).${earlier}`;
}

async function update(interaction, client) {
    const state = readState(interaction);
    const { design } = state;
    if (!design.posted) throw userError('The rules have not been posted yet. Use /rules post first.');
    const messages = await messagesFor(client, state);
    const { posted } = await updateAndSaveRules({
        guild: interaction.guild, current: design.posted, messages,
        update: (guild, current, msgs) => discordCall(() => rulesCommandDeps.updateRulesMessages(guild, current, msgs),
            'Discord refused the update. Some messages may already show the new rules. Try /rules update again.'),
        save: saver(interaction, state.mainId, design, 'New extra messages were removed again and the saved post was not changed. Run /rules update again.'),
    });
    return `The posted rules in <#${posted.channelId}> were updated (${plural(posted.messageIds.length)}).`;
}

/** Every message of the post as ephemeral replies: nothing is posted or saved. */
async function preview(interaction, client) {
    const state = readState(interaction);
    const messages = await messagesFor(client, state);
    const where = state.design.channelId ? `<#${state.design.channelId}>` : 'no channel saved yet';
    const head = `Preview of the rules post (${plural(messages.length)}, saved channel: ${where}). Only you can see this. Nothing was posted.`;
    await InteractionHelper.safeEditReply(interaction, { content: head, embeds: messages[0].embeds, files: messages[0].files, allowedMentions: NO_MENTIONS });
    for (const message of messages.slice(1)) {
        await interaction.followUp({ embeds: message.embeds, files: message.files, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('rules')
        .setDescription('Post, update or preview the server rules message')
        .addSubcommand((sub) => sub.setName('post')
            .setDescription('Post the rules with the design saved on the dashboard')
            .addChannelOption((option) => option.setName('channel')
                .setDescription('Where to post them (default: the channel saved on the dashboard)')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(false)))
        .addSubcommand((sub) => sub.setName('update')
            .setDescription('Change the posted rules message to the current rules and design'))
        .addSubcommand((sub) => sub.setName('preview')
            .setDescription('Show the rules post only to you, without posting it'))
        .setDMPermission(false),

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) {
            logger.warn('Rules interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'rules' });
            return;
        }
        const bot = client ?? interaction.client;
        const sub = interaction.options.getSubcommand();
        if (sub === 'preview') {
            // Reads only: no need to wait for a post or edit in progress.
            await preview(interaction, bot);
            return;
        }
        // Post and update wait for any other rules change (dashboard or /rules) to finish.
        const content = await serializedRules(() => (sub === 'update' ? update(interaction, bot) : post(interaction, bot)));
        await InteractionHelper.safeEditReply(interaction, { content, allowedMentions: NO_MENTIONS });
    },
};
