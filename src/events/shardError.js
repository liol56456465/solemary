// shardError.js — a gateway connection error (discord.js reconnects by itself). Logged as a
// warning: the message only, anything shaped like a bot token masked.

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { maskTokens } from '../utils/maskTokens.js';

export default {
    name: Events.ShardError,
    execute(error, shardId) {
        logger.warn(`Discord gateway error on shard ${shardId}: ${maskTokens(error?.message || String(error))}`);
    },
};
