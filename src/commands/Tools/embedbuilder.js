import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ComponentType,
    ChannelType,
    EmbedBuilder,
    LabelBuilder,
    RadioGroupBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';
import { fillTemplate, messageTemplate, templatesByGroup } from '../../config/messageTemplates.js';
import { EMBED_COLOURS } from '../../services/botMessageService.js';
import { localized, replyText } from '../../utils/commandLocalizations.js';

const MAX_FIELDS = 25;
const IDLE_TIMEOUT = 900_000; 

const COLOR_PRESETS = [
    { label: 'tools.embed.color.preset.primary', value: '#336699', emoji: '' },
    { label: 'tools.embed.color.preset.success', value: '#57F287', emoji: '' },
    { label: 'tools.embed.color.preset.error', value: '#ED4245', emoji: '' },
    { label: 'tools.embed.color.preset.warning', value: '#FEE75C', emoji: '' },
    { label: 'tools.embed.color.preset.info', value: '#3498DB', emoji: '' },
    { label: 'tools.embed.color.preset.blurple', value: '#5865F2', emoji: '' },
    { label: 'tools.embed.color.preset.fuchsia', value: '#EB459E', emoji: '' },
    { label: 'tools.embed.color.preset.gold', value: '#F1C40F', emoji: '' },
    { label: 'tools.embed.color.preset.white', value: '#FFFFFF', emoji: '' },
    { label: 'tools.embed.color.preset.dark', value: '#202225', emoji: '' },
    { label: 'tools.embed.color.preset.custom', value: '__custom__', emoji: '' },
];

