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

const MAX_FIELDS = 25;
const IDLE_TIMEOUT = 900_000; 

const COLOR_PRESETS = [
    { label: 'Primary (Blue)',        value: '#336699', emoji: '' },
    { label: 'Success (Green)',       value: '#57F287', emoji: '' },
    { label: 'Error (Red)',           value: '#ED4245', emoji: '' },
    { label: 'Warning (Yellow)',      value: '#FEE75C', emoji: '' },
    { label: 'Info (Bright blue)',    value: '#3498DB', emoji: '' },
    { label: 'Blurple (Discord)',     value: '#5865F2', emoji: '' },
    { label: 'Fuchsia',              value: '#EB459E', emoji: '' },
    { label: 'Gold',                  value: '#F1C40F', emoji: '' },
    { label: 'White',                 value: '#FFFFFF', emoji: '' },
    { label: 'Dark',                  value: '#202225', emoji: '' },
    { label: 'Custom hex',            value: '__custom__', emoji: '' },
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

function buildPreviewEmbed(state) {
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
        embed.setDescription('*(Empty. Use the menu below to add something.)*');
    }

    return embed;
}

function buildDashboardEmbed(state) {
    const trunc = (str, n) =>
        str.length > n ? str.substring(0, n) + '…' : str;

    const lines = [
        `**Title** › ${state.title ?`\`${trunc(state.title, 40)}\`` : '`Not set`'}`,
        `**Description** › ${state.description ?`${state.description.length} character(s)`: '`Not set`'}`,
        `**Colour** › ${state.color ?`\`${state.color}\`` : '`Default`'}`,
        `**Author** › ${state.author?.name ?`\`${trunc(state.author.name, 30)}\`` : '`Not set`'}`,
        `**Footer** › ${state.footer?.text ?`\`${trunc(state.footer.text, 30)}\`` : '`Not set`'}`,
        `**Thumbnail** › ${state.thumbnail ? 'Set' : 'Not set'}`,
        `**Image** › ${state.image ? 'Set' : 'Not set'}`,
        `**Timestamp** › ${state.timestamp ? 'On' : 'Off'}`,
        `**Fields** › ${state.fields.length} / ${MAX_FIELDS}`,
    ];

    return new EmbedBuilder()
        .setTitle('Embed builder')
        .setDescription(lines.join('\n'))
        .setColor(getColor('info'))
        .setFooter({ text: 'The preview above updates live · Closes after 5 min of inactivity' });
}

function buildMainMenu(state) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('eb_menu')
        .setPlaceholder('What do you want to change?')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Start from a template')
                .setDescription('Ready-made announcements, like how to appeal')
                .setValue('use_template'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit content')
                .setDescription('Set the title and description')
                .setValue('edit_content'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Colour')
                .setDescription('Pick a preset or type a hex code')
                .setValue('set_color'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Author')
                .setDescription('The name line at the top of the embed')
                .setValue('set_author'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Footer')
                .setDescription('Footer text and icon')
                .setValue('set_footer'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Images')
                .setDescription('Thumbnail or large image')
                .setValue('set_images'),
            new StringSelectMenuOptionBuilder()
                .setLabel(`Add field (${state.fields.length}/${MAX_FIELDS})`)
                .setDescription('Add a new field')
                .setValue('add_field'),
        );

    if (state.fields.length > 0) {
        select.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit field')
                .setDescription("Change a field's name, value or layout")
                .setValue('edit_field'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Remove field')
                .setDescription('Delete a field')
                .setValue('remove_field'),
        );

        if (state.fields.length >= 2) {
            select.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel('Reorder fields')
                    .setDescription('Move a field up or down')
                    .setValue('reorder_fields'),
            );
        }
    }

    select.addOptions(
        new StringSelectMenuOptionBuilder()
            .setLabel(state.timestamp ? 'Turn timestamp off' : 'Turn timestamp on')
            .setDescription('Show the time in the footer')
            .setValue('toggle_timestamp'),
        new StringSelectMenuOptionBuilder()
            .setLabel('Post embed')
            .setDescription('Send it to a channel')
            .setValue('post_embed'),
        new StringSelectMenuOptionBuilder()
            .setLabel('Show JSON')
            .setDescription('See the raw JSON')
            .setValue('json_export'),
        new StringSelectMenuOptionBuilder()
            .setLabel('Start over')
            .setDescription('Clear everything')
            .setValue('reset_all'),
    );

    return select;
}

async function refreshDashboard(interaction, state) {
    return await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildPreviewEmbed(state), buildDashboardEmbed(state)],
        components: [new ActionRowBuilder().addComponents(buildMainMenu(state))],
    });
}

async function handleEditContent(selectInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('eb_content')
        .setTitle('Edit content')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('eb_title')
                    .setLabel('Title (max 256 characters)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.title || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder('Title'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('eb_description')
                    .setLabel('Description (max 4000 characters)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(state.description ? state.description.substring(0, 4000) : '')
                    .setMaxLength(4000)
                    .setRequired(false)
                    .setPlaceholder('Text of the embed'),
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
    await selectInteraction.deferUpdate().catch(() => {});

    const colorSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_color_pick')
        .setPlaceholder('Pick a colour')
        .addOptions(
            COLOR_PRESETS.map(c => {
                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(c.label)
                    .setValue(c.value)
                    .setDescription(c.value !== '__custom__' ? c.value : 'Type your own #RRGGBB');
                // setEmoji('') throws ("Expected the value to not be null"), so only set real emojis.
                if (c.emoji) option.setEmoji(c.emoji);
                return option;
            }),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Colour')
                .setDescription(
                    'Pick a preset, or **Custom hex** to type your own `#RRGGBB`.',
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
                .setTitle('Custom colour')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hex_value')
                            .setLabel('Hex colour code')
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
                    message: `\`${hex}\` isn't a valid hex colour. Use \`#RRGGBB\` (e.g. \`#5865F2\`).`,
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
    await selectInteraction.deferUpdate().catch(() => {});
    const groups = templatesByGroup();
    const groupSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_tpl_group')
        .setPlaceholder('Pick a group')
        .addOptions(groups.slice(0, 25).map((g) => new StringSelectMenuOptionBuilder()
            .setLabel(g.label)
            .setValue(g.key)
            .setDescription(`${g.templates.length} template${g.templates.length === 1 ? '' : 's'}`)));

    const pickerMessage = await selectInteraction.followUp({
        embeds: [new EmbedBuilder()
            .setTitle('Start from a template')
            .setDescription('Pick a group, then a template. It replaces the title, text and colour. Edit it before you post: parts in [square brackets] are for you to fill in.')
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
                .setPlaceholder('Pick a template')
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
                        embeds: [new EmbedBuilder().setTitle('Template loaded').setDescription(`"${template.name}" is in the preview. Use Edit content to change it.`).setColor(getColor('success'))],
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
    const modal = new ModalBuilder()
        .setCustomId('eb_author')
        .setTitle('Author')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_name')
                    .setLabel('Author name (empty to remove)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.name || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder('Name'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_icon')
                    .setLabel('Author icon URL (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.iconUrl || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com/icon.png'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_url')
                    .setLabel('Author link URL (optional)')
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
            message: 'Author icon URL must be a valid `https://` URL.',
        });
        return;
    }
    if (url && !isValidUrl(url)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'Author link URL must be a valid `https://` URL.',
        });
        return;
    }

    state.author = name ? { name, iconUrl: iconUrl || null, url: url || null } : null;

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleSetFooter(selectInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('eb_footer')
        .setTitle('Footer')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('footer_text')
                    .setLabel('Footer text (empty to remove)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.footer?.text || '')
                    .setMaxLength(2048)
                    .setRequired(false)
                    .setPlaceholder('Footer text'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('footer_icon')
                    .setLabel('Footer icon URL (optional)')
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
            message: 'Footer icon URL must be a valid `https://` URL.',
        });
        return;
    }

    state.footer = text ? { text, iconUrl: iconUrl || null } : null;

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleSetImages(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate().catch(() => {});

    const imageSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_image_pick')
        .setPlaceholder('What do you want to change?')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Set thumbnail')
                .setDescription('Small image in the top right')
                .setValue('set_thumbnail'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set large image')
                .setDescription('Wide image at the bottom')
                .setValue('set_image'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Clear thumbnail')
                .setDescription('Remove the current thumbnail')
                .setValue('clear_thumbnail'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Clear large image')
                .setDescription('Remove the current large image')
                .setValue('clear_image'),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Images')
                .setDescription('Pick an image to set or remove.')
                .addFields(
                    { name: 'Thumbnail',    value: state.thumbnail ? `[View](${state.thumbnail})` : '`Not set`', inline: true },
                    { name: 'Large Image',  value: state.image     ? `[View](${state.image})`     : '`Not set`', inline: true },
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
            .setTitle(isThumb ? 'Thumbnail' : 'Large image')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('image_url')
                        .setLabel('Image URL')
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
                message: 'The image URL must be a public `https://` link.',
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
    if (state.fields.length >= MAX_FIELDS) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: `Embeds can have a maximum of ${MAX_FIELDS} fields.`,
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId('eb_add_field')
        .setTitle('Add field');

    const fieldNameLabel = new LabelBuilder()
        .setLabel('Field name (max 256 characters)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('field_name')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(256)
                .setRequired(true)
                .setPlaceholder('Name'),
        );

    const fieldValueLabel = new LabelBuilder()
        .setLabel('Field value (max 1024 characters)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('field_value')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1024)
                .setRequired(true)
                .setPlaceholder('Text of the field'),
        );

    const inlineRadio = new RadioGroupBuilder()
        .setCustomId('field_inline')
        .setRequired(false)
        .addOptions([
            { label: 'No, full width', value: 'no' },
            { label: 'Yes, side-by-side', value: 'yes' },
        ]);

    const inlineLabel = new LabelBuilder()
        .setLabel('Display inline?')
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
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_edit_field_pick')
        .setPlaceholder('Pick a field to edit')
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 80)}${f.value.length > 80 ? '…' : ''} · ${f.inline ? 'Inline' : 'Block'}`,
                    )
                    .setValue(String(i)),
            ),
        );

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Edit field')
                .setDescription('Pick the field you want to change.')
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
            .setTitle(`Edit field ${idx + 1}`);

        const editNameLabel = new LabelBuilder()
            .setLabel('Field name')
            .setTextInputComponent(
                new TextInputBuilder()
                    .setCustomId('field_name')
                    .setStyle(TextInputStyle.Short)
                    .setValue(field.name)
                    .setMaxLength(256)
                    .setRequired(true),
            );

        const editValueLabel = new LabelBuilder()
            .setLabel('Field value')
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
                { label: 'No, full width', value: 'no' },
                { label: 'Yes, side-by-side', value: 'yes' },
            ]);
        
        if (field.inline) {
            editInlineRadio.setOptions([
                { label: 'No, full width', value: 'no' },
                { label: 'Yes, side-by-side', value: 'yes', default: true },
            ]);
        }

        const editInlineLabel = new LabelBuilder()
            .setLabel('Display inline?')
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
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_remove_field_pick')
        .setPlaceholder('Pick a field to remove')
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
                .setTitle('Remove field')
                .setDescription('Pick the field you want to delete.')
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
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_reorder_pick')
        .setPlaceholder('Pick a field to move')
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
                .setTitle('Reorder fields')
                .setDescription('Pick a field, then move it up or down.')
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
            .setLabel('Move up')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(sourceIdx === 0);

        const downBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_down')
            .setLabel('Move down')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(sourceIdx === state.fields.length - 1);

        const cancelBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);

        await pickInter.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Move field')
                    .setDescription(
                        `Moving **${state.fields[sourceIdx].name}**. It is at position **${sourceIdx + 1}** of **${state.fields.length}**.`,
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
    if (
        !state.title &&
        !state.description &&
        state.fields.length === 0 &&
        !state.author?.name
    ) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: 'Add a title, text or a field first.',
        });
        return;
    }

    await selectInteraction.deferUpdate();

    const chanSelect = new ChannelSelectMenuBuilder()
        .setCustomId('eb_post_channel')
        .setPlaceholder('Pick a channel')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Post embed')
                .setDescription('Pick the channel to post it in.')
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
                message: "I couldn't find that channel.",
            });
            return;
        }

        const perms = channel.permissionsFor(guild.members.me);
        if (!perms?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
            await replyUserError(chanInter, {
                type: ErrorTypes.PERMISSION,
                message: `I need **Send Messages** and **Embed Links** permissions in ${channel} to post there.`,
            });
            return;
        }

        const finalEmbed = buildPreviewEmbed(state);

        if (finalEmbed.data.description === '*(Empty. Use the menu below to add something.)*') {
            finalEmbed.setDescription(null);
        }

        await channel.send({ embeds: [finalEmbed], allowedMentions: { parse: [] } });

        await chanInter.followUp({
            embeds: [successEmbed('Embed posted', `Posted in ${channel}.`)],
            flags: MessageFlags.Ephemeral,
        });
    });
}

async function handleJsonExport(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const previewEmbed = buildPreviewEmbed(state);
    const json = JSON.stringify(previewEmbed.toJSON(), null, 2);

    if (json.length <= 3980) {
        await selectInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Embed JSON')
                    .setDescription(`\`\`\`json\n${json}\n\`\`\``)
                    .setColor(getColor('info')),
            ],
            flags: MessageFlags.Ephemeral,
        });
    } else {
        await selectInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Embed JSON')
                    .setDescription('The JSON is too long to show here. See the attached file.')
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
                            ? error.userMessage || 'An error occurred.'
                            : 'An unexpected error occurred.';
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
                'Failed to open the embed builder.',
            );
        }
    },
};