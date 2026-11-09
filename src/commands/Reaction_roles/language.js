// /language set | panel — language roles (services/languageRoleService.js).
// set: everyone (commandAccess.js): a private select of all 8 languages; picking one that has a
//      role here gives that role and removes the member's other language roles; one without a
//      role (or in a server without language roles) is saved as the member's personal language
//      for DMs (services/personalLanguage.js, audit 4.6).
// panel: Administrator-only (not listed in commandAccess.js, so the dispatcher's gate refuses
//      everyone else before execute runs): posts a persistent panel with one button per
//      language (langrole:set:<code>), which does the same for whoever clicks.
// Discord does not allow a bare /language next to subcommands, hence /language set.

import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { textForGuild, textForInteraction } from '../../utils/botText.js';
import { describe } from '../../utils/commandLocalizations.js';
import {
    LanguageRoleError, NO_MENTIONS, currentLanguageRole, languageErrorText, languagePanelRows, languagePickerRow,
    languageRolesFor, nativeLanguageName, offeredLanguages,
} from '../../services/languageRoleService.js';
import { personalLanguageOf } from '../../services/personalLanguage.js';

const PANEL_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/**
 * The private /language set reply: every language; the member's language role here (else their
 * personal language) is preselected. No language roles in the server is no longer a dead end:
 * the pick is saved as their personal language. deps (tests): { resolve, personal }.
 */
export function languageSetReply(interaction, deps = {}) {
    const tr = textForInteraction(interaction);
    const title = tr.t('language.pick.title');
    let map;
    try {
        map = languageRolesFor(interaction.guildId, deps);
    } catch (error) {
        return { embeds: [createEmbed({ title, description: languageErrorText(tr, error), color: 'warning' })], components: [], allowedMentions: NO_MENTIONS };
    }
    const personal = (deps.personal || personalLanguageOf)(interaction.user.id);
    const role = currentLanguageRole(interaction.member, map);
    const lines = [tr.t(offeredLanguages(map).length ? 'language.pick.text' : 'language.pick.textPersonal')];
    if (personal) lines.push(tr.t('language.pick.personalNow', { language: nativeLanguageName(personal) }));
    return {
        embeds: [createEmbed({ title, description: lines.join('\n\n'), color: 'info' })],
        components: [languagePickerRow(tr, map, { userId: interaction.user.id, current: role ?? personal, personal })],
        allowedMentions: NO_MENTIONS,
    };
}

/** The panel message (a channel-wide post: the server's language; the buttons are native names). */
export function languagePanelMessage(guildId, map) {
    const tr = textForGuild(guildId, { purpose: 'public' });
    return {
        embeds: [createEmbed({ title: tr.t('language.panel.title'), description: tr.t('language.panel.text'), color: 'info' })],
        components: languagePanelRows(map),
        allowedMentions: NO_MENTIONS,
    };
}

export default {
    slashOnly: true,
    data: describe(new SlashCommandBuilder().setName('language'), 'language.cmd.desc')
        .addSubcommand((sub) => describe(sub.setName('set'), 'language.cmd.set'))
        .addSubcommand((sub) => describe(sub.setName('panel'), 'language.cmd.panel')
            .addChannelOption((option) => describe(option.setName('channel'), 'language.cmd.channel')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .setDMPermission(false),

    async execute(interaction, guildConfig, client, deps = {}) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const sub = interaction.options.getSubcommand();
        if (sub === 'set') return InteractionHelper.safeEditReply(interaction, languageSetReply(interaction, deps));

        // panel
        const tr = textForInteraction(interaction);
        const say = (description, color = 'warning') => InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({ title: tr.t('language.panel.title'), description, color })], allowedMentions: NO_MENTIONS,
        });
        let map;
        try {
            map = languageRolesFor(interaction.guildId, deps);
        } catch (error) {
            return say(languageErrorText(tr, error));
        }
        if (!offeredLanguages(map).length) return say(tr.t('language.notSetUp'));
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (!channel?.isTextBased?.() || !channel.send) return say(tr.t('language.panel.textOnly'));
        const me = interaction.guild?.members?.me;
        const perms = me ? channel.permissionsFor?.(me) : null;
        if (!perms?.has(PANEL_PERMS)) return say(tr.t('language.panel.noPerms', { channel: `<#${channel.id}>` }));
        // A panel nobody can use is worse than none: refuse when the bot cannot hand out roles at all.
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return say(languageErrorText(tr, new LanguageRoleError('noManageRoles')));
        try {
            await channel.send(languagePanelMessage(interaction.guildId, map));
        } catch (error) {
            logger.warn(`/language panel: could not post in ${channel.id}: ${error.message}`);
            return say(tr.t('language.panel.noPerms', { channel: `<#${channel.id}>` }));
        }
        return say(tr.t('language.panel.posted', { channel: `<#${channel.id}>` }), 'success');
    },
};