function isValidUrl(str) {
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function isValidHex(str) {
    return /^#[0-9A-Fa-f]{6}$/.test(str);
}

function buildPreviewEmbed(state, tr) {
    const embed = new EmbedBuilder();

    if (state.title)       embed.setTitle(state.title.substring(0, 256));
    if (state.description) embed.setDescription(state.description.substring(0, 4096));

    try {
        embed.setColor(state.color || getColor('primary'));
    } catch {
        embed.setColor(getColor('primary'));
    }

    if (state.author?.name) {
        const obj = { name: state.author.name.substring(0, 256) };
        if (state.author.iconUrl && isValidUrl(state.author.iconUrl)) obj.iconURL = state.author.iconUrl;
        if (state.author.url   && isValidUrl(state.author.url))      obj.url     = state.author.url;
        embed.setAuthor(obj);
    }

    // utils/embeds.js globally patches setFooter (drops "unimportant" footers) and
    // makes setTimestamp a no-op. This builder outputs user-authored content, so
    // write footer/timestamp onto the embed data directly.
    if (state.footer?.text) {
        const footer = { text: state.footer.text.substring(0, 2048) };
        if (state.footer.iconUrl && isValidUrl(state.footer.iconUrl)) footer.icon_url = state.footer.iconUrl;
        embed.data.footer = footer;
    }

    if (state.thumbnail && isValidUrl(state.thumbnail)) embed.setThumbnail(state.thumbnail);
    if (state.image     && isValidUrl(state.image))     embed.setImage(state.image);
    if (state.timestamp) embed.data.timestamp = new Date().toISOString();

    if (state.fields.length > 0) embed.addFields(state.fields.slice(0, 25));

    if (
        !state.title &&
        !state.description &&
        state.fields.length === 0 &&
        !state.author?.name
    ) {
        embed.setDescription(tr.t('tools.embed.preview.empty'));
    }

    return embed;
}

function buildDashboardEmbed(state, tr) {
    const trunc = (str, n) =>
        str.length > n ? str.substring(0, n) + '…' : str;

    const notSet = tr.t('tools.embed.dash.notSet');
    const lines = [
        `**${tr.t('tools.embed.dash.label.title')}** › ${state.title ?`\`${trunc(state.title, 40)}\`` : `\`${notSet}\``}`,
        `**${tr.t('tools.embed.dash.label.description')}** › ${state.description ? tr.tp('tools.embed.dash.characters', state.description.length) : `\`${notSet}\``}`,
        `**${tr.t('tools.embed.dash.label.colour')}** › ${state.color ?`\`${state.color}\`` : `\`${tr.t('tools.embed.dash.default')}\``}`,
        `**${tr.t('tools.embed.dash.label.author')}** › ${state.author?.name ?`\`${trunc(state.author.name, 30)}\`` : `\`${notSet}\``}`,
        `**${tr.t('tools.embed.dash.label.footer')}** › ${state.footer?.text ?`\`${trunc(state.footer.text, 30)}\`` : `\`${notSet}\``}`,
        `**${tr.t('tools.embed.dash.label.thumbnail')}** › ${state.thumbnail ? tr.t('tools.embed.dash.set') : notSet}`,
        `**${tr.t('tools.embed.dash.label.image')}** › ${state.image ? tr.t('tools.embed.dash.set') : notSet}`,
        `**${tr.t('tools.embed.dash.label.timestamp')}** › ${state.timestamp ? tr.t('tools.embed.dash.on') : tr.t('tools.embed.dash.off')}`,
        `**${tr.t('tools.embed.dash.label.fields')}** › ${state.fields.length} / ${MAX_FIELDS}`,
    ];

    return new EmbedBuilder()
        .setTitle(tr.t('tools.embed.dash.title'))
        .setDescription(lines.join('\n'))
        .setColor(getColor('info'))
        .setFooter({ text: tr.t('tools.embed.dash.footer') });
}

function buildMainMenu(state, tr) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('eb_menu')
        .setPlaceholder(tr.t('tools.embed.menu.placeholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.template.label'))
                .setDescription(tr.t('tools.embed.menu.template.description'))
                .setValue('use_template'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.content.label'))
                .setDescription(tr.t('tools.embed.menu.content.description'))
                .setValue('edit_content'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.colour.label'))
                .setDescription(tr.t('tools.embed.menu.colour.description'))
                .setValue('set_color'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.author.label'))
                .setDescription(tr.t('tools.embed.menu.author.description'))
                .setValue('set_author'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.footer.label'))
                .setDescription(tr.t('tools.embed.menu.footer.description'))
                .setValue('set_footer'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.images.label'))
                .setDescription(tr.t('tools.embed.menu.images.description'))
                .setValue('set_images'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.addField.label', { count: state.fields.length, max: MAX_FIELDS }))
                .setDescription(tr.t('tools.embed.menu.addField.description'))
                .setValue('add_field'),
        );

    if (state.fields.length > 0) {
        select.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.editField.label'))
                .setDescription(tr.t('tools.embed.menu.editField.description'))
                .setValue('edit_field'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.menu.removeField.label'))
                .setDescription(tr.t('tools.embed.menu.removeField.description'))
                .setValue('remove_field'),
        );

        if (state.fields.length >= 2) {
            select.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(tr.t('tools.embed.menu.reorder.label'))
                    .setDescription(tr.t('tools.embed.menu.reorder.description'))
                    .setValue('reorder_fields'),
            );
        }
    }

    select.addOptions(
        new StringSelectMenuOptionBuilder()
            .setLabel(state.timestamp ? tr.t('tools.embed.menu.timestamp.off') : tr.t('tools.embed.menu.timestamp.on'))
            .setDescription(tr.t('tools.embed.menu.timestamp.description'))
            .setValue('toggle_timestamp'),
        new StringSelectMenuOptionBuilder()
            .setLabel(tr.t('tools.embed.menu.post.label'))
            .setDescription(tr.t('tools.embed.menu.post.description'))
            .setValue('post_embed'),
        new StringSelectMenuOptionBuilder()
            .setLabel(tr.t('tools.embed.menu.json.label'))
            .setDescription(tr.t('tools.embed.menu.json.description'))
            .setValue('json_export'),
        new StringSelectMenuOptionBuilder()
            .setLabel(tr.t('tools.embed.menu.reset.label'))
            .setDescription(tr.t('tools.embed.menu.reset.description'))
            .setValue('reset_all'),
    );

    return select;
}

async function refreshDashboard(interaction, state) {
    const tr = replyText(interaction);
    return await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildPreviewEmbed(state, tr), buildDashboardEmbed(state, tr)],
        components: [new ActionRowBuilder().addComponents(buildMainMenu(state, tr))],
    });
}

async function handleEditContent(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    const modal = new ModalBuilder()
        .setCustomId('eb_content')
        .setTitle(tr.t('tools.embed.content.modalTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('eb_title')
                    .setLabel(tr.t('tools.embed.content.titleLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.title || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder(tr.t('tools.embed.content.titlePlaceholder')),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('eb_description')
                    .setLabel(tr.t('tools.embed.content.descriptionLabel'))
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(state.description ? state.description.substring(0, 4000) : '')
                    .setMaxLength(4000)
                    .setRequired(false)
                    .setPlaceholder(tr.t('tools.embed.content.descriptionPlaceholder')),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_content' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    await submitted.deferUpdate().catch(() => {});

    state.title       = submitted.fields.getTextInputValue('eb_title').trim()       || null;
    state.description = submitted.fields.getTextInputValue('eb_description').trim() || null;

    await refreshDashboard(rootInteraction, state);
}

async function handleSetColor(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    await selectInteraction.deferUpdate().catch(() => {});

    const colorSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_color_pick')
        .setPlaceholder(tr.t('tools.embed.color.placeholder'))
        .addOptions(
            COLOR_PRESETS.map(c => {
                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(tr.t(c.label))
                    .setValue(c.value)
                    .setDescription(c.value !== '__custom__' ? c.value : tr.t('tools.embed.color.customDescription'));
                // setEmoji('') throws ("Expected the value to not be null"), so only set real emojis.
                if (c.emoji) option.setEmoji(c.emoji);
                return option;
            }),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('tools.embed.color.title'))
                .setDescription(
                    tr.t('tools.embed.color.intro'),
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(colorSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const colorCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_color_pick',
        time: 60_000,
        max: 1,
    });

    colorCollector.on('collect', async colorInter => {
        try {
        const picked = colorInter.values[0];

        if (picked === '__custom__') {
            const hexModal = new ModalBuilder()
                .setCustomId('eb_custom_hex')
                .setTitle(tr.t('tools.embed.color.modalTitle'))
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hex_value')
                            .setLabel(tr.t('tools.embed.color.hexLabel'))
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('#5865F2')
                            .setMaxLength(7)
                            .setMinLength(7)
                            .setRequired(true),
                    ),
                );

            const shown = await InteractionHelper.safeShowModal(colorInter, hexModal);
            if (!shown) return;

            const hexSubmit = await colorInter
                .awaitModalSubmit({
                    filter: i =>
                        i.customId === 'eb_custom_hex' && i.user.id === colorInter.user.id,
                    time: 60_000,
                })
                .catch(() => null);

            if (!hexSubmit) return;

            const hex = hexSubmit.fields.getTextInputValue('hex_value').trim();
            if (!isValidHex(hex)) {
                await replyUserError(hexSubmit, {
                    type: ErrorTypes.USER_INPUT,
                    message: tr.t('tools.embed.color.invalid', { hex }),
                });
                return;
            }

            state.color = hex;
            await hexSubmit.deferUpdate().catch(() => {});
        } else {
            state.color = picked;
            await colorInter.deferUpdate().catch(() => {});
        }

        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder color picker interaction failed:', error.message);
        }
    });
}

/** The #RRGGBB of an EMBED_COLOURS key (the dashboard's colour list), or null. */
function templateHex(key) {
    return EMBED_COLOURS.find(([k]) => k === key)?.[2] || null;
}

/**
 * "Start from a template": the same library as the dashboard Messages page
 * (config/messageTemplates.js). Group first, then the template (a select holds at most
 * 25 options). Fills title, description and colour; nothing is posted.
 */
async function handleTemplate(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    await selectInteraction.deferUpdate().catch(() => {});
    const groups = templatesByGroup();
    const groupSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_tpl_group')
        .setPlaceholder(tr.t('tools.embed.template.groupPlaceholder'))
        .addOptions(groups.slice(0, 25).map((g) => new StringSelectMenuOptionBuilder()
            .setLabel(g.label)
            .setValue(g.key)
            .setDescription(tr.tp('tools.embed.template.count', g.templates.length))));

    const pickerMessage = await selectInteraction.followUp({
        embeds: [new EmbedBuilder()
            .setTitle(tr.t('tools.embed.template.title'))
            .setDescription(tr.t('tools.embed.template.intro'))
            .setColor(getColor('info'))],
        components: [new ActionRowBuilder().addComponents(groupSelect)],
        flags: MessageFlags.Ephemeral,
    });

    // Tied to this picker's own message, so a second picker opened from the menu never
    // catches (and double-acknowledges) this one's selects.
    const filter = (id) => (i) => i.user.id === selectInteraction.user.id && i.customId === id && i.message?.id === pickerMessage?.id;
    const groupCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect, filter: filter('eb_tpl_group'), time: 60_000, max: 1,
    });

    groupCollector.on('collect', async (groupInter) => {
        try {
            const group = groups.find((g) => g.key === groupInter.values[0]);
            if (!group) return groupInter.deferUpdate().catch(() => {});
            const templateSelect = new StringSelectMenuBuilder()
                .setCustomId('eb_tpl_pick')
                .setPlaceholder(tr.t('tools.embed.template.pickPlaceholder'))
                .addOptions(group.templates.slice(0, 25).map((t) => new StringSelectMenuOptionBuilder()
                    .setLabel(t.name.slice(0, 100))
                    .setValue(t.id)));
            await groupInter.update({ components: [new ActionRowBuilder().addComponents(templateSelect)] });

            const pickCollector = rootInteraction.channel.createMessageComponentCollector({
                componentType: ComponentType.StringSelect, filter: filter('eb_tpl_pick'), time: 60_000, max: 1,
            });
            pickCollector.on('collect', async (pickInter) => {
                try {
                    const template = messageTemplate(pickInter.values[0]);
                    if (!template) return pickInter.deferUpdate().catch(() => {});
                    const filled = fillTemplate(template, { server: rootInteraction.guild?.name });
                    state.title = filled.title || null;
                    state.description = filled.text.slice(0, 4000) || null;
                    state.color = templateHex(filled.colour) || state.color;
                    await pickInter.update({
                        embeds: [new EmbedBuilder().setTitle(tr.t('tools.embed.template.loadedTitle')).setDescription(tr.t('tools.embed.template.loaded', { name: template.name })).setColor(getColor('success'))],
                        components: [],
                    });
                    await refreshDashboard(rootInteraction, state);
                } catch (error) {
                    logger.warn('Embed builder template pick failed:', error.message);
                }
            });
        } catch (error) {
            logger.warn('Embed builder template group pick failed:', error.message);
        }
    });
}

async function handleSetAuthor(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    const modal = new ModalBuilder()
        .setCustomId('eb_author')
        .setTitle(tr.t('tools.embed.author.modalTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_name')
                    .setLabel(tr.t('tools.embed.author.nameLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.name || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder(tr.t('tools.embed.author.namePlaceholder')),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_icon')
                    .setLabel(tr.t('tools.embed.author.iconLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.iconUrl || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com/icon.png'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_url')
                    .setLabel(tr.t('tools.embed.author.urlLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.url || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_author' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const name    = submitted.fields.getTextInputValue('author_name').trim();
    const iconUrl = submitted.fields.getTextInputValue('author_icon').trim();
    const url     = submitted.fields.getTextInputValue('author_url').trim();

    if (iconUrl && !isValidUrl(iconUrl)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: tr.t('tools.embed.author.badIcon'),
        });
        return;
    }
    if (url && !isValidUrl(url)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: tr.t('tools.embed.author.badUrl'),
        });
        return;
    }

    state.author = name ? { name, iconUrl: iconUrl || null, url: url || null } : null;

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleSetFooter(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    const modal = new ModalBuilder()
        .setCustomId('eb_footer')
        .setTitle(tr.t('tools.embed.footer.modalTitle'))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('footer_text')
                    .setLabel(tr.t('tools.embed.footer.textLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.footer?.text || '')
                    .setMaxLength(2048)
                    .setRequired(false)
                    .setPlaceholder(tr.t('tools.embed.footer.textPlaceholder')),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('footer_icon')
                    .setLabel(tr.t('tools.embed.footer.iconLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.footer?.iconUrl || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com/icon.png'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_footer' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const text    = submitted.fields.getTextInputValue('footer_text').trim();
    const iconUrl = submitted.fields.getTextInputValue('footer_icon').trim();

    if (iconUrl && !isValidUrl(iconUrl)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: tr.t('tools.embed.footer.badIcon'),
        });
        return;
    }

    state.footer = text ? { text, iconUrl: iconUrl || null } : null;

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleSetImages(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    await selectInteraction.deferUpdate().catch(() => {});

    const imageSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_image_pick')
        .setPlaceholder(tr.t('tools.embed.menu.placeholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.images.setThumbnail.label'))
                .setDescription(tr.t('tools.embed.images.setThumbnail.description'))
                .setValue('set_thumbnail'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.images.setImage.label'))
                .setDescription(tr.t('tools.embed.images.setImage.description'))
                .setValue('set_image'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.images.clearThumbnail.label'))
                .setDescription(tr.t('tools.embed.images.clearThumbnail.description'))
                .setValue('clear_thumbnail'),
            new StringSelectMenuOptionBuilder()
                .setLabel(tr.t('tools.embed.images.clearImage.label'))
                .setDescription(tr.t('tools.embed.images.clearImage.description'))
                .setValue('clear_image'),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('tools.embed.images.title'))
                .setDescription(tr.t('tools.embed.images.intro'))
                .addFields(
                    { name: tr.t('tools.embed.images.thumbnailField'), value: state.thumbnail ? `[${tr.t('tools.embed.images.view')}](${state.thumbnail})` : `\`${tr.t('tools.embed.dash.notSet')}\``, inline: true },
                    { name: tr.t('tools.embed.images.imageField'),     value: state.image     ? `[${tr.t('tools.embed.images.view')}](${state.image})`     : `\`${tr.t('tools.embed.dash.notSet')}\``, inline: true },
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(imageSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const imgMenuCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_image_pick',
        time: 60_000,
        max: 1,
    });

    imgMenuCollector.on('collect', async imgInter => {
        try {
        const pick = imgInter.values[0];

        if (pick === 'clear_thumbnail') {
            state.thumbnail = null;
            await imgInter.deferUpdate();
            await refreshDashboard(rootInteraction, state);
            return;
        }
        if (pick === 'clear_image') {
            state.image = null;
            await imgInter.deferUpdate();
            await refreshDashboard(rootInteraction, state);
            return;
        }

        const isThumb = pick === 'set_thumbnail';

        const urlModal = new ModalBuilder()
            .setCustomId('eb_image_url')
            .setTitle(isThumb ? tr.t('tools.embed.images.thumbnailTitle') : tr.t('tools.embed.images.imageTitle'))
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('image_url')
                        .setLabel(tr.t('tools.embed.images.urlLabel'))
                        .setStyle(TextInputStyle.Short)
                        .setValue(isThumb ? (state.thumbnail || '') : (state.image || ''))
                        .setRequired(true)
                        .setPlaceholder('https://example.com/image.png'),
                ),
            );

        const shown = await InteractionHelper.safeShowModal(imgInter, urlModal);
        if (!shown) return;

        const submitted = await imgInter
            .awaitModalSubmit({
                filter: i =>
                    i.customId === 'eb_image_url' && i.user.id === imgInter.user.id,
                time: 60_000,
            })
            .catch(() => null);

        if (!submitted) return;

        const url = submitted.fields.getTextInputValue('image_url').trim();
        if (!isValidUrl(url)) {
            await replyUserError(submitted, {
                type: ErrorTypes.USER_INPUT,
                message: tr.t('tools.embed.images.badUrl'),
            });
            return;
        }

        if (isThumb) state.thumbnail = url;
        else         state.image     = url;

        await submitted.deferUpdate().catch(() => {});
        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder image picker interaction failed:', error.message);
        }
    });
}

