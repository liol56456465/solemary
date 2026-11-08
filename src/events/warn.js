// warn.js — discord.js warnings (client 'warn'), into the log with tokens masked.

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { maskTokens } from '../utils/maskTokens.js';

export default {
    name: Events.Warn,
    execute(message) {
        logger.warn(`discord.js warning: ${maskTokens(String(message))}`);
    },
};
