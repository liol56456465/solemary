import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    weatherClient, currentConditions, compassPoint, truncateCoord, WeatherError,
    MET_ATTRIBUTION, OSM_ATTRIBUTION,
} from '../../services/weatherService.js';

// Shown under every forecast: CC BY 4.0 needs credit + a licence link + a note that values were changed
// (rounded / converted); the OSM licence asks for "© OpenStreetMap contributors" with a link.
export const SOURCES_LINE = 'Sources: weather data from [MET Norway](https://api.met.no/) '
    + '([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), values rounded and converted); '
    + 'location from [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL).';
export const FOOTER_TEXT = `${MET_ATTRIBUTION} · ${OSM_ATTRIBUTION}`;

const BUSY_MESSAGE = 'The weather service is busy or not responding right now. Please try again in a minute.';

export function buildWeatherEmbed(place, now, lat, lon) {
    const round = (v) => (v == null ? 'N/A' : Math.round(v));
    const windKmh = now.windSpeedMs == null ? 'N/A' : Math.round(now.windSpeedMs * 3.6);
    const dir = compassPoint(now.windFrom);
    const title = `Weather in ${place.name}${place.country ? `, ${place.country}` : ''}`.slice(0, 256);
    const embed = createEmbed({
        title,
        description: `${now.symbol.emoji ? `${now.symbol.emoji} ` : ''}${now.symbol.text}\n\n*${SOURCES_LINE}*`,
    }).addFields(
        { name: 'Temperature', value: `${round(now.temperature)}°C`, inline: true },
        { name: 'Humidity', value: `${round(now.humidity)}%`, inline: true },
        { name: 'Wind', value: `${windKmh} km/h${dir && windKmh !== 'N/A' ? ` from ${dir}` : ''}`, inline: true },
    );
    if (now.precipitationMm != null) {
        embed.addFields({ name: 'Precipitation (next hour)', value: `${now.precipitationMm} mm`, inline: true });
    }
    embed.setFooter({ text: `${FOOTER_TEXT} · ${truncateCoord(lat).toFixed(2)}, ${truncateCoord(lon).toFixed(2)}` });
    return embed;
}

export default {
    data: new SlashCommandBuilder()
        .setName("weather")
        .setDescription("Get real-time weather information for a location")
        .addStringOption((option) =>
            option
                .setName("city")
                .setDescription("The city name, e.g., 'London' or 'Tokyo'")
                .setRequired(true)
                .setMaxLength(100),
        ),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Weather interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'weather'
            });
            return;
        }

        const city = interaction.options.getString("city");

        let place;
        try {
            place = await weatherClient.geocode(city);
        } catch (error) {
            logger.warn('Weather geocoding request failed', { error: error.message, code: error.code });
            await replyUserError(interaction, { type: ErrorTypes.NETWORK, message: BUSY_MESSAGE });
            return;
        }

        if (!place) {
            await replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'Could not find that location. Please check the spelling.',
            });
            return;
        }

        let now;
        try {
            now = currentConditions(await weatherClient.forecast(place.lat, place.lon));
        } catch (error) {
            logger.warn('Weather forecast request failed', {
                error: error.message,
                code: error instanceof WeatherError ? error.code : undefined,
            });
            await replyUserError(interaction, { type: ErrorTypes.NETWORK, message: BUSY_MESSAGE });
            return;
        }
        if (!now) {
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'The weather service sent no forecast for this place.' });
            return;
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [buildWeatherEmbed(place, now, place.lat, place.lon)],
            allowedMentions: { parse: [] },
        });
        logger.info(`Weather command executed`, {
            userId: interaction.user.id,
            guildId: interaction.guildId,
        });
    },
};
