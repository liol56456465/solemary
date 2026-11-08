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
import { guildIdFor, isSettingsLoaded, resolveSetting, updateSettings } from '../../services/settings/guildSettings.js';
import { numberedRules } from '../../services/rules/serverRules.js';
import {
    postAndSaveRules, postRulesMessages, rulesMessagesFor, rulesPostDesign, serializedRules, updateAndSaveRules, updateRulesMessages,
} from '../../services/rules/rulesPost.js';
import { resolveWelcomeImageUrl } from '../../utils/welcomeImageStore.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';

const NO_MENTIONS = Object.freeze({ parse: [] });

/** The services the command uses (tests replace them; nothing reaches Discord or the DB). */
export const rulesCommandDeps = {
    guildIdFor, isSettingsLoaded, resolveSetting, updateSettings, resolveWelcomeImageUrl, postRulesMessages, updateRulesMessages,
};

const userError = (message, type = ErrorTypes.VALIDATION) => new TitanBotError(message, type, message, { expected: true });
const isReadable = (error) => Boolean(error?.userMessage) || ['validation', 'permission', 'user_input', 'configuration'].includes(error?.type);
const clip = (value, max = 200) => {
    const t = String(value ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A Discord-side call; an unexpected Discord error becomes a readable refusal (like the dashboard). */
async function discordCall(tr, task, refusal) {
    try {
        return await task();
    } catch (error) {
        if (isReadable(error)) throw error;
        logger.warn(`/rules: ${error.message}`);
        throw userError(tr.t('moderation.rules.discordSaid', { refusal, error: clip(error.message) }), ErrorTypes.DISCORD_API);
    }
}

/** The main server's saved rules and design; refuses outside the main server or before settings loaded. */
function readState(interaction, tr) {
    const mainId = rulesCommandDeps.guildIdFor('main');
    if (!mainId || interaction.guildId !== mainId) throw userError(tr.t('moderation.rules.mainOnly'));
    // Settings not read from the database yet: never post the defaults instead of the saved design.
    if (!rulesCommandDeps.isSettingsLoaded()) throw userError(tr.t('moderation.rules.notLoaded'), ErrorTypes.DATABASE);
    const { rules } = numberedRules(rulesCommandDeps.resolveSetting(mainId, 'serverRules'));
    const design = rulesPostDesign(rulesCommandDeps.resolveSetting(mainId, 'rulesPost'));
    return { mainId, rules, design };
}

function messagesFor(client, { mainId, rules, design }) {
    return rulesMessagesFor({ client, guildId: mainId, rules, design, resolve: rulesCommandDeps.resolveWelcomeImageUrl });
}

/** Saves the new posted ids; a database error says what was undone (`undone`). */
function saver(interaction, tr, mainId, design, undone) {
    return async (posted) => {
        try {
            await rulesCommandDeps.updateSettings(mainId, { rulesPost: { ...design, posted } },
                { userId: interaction.user.id, username: interaction.user.username, module: 'rules' });
        } catch (error) {
            if (isReadable(error)) throw error;
            logger.warn(`/rules: saving the posted ids failed: ${error.message}`);
            throw userError(tr.t('moderation.rules.saveFailed', { undone }), ErrorTypes.DATABASE);
        }
    };
}

async function post(interaction, client, tr) {
    const state = readState(interaction, tr);
    const { design } = state;
    const picked = interaction.options.getChannel('channel');
    const channelId = picked?.id || design.channelId;
    if (!channelId) throw userError(tr.t('moderation.rules.noChannel'));
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel) {
        throw userError(picked ? tr.t('moderation.rules.cannotSee') : tr.t('moderation.rules.channelGone'));
    }
    const messages = await messagesFor(client, state);
    const { posted } = await postAndSaveRules({
        guild: interaction.guild, channel, messages,
        post: (guild, ch, msgs) => discordCall(tr, () => rulesCommandDeps.postRulesMessages(guild, ch, msgs), tr.t('moderation.rules.postRefused')),
        save: saver(interaction, tr, state.mainId, design, tr.t('moderation.rules.postUndone')),
    });
    const messageCount = tr.tp('moderation.rules.messages', posted.messageIds.length);
    const done = tr.t('moderation.rules.posted', { channelId: channel.id, messages: messageCount });
    return design.posted ? `${done} ${tr.t('moderation.rules.earlierPost', { channelId: design.posted.channelId })}` : done;
}

async function update(interaction, client, tr) {
    const state = readState(interaction, tr);
    const { design } = state;
    if (!design.posted) throw userError(tr.t('moderation.rules.notPosted'));
    const messages = await messagesFor(client, state);
    const { posted } = await updateAndSaveRules({
        guild: interaction.guild, current: design.posted, messages,
        update: (guild, current, msgs) => discordCall(tr, () => rulesCommandDeps.updateRulesMessages(guild, current, msgs),
            tr.t('moderation.rules.updateRefused')),
        save: saver(interaction, tr, state.mainId, design, tr.t('moderation.rules.updateUndone')),
    });
    return tr.t('moderation.rules.updated', { channelId: posted.channelId, messages: tr.tp('moderation.rules.messages', posted.messageIds.length) });
}

/** Every message of the post as ephemeral replies: nothing is posted or saved. */
async function preview(interaction, client, tr) {
    const state = readState(interaction, tr);
    const messages = await messagesFor(client, state);
    const where = state.design.channelId ? `<#${state.design.channelId}>` : tr.t('moderation.rules.noChannelSaved');
    const head = tr.t('moderation.rules.previewHead', { messages: tr.tp('moderation.rules.messages', messages.length), where });
    await InteractionHelper.safeEditReply(interaction, { content: head, embeds: messages[0].embeds, files: messages[0].files, allowedMentions: NO_MENTIONS });
    for (const message of messages.slice(1)) {
        await interaction.followUp({ embeds: message.embeds, files: message.files, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('rules')
        .setDescription('Post, update or preview the server rules message')
        .setDescriptionLocalizations(descriptionLocalizations('moderation.rules.cmd.description'))
        .addSubcommand((sub) => sub.setName('post')
            .setDescription('Post the rules with the design saved on the dashboard')
            .setDescriptionLocalizations(descriptionLocalizations('moderation.rules.cmd.post'))
            .addChannelOption((option) => option.setName('channel')
                .setDescription('Where to post them (default: the channel saved on the dashboard)')
                .setDescriptionLocalizations(descriptionLocalizations('moderation.rules.cmd.postChannel'))
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(false)))
        .addSubcommand((sub) => sub.setName('update')
            .setDescription('Change the posted rules message to the current rules and design')
            .setDescriptionLocalizations(descriptionLocalizations('moderation.rules.cmd.update')))
        .addSubcommand((sub) => sub.setName('preview')
            .setDescription('Show the rules post only to you, without posting it')
            .setDescriptionLocalizations(descriptionLocalizations('moderation.rules.cmd.preview')))
        .setDMPermission(false),

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) {
            logger.warn('Rules interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'rules' });
            return;
        }
        const bot = client ?? interaction.client;
        const tr = textForInteraction(interaction); // every /rules reply is ephemeral: the admin's language
        const sub = interaction.options.getSubcommand();
        if (sub === 'preview') {
            // Reads only: no need to wait for a post or edit in progress.
            await preview(interaction, bot, tr);
            return;
        }
        // Post and update wait for any other rules change (dashboard or /rules) to finish.
        const content = await serializedRules(() => (sub === 'update' ? update(interaction, bot, tr) : post(interaction, bot, tr)));
        await InteractionHelper.safeEditReply(interaction, { content, allowedMentions: NO_MENTIONS });
    },
};
