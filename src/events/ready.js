import { Events } from "discord.js";
import { logger, startupLog } from "../utils/logger.js";
import config from "../config/application.js";
import { testMode, verifyTestResources } from "../config/testMode.js";
import { scheduleStartupJobs, STARTUP_JOB_DELAY_MS } from "../services/scheduling/startupJobs.js";
import { reconcileBannedRoles } from "../services/enforcement/bannedRoleService.js";
import { describeAutomodReadiness } from "../services/automod/automodService.js";
import { loadNoContactOrders } from "../services/enforcement/noContactService.js";
import { loadWatchlist } from "../services/enforcement/watchlistService.js";
import { loadCommunityCaches } from "../services/community/index.js";
import { loadBlacklistWithRetry } from "../services/owner/blacklistService.js";
import { applyStoredBotState } from "../services/owner/botStateService.js";

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      client.user.setPresence(testMode.enabled ? testMode.presence : config.bot.presence);
      // Presence and maintenance set from the dashboard Owner area (stored, so they survive restarts).
      startupLog(`Bot state: ${await applyStoredBotState(client, { testModeEnabled: testMode.enabled }).catch((error) => `not loaded (${error.message})`)}`);
      const blacklistCount = await loadBlacklistWithRetry({ log: (line) => logger.error(line) });
      startupLog(blacklistCount == null ? "Blacklist: not loaded yet (database unavailable; retrying in the background)" : `Blacklist: ${blacklistCount} active`);

      if (testMode.enabled) {
        const problems = await verifyTestResources(client);
        if (problems.length > 0) {
          logger.error("Test mode: configured resources are not in the test servers, shutting down:\n" + problems.map((p) => `  - ${p}`).join("\n"));
          client.destroy();
          process.exit(1);
        }
        startupLog("Test mode: category, channel, role and support invite verified in the test servers");
      }

      startupLog(`Ready! Logged in as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
      startupLog(`Loaded ${client.commands.size} commands`);
      startupLog(`Automod: ${await describeAutomodReadiness(client).catch((error) => `check failed: ${error.message}`)}`);

      const noContactCount = await loadNoContactOrders().catch((error) => {
        logger.error(`No-contact orders could not be loaded: ${error.message}`);
        return null;
      });
      startupLog(noContactCount == null ? "No-contact orders: not loaded (database unavailable)" : `No-contact orders: ${noContactCount} active`);
      const watchCount = await loadWatchlist().catch((error) => {
        logger.error(`Watchlist could not be loaded: ${error.message}`);
        return null;
      });
      startupLog(watchCount == null ? "Watchlist: not loaded (database unavailable)" : `Watchlist: ${watchCount} active`);
      startupLog(`Community: ${await loadCommunityCaches(client)}`);

      // Reaction role cleanup, panel health and the level reward role sync: one paced background
      // job about 60 s from now, only for servers with panels or rules (scheduling/startupJobs.js).
      scheduleStartupJobs(client);
      startupLog(`Startup jobs (reaction roles, panel health, level roles) start in ${STARTUP_JOB_DELAY_MS / 1000} s in the background`);

      const bannedRoleSummary = await reconcileBannedRoles(client).catch((error) => ({ skipped: error.message }));
      if (bannedRoleSummary.skipped) {
        const log = bannedRoleSummary.skipped === 'BANNED_ROLE_ID is not set' ? startupLog : (message) => logger.error(message);
        log(`Banned role sync skipped: ${bannedRoleSummary.skipped}`);
      } else {
        startupLog(
          `Banned role sync: scanned ${bannedRoleSummary.scanned} support members, added ${bannedRoleSummary.added}, removed ${bannedRoleSummary.removed}, errors ${bannedRoleSummary.errors}`
        );
      }
    } catch (error) {
      logger.error("Error in ready event:", error);
    }
  },
};