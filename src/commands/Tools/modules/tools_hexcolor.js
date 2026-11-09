import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { localized, replyText } from '../../../utils/commandLocalizations.js';
export default {
    data: new SlashCommandBuilder()
        .setName('hexcolor')
        .setDescription('Generate a random hex color with preview')
        .addStringOption(option =>
            option.setName('color')
                .setDescription('Specific hex color (e.g., #FF5733 or FF5733)')
                .setDescriptionLocalizations(localized('tools.slash.tools.sub.hexcolor.options.color'))
                .setRequired(false)),

    async execute(interaction) {
        const tr = replyText(interaction);
        await InteractionHelper.safeExecute(
            interaction,
            async () => {
                let hexColor = interaction.options.getString('color');
                let isRandom = false;

                if (!hexColor) {
                    isRandom = true;
                    hexColor = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
                } else {
                    hexColor = hexColor.replace('#', '');
                    if (!/^[0-9A-Fa-f]{3,6}$/.test(hexColor)) {
                        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('tools.hexcolor.invalid'), context: { lang: tr.lang } });
                    }

                    if (hexColor.length === 3) {
                        hexColor = hexColor.split('').map(c => c + c).join('');
                    }

                    hexColor = '#' + hexColor.toUpperCase();
                }

                const r = parseInt(hexColor.slice(1, 3), 16);
                const g = parseInt(hexColor.slice(3, 5), 16);
                const b = parseInt(hexColor.slice(5, 7), 16);

                const brightness = (r * 299 + g * 587 + b * 114) / 1000;
                const textColor = brightness > 128 ? '#000000' : '#FFFFFF';

                const colorPreviewUrl = `https://dummyimage.com/200x100/${hexColor.replace('#', '')}/${textColor.replace('#', '')}?text=${encodeURIComponent(hexColor)}`;

                const colorName = getColorName(hexColor, tr);

                const embed = successEmbed(
                    tr.t('tools.hexcolor.title'),
                    tr.t('tools.hexcolor.body', { hex: hexColor, rgb: `rgb(${r}, ${g}, ${b})`, hsl: rgbToHsl(r, g, b), name: colorName || tr.t('tools.hexcolor.custom') }),
                )
                    .setColor(hexColor)
                    .setImage(colorPreviewUrl);

                if (isRandom) {
                    embed.setFooter({ text: tr.t('tools.hexcolor.random') });
                }

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            },
            tr.t('tools.hexcolor.failed'),
            {
                autoDefer: true,
                deferOptions: { flags: MessageFlags.Ephemeral }
            }
        );
    },
};

function rgbToHsl(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }

    return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

// Known colours: hex → catalog key of the name (tools.hexcolor.color.*).
const COLOR_NAME_KEYS = {
    '#FF0000': 'tools.hexcolor.color.red',
    '#00FF00': 'tools.hexcolor.color.green',
    '#0000FF': 'tools.hexcolor.color.blue',
    '#FFFF00': 'tools.hexcolor.color.yellow',
    '#FF00FF': 'tools.hexcolor.color.magenta',
    '#00FFFF': 'tools.hexcolor.color.cyan',
    '#000000': 'tools.hexcolor.color.black',
    '#FFFFFF': 'tools.hexcolor.color.white',
    '#808080': 'tools.hexcolor.color.gray',
    '#FFA500': 'tools.hexcolor.color.orange',
    '#800080': 'tools.hexcolor.color.purple',
    '#A52A2A': 'tools.hexcolor.color.brown',
    '#FFC0CB': 'tools.hexcolor.color.pink',
    '#008000': 'tools.hexcolor.color.darkGreen',
    '#000080': 'tools.hexcolor.color.navy',
    '#FFD700': 'tools.hexcolor.color.gold',
    '#C0C0C0': 'tools.hexcolor.color.silver',
    '#FF6347': 'tools.hexcolor.color.tomato',
    '#40E0D0': 'tools.hexcolor.color.turquoise',
    '#E6E6FA': 'tools.hexcolor.color.lavender',
};

/** The colour's name in tr's language ("Close to Red" for a near one), or null when none is near. */
export function getColorName(hex, tr) {
    const code = hex.toUpperCase();
    if (COLOR_NAME_KEYS[code]) {
        return tr.t(COLOR_NAME_KEYS[code]);
    }

    const hexValue = parseInt(hex.replace('#', ''), 16);
    let closestKey = '';
    let minDistance = Infinity;

    for (const [colorHex, key] of Object.entries(COLOR_NAME_KEYS)) {
        const colorValue = parseInt(colorHex.replace('#', ''), 16);
        const distance = Math.abs(hexValue - colorValue);

        if (distance < minDistance) {
            minDistance = distance;
            closestKey = key;
        }
    }

    return minDistance < 1000000 ? tr.t('tools.hexcolor.closeTo', { color: tr.t(closestKey) }) : null;
}
