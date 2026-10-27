// birthdayService.js

import { getGuildConfig } from './config/guildConfig.js';
import { getGuildBirthdays, setBirthday as dbSetBirthday, deleteBirthday as dbDeleteBirthday, getMonthName, getBirthdayTrackingKey } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../utils/errorHandler.js';
import { DEFAULT_TIMEZONE, localDateParts, localDateKey } from '../utils/timezone.js';

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Feb 29 birthdays are celebrated on Feb 28 in non-leap years.
function celebratedDay(year, month, day) {
  return month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
}

/** True when a stored birthday falls on the date `date` has in `timeZone` (IANA, default UTC). */
export function isBirthdayOn(birthday, date, timeZone = DEFAULT_TIMEZONE) {
  const { year, month, day } = localDateParts(date, timeZone);
  return birthday.month === month
    && celebratedDay(year, birthday.month, birthday.day) === day;
}

/**
 * Tracking data for the daily check: { announcedDate: 'YYYY-MM-DD', roles: { userId: true } }.
 * Older data is a bare { userId: true } map of members holding the birthday role.
 */
export function readBirthdayTracking(raw) {
  if (raw && typeof raw === 'object' && ('announcedDate' in raw || 'roles' in raw)) {
    return { announcedDate: raw.announcedDate ?? null, roles: { ...(raw.roles || {}) } };
  }
  const roles = {};
  for (const [userId, value] of Object.entries(raw || {})) {
    if (value) roles[userId] = true;
  }
  return { announcedDate: null, roles };
}

function guildTimeZone(config) {
  return config?.birthdayTimezone || DEFAULT_TIMEZONE;
}

export function validateBirthday(month, day) {
  
  if (typeof month !== 'number' || typeof day !== 'number') {
    return {
      isValid: false,
      error: 'Month and day must be numbers'
    };
  }

  if (month < 1 || month > 12) {
    return {
      isValid: false,
      error: 'Month must be between 1 and 12'
    };
  }

  if (day < 1 || day > 31) {
    return {
      isValid: false,
      error: 'Day must be between 1 and 31'
    };
  }

  // Validate against a leap year so Feb 29 birthdays are accepted every year.
  const date = new Date(2000, month - 1, day);
  
  if (isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return {
      isValid: false,
      error: 'Invalid date. Please check the month and day combination (e.g., February 29th only exists in leap years)'
    };
  }

  return { isValid: true };
}

export async function setBirthday(client, guildId, userId, month, day) {
  try {
    
    const validation = validateBirthday(month, day);
    if (!validation.isValid) {
      logger.warn('Birthday validation failed', {
        userId,
        guildId,
        month,
        day,
        error: validation.error
      });
      
      throw new TitanBotError(
        validation.error,
        ErrorTypes.VALIDATION,
        validation.error,
        { month, day, userId, guildId }
      );
    }

    const success = await dbSetBirthday(client, guildId, userId, month, day);
    
    if (!success) {
      throw new TitanBotError(
        'Failed to save birthday to database',
        ErrorTypes.DATABASE,
        'Failed to set your birthday. Please try again later.',
        { userId, guildId, month, day }
      );
    }

    logger.info('Birthday set successfully', {
      userId,
      guildId,
      month,
      day,
      monthName: getMonthName(month)
    });

    return {
      data: {
        month,
        day,
        monthName: getMonthName(month)
      }
    };
  } catch (error) {
    logger.error('Error in setBirthday service', {
      error: error.message,
      stack: error.stack,
      userId,
      guildId,
      month,
      day
    });
    
    throw error;
  }
}

export async function getUserBirthday(client, guildId, userId) {
  try {
    const birthdays = await getGuildBirthdays(client, guildId);
    const birthdayData = birthdays[userId];
    
    if (!birthdayData) {
      return null;
    }

    return {
      month: birthdayData.month,
      day: birthdayData.day,
      monthName: getMonthName(birthdayData.month)
    };
  } catch (error) {
    logger.error('Error in getUserBirthday service', {
      error: error.message,
      userId,
      guildId
    });
    throw error;
  }
}

export async function getAllBirthdays(client, guildId) {
  try {
    const birthdays = await getGuildBirthdays(client, guildId);
    
    if (!birthdays || Object.keys(birthdays).length === 0) {
      return [];
    }

    const sortedBirthdays = Object.entries(birthdays)
      .map(([userId, data]) => ({
        userId,
        month: data.month,
        day: data.day,
        monthName: getMonthName(data.month)
      }))
      .sort((a, b) => {
        if (a.month !== b.month) return a.month - b.month;
        return a.day - b.day;
      });

    return sortedBirthdays;
  } catch (error) {
    logger.error('Error in getAllBirthdays service', {
      error: error.message,
      guildId
    });
    throw error;
  }
}

export async function deleteBirthday(client, guildId, userId) {
  try {
    
    const birthday = await getUserBirthday(client, guildId, userId);
    
    if (!birthday) {
      return {
        status: 'not_found',
      };
    }

    const success = await dbDeleteBirthday(client, guildId, userId);
    
    if (!success) {
      throw new TitanBotError(
        'Failed to delete birthday from database',
        ErrorTypes.DATABASE,
        'Failed to remove your birthday. Please try again.',
        { userId, guildId }
      );
    }

    logger.info('Birthday removed successfully', {
      userId,
      guildId
    });

    return {
      status: 'removed',
    };
  } catch (error) {
    logger.error('Error in deleteBirthday service', {
      error: error.message,
      userId,
      guildId
    });
    throw error;
  }
}