async function handleAddField(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    if (state.fields.length >= MAX_FIELDS) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: tr.t('tools.embed.field.max', { max: MAX_FIELDS }),
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId('eb_add_field')
        .setTitle(tr.t('tools.embed.field.addTitle'));

    const fieldNameLabel = new LabelBuilder()
        .setLabel(tr.t('tools.embed.field.nameLabel'))
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('field_name')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(256)
                .setRequired(true)
                .setPlaceholder(tr.t('tools.embed.field.namePlaceholder')),
        );

    const fieldValueLabel = new LabelBuilder()
        .setLabel(tr.t('tools.embed.field.valueLabel'))
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('field_value')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1024)
                .setRequired(true)
                .setPlaceholder(tr.t('tools.embed.field.valuePlaceholder')),
        );

    const inlineRadio = new RadioGroupBuilder()
        .setCustomId('field_inline')
        .setRequired(false)
        .addOptions([
            { label: tr.t('tools.embed.field.inlineNo'), value: 'no' },
            { label: tr.t('tools.embed.field.inlineYes'), value: 'yes' },
        ]);

    const inlineLabel = new LabelBuilder()
        .setLabel(tr.t('tools.embed.field.inlineLabel'))
        .setRadioGroupComponent(inlineRadio);

    modal.addLabelComponents(fieldNameLabel, fieldValueLabel, inlineLabel);

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'eb_add_field' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const name     = submitted.fields.getTextInputValue('field_name').trim();
    const value    = submitted.fields.getTextInputValue('field_value').trim();
    const inline   = submitted.fields.getRadioGroup('field_inline') === 'yes';

    state.fields.push({ name, value, inline });

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleEditField(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_edit_field_pick')
        .setPlaceholder(tr.t('tools.embed.field.editPlaceholder'))
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 80)}${f.value.length > 80 ? '…' : ''} · ${f.inline ? tr.t('tools.embed.field.inline') : tr.t('tools.embed.field.block')}`,
                    )
                    .setValue(String(i)),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('tools.embed.field.editTitle'))
                .setDescription(tr.t('tools.embed.field.editIntro'))
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const pickCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_edit_field_pick',
        time: 60_000,
        max: 1,
    });

    pickCollector.on('collect', async pickInter => {
        try {
        const idx   = parseInt(pickInter.values[0], 10);
        const field = state.fields[idx];
        if (!field) { await pickInter.deferUpdate(); return; }

        const modal = new ModalBuilder()
            .setCustomId('eb_edit_field_modal')
            .setTitle(tr.t('tools.embed.field.editModalTitle', { n: idx + 1 }));

        const editNameLabel = new LabelBuilder()
            .setLabel(tr.t('tools.embed.field.editNameLabel'))
            .setTextInputComponent(
                new TextInputBuilder()
                    .setCustomId('field_name')
                    .setStyle(TextInputStyle.Short)
                    .setValue(field.name)
                    .setMaxLength(256)
                    .setRequired(true),
            );

        const editValueLabel = new LabelBuilder()
            .setLabel(tr.t('tools.embed.field.editValueLabel'))
            .setTextInputComponent(
                new TextInputBuilder()
                    .setCustomId('field_value')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(field.value.substring(0, 4000))
                    .setMaxLength(1024)
                    .setRequired(true),
            );

        const editInlineRadio = new RadioGroupBuilder()
            .setCustomId('field_inline')
            .setRequired(false)
            .addOptions([
                { label: tr.t('tools.embed.field.inlineNo'), value: 'no' },
                { label: tr.t('tools.embed.field.inlineYes'), value: 'yes' },
            ]);
        
        if (field.inline) {
            editInlineRadio.setOptions([
                { label: tr.t('tools.embed.field.inlineNo'), value: 'no' },
                { label: tr.t('tools.embed.field.inlineYes'), value: 'yes', default: true },
            ]);
        }

        const editInlineLabel = new LabelBuilder()
            .setLabel(tr.t('tools.embed.field.inlineLabel'))
            .setRadioGroupComponent(editInlineRadio);

        modal.addLabelComponents(editNameLabel, editValueLabel, editInlineLabel);

        const shown = await InteractionHelper.safeShowModal(pickInter, modal);
        if (!shown) return;

        const submitted = await pickInter
            .awaitModalSubmit({
                filter: i =>
                    i.customId === 'eb_edit_field_modal' && i.user.id === pickInter.user.id,
                time: 120_000,
            })
            .catch(() => null);

        if (!submitted) return;

        const name   = submitted.fields.getTextInputValue('field_name').trim();
        const value  = submitted.fields.getTextInputValue('field_value').trim();
        const inline = submitted.fields.getRadioGroup('field_inline') === 'yes';

        state.fields[idx] = { name, value, inline };

        await submitted.deferUpdate().catch(() => {});
        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder field edit interaction failed:', error.message);
        }
    });
}

async function handleRemoveField(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_remove_field_pick')
        .setPlaceholder(tr.t('tools.embed.field.removePlaceholder'))
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 90)}${f.value.length > 90 ? '…' : ''}`,
                    )
                    .setValue(String(i)),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('tools.embed.field.removeTitle'))
                .setDescription(tr.t('tools.embed.field.removeIntro'))
                .setColor(getColor('warning')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const removeCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_remove_field_pick',
        time: 60_000,
        max: 1,
    });

    removeCollector.on('collect', async removeInter => {
        await removeInter.deferUpdate();
        const idx = parseInt(removeInter.values[0], 10);
        state.fields.splice(idx, 1);
        await refreshDashboard(rootInteraction, state);
    });
}

