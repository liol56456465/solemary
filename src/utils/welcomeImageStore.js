// welcomeImageStore.js
//
// Discord attachment URLs are signed and stop working after about a day, so an
// image uploaded in the greet dashboard can't be saved as a plain URL. Instead the
// upload is re-posted to a storage channel and the message is remembered as
// { channelId, messageId, url }. When a welcome/goodbye is sent, the message is
// fetched again for a fresh attachment URL (cached for an hour).
//
// Storage channel: the guild's audit log channel (staff-only, already configured
// by most servers), else the channel /greet dashboard was opened in. The web
// dashboard (services/dashboard/modules/welcome.js) uses the audit log channel only.

import { PermissionFlagsBits } from 'discord.js';
import { logger } from './logger.js';

const REFRESH_CACHE_MS = 60 * 60 * 1000;
const refreshCache = new Map();
const warnedLegacyUrls = new Set();

/**
 * True when a Discord CDN attachment URL carries an `ex` expiry (hex unix seconds)
 * that has passed. Other URLs never count as expired.
 */
export function isExpiredDiscordCdnUrl(url, now = Date.now()) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)(discordapp\.(com|net)|discord\.com)$/.test(parsed.hostname)) return false;
    const ex = parsed.searchParams.get('ex');
    if (!ex || !/^[0-9a-f]+$/i.test(ex)) return false;
    return parseInt(ex, 16) * 1000 <= now;
  } catch {
    return false;
  }
}

/**
 * Re-posts an uploaded image to the first usable storage channel. `attachment` is a
 * Discord attachment ({ url, name }) from /greet, or the checked bytes ({ data, name })
 * from the web dashboard. Returns { channelId, messageId, url } or null when no channel
 * accepted it.
 */
export async function storeWelcomeImage(guild, attachment, candidateChannelIds, label) {
  const me = guild.members.me;
  const tried = new Set();
  for (const channelId of candidateChannelIds) {
    if (!channelId || tried.has(channelId)) continue;
    tried.add(channelId);

    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) continue;

    try {
      const message = await channel.send({
        content: `Stored ${label} image for the welcome & goodbye settings. Please keep this message: the ${label} message loads its image from here.`,
        files: [{ attachment: attachment.data ?? attachment.url, name: attachment.name || 'image.png' }],
        allowedMentions: { parse: [] },
      });
      const url = message.attachments.first()?.url;
      if (url) {
        return { channelId: channel.id, messageId: message.id, url };
      }
    } catch (error) {
      logger.warn(`[Welcome] Could not store ${label} image in channel ${channelId} (guild ${guild.id}): ${error.message}`);
    }
  }
  return null;
}

/**
 * Image URL to use for a welcome/goodbye embed. `ref` is only used while it still
 * belongs to the configured URL, so a URL changed elsewhere always wins.
 */
export async function resolveWelcomeImageUrl(client, configuredUrl, ref, { guildId, label }) {
  if (!configuredUrl) return null;

  if (ref?.channelId && ref?.messageId && ref.url === configuredUrl) {
    const cacheKey = `${ref.channelId}:${ref.messageId}`;
    const cached = refreshCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    try {
      const channel = await client.channels.fetch(ref.channelId);
      const message = await channel.messages.fetch(ref.messageId);
      const url = message.attachments.first()?.url;
      if (url) {
        refreshCache.set(cacheKey, { url, expiresAt: Date.now() + REFRESH_CACHE_MS });
        return url;
      }
    } catch (error) {
      logger.warn(`[Welcome] Could not refresh stored ${label} image for guild ${guildId} (message ${ref.messageId} in ${ref.channelId}): ${error.message}. Using the saved URL, which may have expired.`);
      return configuredUrl;
    }
    logger.warn(`[Welcome] Stored ${label} image message ${ref.messageId} for guild ${guildId} has no attachment. Using the saved URL, which may have expired.`);
    return configuredUrl;
  }

  // Images saved before this change are plain CDN URLs that can't be refreshed.
  if (isExpiredDiscordCdnUrl(configuredUrl) && !warnedLegacyUrls.has(`${guildId}:${label}`)) {
    warnedLegacyUrls.add(`${guildId}:${label}`);
    logger.warn(`[Welcome] The ${label} image for guild ${guildId} is an expired Discord attachment URL and can't be refreshed; upload it again in /greet dashboard.`);
  }
  return configuredUrl;
}