export async function getUpcomingBirthdays(client, guildId, limit = 5) {
  try {
    const birthdays = await getGuildBirthdays(client, guildId);
    
    if (!birthdays || Object.keys(birthdays).length === 0) {
      return [];
    }

    // Day arithmetic on the guild's local calendar date, expressed as UTC midnights.
    const config = await getGuildConfig(client, guildId);
    const local = localDateParts(new Date(), guildTimeZone(config));
    const currentYear = local.year;
    const today = new Date(Date.UTC(currentYear, local.month - 1, local.day));

    const upcomingBirthdays = [];

    for (const [userId, userData] of Object.entries(birthdays)) {
      let nextBirthday = new Date(Date.UTC(currentYear, userData.month - 1, celebratedDay(currentYear, userData.month, userData.day)));

      if (nextBirthday < today) {
        nextBirthday = new Date(Date.UTC(currentYear + 1, userData.month - 1, celebratedDay(currentYear + 1, userData.month, userData.day)));
      }

      const daysUntil = Math.round((nextBirthday - today) / (1000 * 60 * 60 * 24));
      
      upcomingBirthdays.push({
        userId,
        month: userData.month,
        day: userData.day,
        monthName: getMonthName(userData.month),
        date: nextBirthday,
        daysUntil
      });
    }

    upcomingBirthdays.sort((a, b) => a.daysUntil - b.daysUntil);

    return upcomingBirthdays.slice(0, limit);
  } catch (error) {
    logger.error('Error in getUpcomingBirthdays service', {
      error: error.message,
      guildId,
      limit
    });
    throw error;
  }
}

export async function getTodaysBirthdays(client, guildId) {
  try {
    const birthdays = await getGuildBirthdays(client, guildId);
    const config = await getGuildConfig(client, guildId);
    const timeZone = guildTimeZone(config);
    const today = new Date();

    const todaysBirthdays = [];

    for (const [userId, userData] of Object.entries(birthdays)) {
      if (isBirthdayOn(userData, today, timeZone)) {
        todaysBirthdays.push({
          userId,
          month: userData.month,
          day: userData.day,
          monthName: getMonthName(userData.month)
        });
      }
    }

    return todaysBirthdays;
  } catch (error) {
    logger.error('Error in getTodaysBirthdays service', {
      error: error.message,
      guildId
    });
    throw error;
  }
}

/**
 * Daily birthday check. Each guild is handled on its own local date
 * (birthdayTimezone): the 06:00 UTC cron run falls on every local date exactly
 * once (e.g. 22:00 the same day in UTC-8, 15:00 in UTC+9), so announcements land
 * on the right day, at the first run after local midnight. The tracking key records
 * the local date already handled, so running this more often never announces twice.
 */
export async function checkBirthdays(client) {
  const now = new Date();

  if (process.env.NODE_ENV !== 'production') {
    logger.debug(`🎂 Running birthday check at ${now.toISOString()}.`);
  }

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const config = await getGuildConfig(client, guildId);
      const { birthdayChannelId, birthdayRoleId } = config;
      const timeZone = guildTimeZone(config);
      const localDate = localDateKey(now, timeZone);

      // A channel is required for announcements; the birthday role is optional.
      if (!birthdayChannelId) {
        if (process.env.NODE_ENV !== 'production') {
          logger.debug(`Skipping birthday check for ${guild.name}: Missing channel config.`);
        }
        continue;
      }

      const trackingKey = getBirthdayTrackingKey(guildId);
      const tracking = readBirthdayTracking(await client.db.get(trackingKey));
      if (tracking.announcedDate === localDate) continue;

      const channel = await guild.channels.fetch(birthdayChannelId).catch(() => null);
      if (!channel) continue;

      // Yesterday's birthday roles come off; failures stay tracked and are retried next time.
      const roles = {};
      for (const userId of Object.keys(tracking.roles)) {
        try {
          if (birthdayRoleId) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && member.roles.cache.has(birthdayRoleId)) {
              await member.roles.remove(birthdayRoleId, "Birthday role expired");
            }
          }
        } catch (error) {
          roles[userId] = true;
          logger.error(`Error removing birthday role from ${userId}:`, error);
        }
      }

      // Use the canonical birthday storage (guild:<id>:birthdays) that set/remove commands write to.
      const birthdays = (await getGuildBirthdays(client, guildId)) || {};
      const birthdayMembers = [];
      for (const [userId, userData] of Object.entries(birthdays)) {
        if (isBirthdayOn(userData, now, timeZone)) {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) {
            birthdayMembers.push(member);
            if (birthdayRoleId) roles[userId] = true;
          }
        }
      }

      // Claim the local date before announcing, so a crash or a second run can't post again.
      let claimed = false;
      await client.db.update(trackingKey, (current) => {
        if (readBirthdayTracking(current).announcedDate === localDate) return current;
        claimed = true;
        return { announcedDate: localDate, roles };
      }, {});
      if (!claimed) continue;

      if (birthdayRoleId) {
        for (const member of birthdayMembers) {
          try {
            await member.roles.add(birthdayRoleId, "Happy Birthday! 🎉");
          } catch (error) {
            logger.error(`Error adding birthday role to ${member.user.tag}:`, error);
          }
        }
      }

      if (birthdayMembers.length > 0) {
        const mentionList = birthdayMembers.map(m => m.toString()).join(', ');

        await channel.send({
          embeds: [{
            title: '🎉 Happy Birthday! 🎂',
            description: `A very happy birthday to ${mentionList}! Wishing you an amazing day! 🎈`,
            color: 0xff69b4,
            footer: { text: 'Birthday Bot' },
            timestamp: new Date()
          }]
        });
      }
    } catch (error) {
      logger.error(`Error processing birthdays for guild ${guildId}:`, error);
    }
  }
}