async function handleReorderFields(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_reorder_pick')
        .setPlaceholder(tr.t('tools.embed.field.reorderPlaceholder'))
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 90)}${f.value.length > 90 ? '…' : ''}`,
                    )
                    .setValue(String(i)),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('tools.embed.field.reorderTitle'))
                .setDescription(tr.t('tools.embed.field.reorderIntro'))
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const pickCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_reorder_pick',
        time: 60_000,
        max: 1,
    });

    pickCollector.on('collect', async pickInter => {
        await pickInter.deferUpdate();
        const sourceIdx = parseInt(pickInter.values[0], 10);

        const upBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_up')
            .setLabel(tr.t('tools.embed.field.up'))
            .setStyle(ButtonStyle.Primary)
            .setDisabled(sourceIdx === 0);

        const downBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_down')
            .setLabel(tr.t('tools.embed.field.down'))
            .setStyle(ButtonStyle.Primary)
            .setDisabled(sourceIdx === state.fields.length - 1);

        const cancelBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_cancel')
            .setLabel(tr.t('tools.embed.field.cancel'))
            .setStyle(ButtonStyle.Secondary);

        await pickInter.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('tools.embed.field.moveTitle'))
                    .setDescription(
                        tr.t('tools.embed.field.moving', { name: state.fields[sourceIdx].name, position: sourceIdx + 1, total: state.fields.length }),
                    )
                    .setColor(getColor('info')),
            ],
            components: [new ActionRowBuilder().addComponents(upBtn, downBtn, cancelBtn)],
            flags: MessageFlags.Ephemeral,
        });

        const dirCollector = rootInteraction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === selectInteraction.user.id &&
                ['eb_reorder_up', 'eb_reorder_down', 'eb_reorder_cancel'].includes(i.customId),
            time: 30_000,
            max: 1,
        });

        dirCollector.on('collect', async dirInter => {
            await dirInter.deferUpdate();
            if (dirInter.customId === 'eb_reorder_cancel') return;

            const targetIdx =
                dirInter.customId === 'eb_reorder_up' ? sourceIdx - 1 : sourceIdx + 1;

            if (targetIdx < 0 || targetIdx >= state.fields.length) return;

            const temp             = state.fields[sourceIdx];
            state.fields[sourceIdx] = state.fields[targetIdx];
            state.fields[targetIdx] = temp;

            await refreshDashboard(rootInteraction, state);
        });
    });
}

async function handlePostEmbed(selectInteraction, rootInteraction, state, guild) {
    const tr = replyText(rootInteraction);
    if (
        !state.title &&
        !state.description &&
        state.fields.length === 0 &&
        !state.author?.name
    ) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: tr.t('tools.embed.post.empty'),
        });
        return;
    }

    await selectInteraction.deferUpdate();

    const chanSelect = new ChannelSelectMenuBuilder()
        .setCustomId('eb_post_channel')
        .setPlaceholder(tr.t('tools.embed.post.channelPlaceholder'))
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle(tr.t('tools.embed.post.title'))
                .setDescription(tr.t('tools.embed.post.intro'))
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(chanSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const chanCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'eb_post_channel',
        time: 60_000,
        max: 1,
    });

    chanCollector.on('collect', async chanInter => {
        await chanInter.deferUpdate();
        const channel = chanInter.channels.first();

        if (!channel) {
            await replyUserError(chanInter, {
                type: ErrorTypes.USER_INPUT,
                message: tr.t('tools.embed.post.noChannel'),
            });
            return;
        }

        const perms = channel.permissionsFor(guild.members.me);
        if (!perms?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
            await replyUserError(chanInter, {
                type: ErrorTypes.PERMISSION,
                message: tr.t('tools.embed.post.noPermission', { channel: String(channel) }),
            });
            return;
        }

        const finalEmbed = buildPreviewEmbed(state, tr);

        if (finalEmbed.data.description === tr.t('tools.embed.preview.empty')) {
            finalEmbed.setDescription(null);
        }

        await channel.send({ embeds: [finalEmbed], allowedMentions: { parse: [] } });

        await chanInter.followUp({
            embeds: [successEmbed(tr.t('tools.embed.post.postedTitle'), tr.t('tools.embed.post.posted', { channel: String(channel) }))],
            flags: MessageFlags.Ephemeral,
        });
    });
}

async function handleJsonExport(selectInteraction, rootInteraction, state) {
    const tr = replyText(rootInteraction);
    await selectInteraction.deferUpdate();

    const previewEmbed = buildPreviewEmbed(state, tr);
    const json = JSON.stringify(previewEmbed.toJSON(), null, 2);

    if (json.length <= 3980) {
        await selectInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('tools.embed.json.title'))
                    .setDescription(`\`\`\`json\n${json}\n\`\`\``)
                    .setColor(getColor('info')),
            ],
            flags: MessageFlags.Ephemeral,
        });
    } else {
        await selectInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle(tr.t('tools.embed.json.title'))
                    .setDescription(tr.t('tools.embed.json.tooLong'))
                    .setColor(getColor('info')),
            ],
            files: [
                {
                    attachment: Buffer.from(json, 'utf-8'),
                    name: 'embed.json',
                },
            ],
            flags: MessageFlags.Ephemeral,
        });
    }
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('embedbuilder')
        .setDescription('Build an embed with a live preview and post it')
        .setDescriptionLocalizations(localized('tools.slash.embedbuilder.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferSuccess) return;

            const guild = interaction.guild;

            const state = {
                title:       null,
                description: null,
                color:       getColor('primary'),
                author:      null,
                footer:      null,
                thumbnail:   null,
                image:       null,
                timestamp:   false,
                fields:      [],
            };

            await refreshDashboard(interaction, state);

            const collector = interaction.channel.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                filter: i =>
                    i.user.id === interaction.user.id && i.customId === 'eb_menu',
                time: IDLE_TIMEOUT,
            });

            collector.on('collect', async ci => {
                try {
                    switch (ci.values[0]) {
                        case 'use_template':
                            await handleTemplate(ci, interaction, state);
                            break;
                        case 'edit_content':
                            await handleEditContent(ci, interaction, state);
                            break;
                        case 'set_color':
                            await handleSetColor(ci, interaction, state);
                            break;
                        case 'set_author':
                            await handleSetAuthor(ci, interaction, state);
                            break;
                        case 'set_footer':
                            await handleSetFooter(ci, interaction, state);
                            break;
                        case 'set_images':
                            await handleSetImages(ci, interaction, state);
                            break;
                        case 'add_field':
                            await handleAddField(ci, interaction, state);
                            break;
                        case 'edit_field':
                            await handleEditField(ci, interaction, state);
                            break;
                        case 'remove_field':
                            await handleRemoveField(ci, interaction, state);
                            break;
                        case 'reorder_fields':
                            await handleReorderFields(ci, interaction, state);
                            break;
                        case 'toggle_timestamp':
                            state.timestamp = !state.timestamp;
                            await ci.deferUpdate();
                            await refreshDashboard(interaction, state);
                            break;
                        case 'post_embed':
                            await handlePostEmbed(ci, interaction, state, guild);
                            break;
                        case 'json_export':
                            await handleJsonExport(ci, interaction, state);
                            break;
                        case 'reset_all':
                            state.title       = null;
                            state.description = null;
                            state.color       = getColor('primary');
                            state.author      = null;
                            state.footer      = null;
                            state.thumbnail   = null;
                            state.image       = null;
                            state.timestamp   = false;
                            state.fields      = [];
                            await ci.deferUpdate();
                            await refreshDashboard(interaction, state);
                            break;
                        default:
                            await ci.deferUpdate();
                    }
                } catch (error) {
                    logger.error('Error in embedbuilder collector:', error);
                    const msg =
                        error instanceof TitanBotError
                            ? error.userMessage || replyText(interaction).t('tools.embed.error.generic')
                            : replyText(interaction).t('tools.embed.error.unexpected');
                    if (!ci.replied && !ci.deferred) await ci.deferUpdate().catch(() => {});
                    await replyUserError(ci, {
                        type: ErrorTypes.UNKNOWN,
                        message: msg,
                    }).catch(() => {});
                }
            });

            collector.on('end', async (_, reason) => {
                if (reason === 'time') {
                    await InteractionHelper.safeEditReply(interaction, { components: [] }).catch(() => {});
                }
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in embedbuilder:', error);
            throw new TitanBotError(
                `embedbuilder failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                replyText(interaction).t('tools.embed.error.open'),
            );
        }
    },
};

// For tests (tests/botI18nEmbedBuilder.test.js): the builder's own screens in one language.
export { buildPreviewEmbed, buildDashboardEmbed, buildMainMenu };
