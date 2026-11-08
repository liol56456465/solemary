import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botText } from '../../utils/botText.js';
import { localized, publicText, replyText } from '../Core/modules/commandText.js';
import {
    weatherClient, currentConditions, compassPoint, truncateCoord, WeatherError,
    MET_ATTRIBUTION, OSM_ATTRIBUTION,
} from '../../services/weatherService.js';

// Shown under every forecast: CC BY 4.0 needs credit + a licence link + a note that values were changed
// (rounded / converted); the OSM licence asks for "© OpenStreetMap contributors" with a link.
// The English text (catalog key utility.weather.sources; translations keep the same links).
export const SOURCES_LINE = botText('en').t('utility.weather.sources');
export const FOOTER_TEXT = `${MET_ATTRIBUTION} · ${OSM_ATTRIBUTION}`;

/** The forecast embed; `tr` (botText) picks the language, English by default. */
export function buildWeatherEmbed(place, now, lat, lon, tr = botText('en')) {
    const na = tr.t('utility.weather.notAvailable');
    const round = (v) => (v == null ? na : Math.round(v));
    const windKmh = now.windSpeedMs == null ? null : Math.round(now.windSpeedMs * 3.6);
    const dir = compassPoint(now.windFrom);
    const wind = windKmh == null ? tr.t('utility.weather.windValue', { speed: na })
        : dir ? tr.t('utility.weather.windFrom', { speed: windKmh, direction: dir }) : tr.t('utility.weather.windValue', { speed: windKmh });
    const title = tr.t('utility.weather.title', { place: `${place.name}${place.country ? `, ${place.country}` : ''}` }).slice(0, 256);
    const embed = createEmbed({
        title,
        description: `${now.symbol.emoji ? `${now.symbol.emoji} ` : ''}${now.symbol.text}\n\n*${tr.t('utility.weather.sources')}*`,
    }).addFields(
        { name: tr.t('utility.weather.temperature'), value: `${round(now.temperature)}°C`, inline: true },
        { name: tr.t('utility.weather.humidity'), value: `${round(now.humidity)}%`, inline: true },
        { name: tr.t('utility.weather.wind'), value: wind, inline: true },
    );
    if (now.precipitationMm != null) {
        embed.addFields({ name: tr.t('utility.weather.precipitation'), value: `${now.precipitationMm} mm`, inline: true });
    }
    embed.setFooter({ text: `${FOOTER_TEXT} · ${truncateCoord(lat).toFixed(2)}, ${truncateCoord(lon).toFixed(2)}` });
    return embed;
}

export default {
    data: new SlashCommandBuilder()
        .setName("weather")
        .setDescription("Get real-time weather information for a location")
        .setDescriptionLocalizations(localized('utility.slash.weather.description'))
        .addStringOption((option) =>
            option
                .setName("city")
                .setDescription("The city name, e.g., 'London' or 'Tokyo'")
                .setDescriptionLocalizations(localized('utility.slash.weather.options.city'))
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
        // The forecast is posted in the channel (server's language); errors are private (user's language).
        const tr = publicText(interaction);
        const own = replyText(interaction);
        const BUSY_MESSAGE = own.t('utility.weather.busy');

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
                message: own.t('utility.weather.notFound'),
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
            await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: own.t('utility.weather.noForecast') });
            return;
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [buildWeatherEmbed(place, now, place.lat, place.lon, tr)],
            allowedMentions: { parse: [] },
        });
        logger.info(`Weather command executed`, {
            userId: interaction.user.id,
            guildId: interaction.guildId,
        });
    },
};
