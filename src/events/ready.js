import { Events } from "discord.js";
import { logger, startupLog } from "../utils/logger.js";
import config from "../config/application.js";
import { testMode, verifyTestResources } from "../config/testMode.js";
import { reconcileReactionRoleMessages } from "../services/reactionRoleService.js";
import { reconcileTicketPanels, reconcileVerificationPanels, reconcileReactionRolePanelHealth } from "../services/panelHealthService.js";
import { reconcileLevelRoles } from "../services/leveling/levelRoleSyncService.js";
import { reconcileBannedRoles } from "../services/enforcement/bannedRoleService.js";
import { describeAutomodReadiness } from "../services/automod/automodService.js";
import { loadNoContactOrders } from "../services/enforcement/noContactService.js";
import { loadCommunityCaches } from "../services/community/index.js";
import { loadBlacklist } from "../services/owner/blacklistService.js";
import { applyStoredBotState } from "../services/owner/botStateService.js";

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      client.user.setPresence(testMode.enabled ? testMode.presence : config.bot.presence);
      // Presence and maintenance set from the dashboard Owner area (stored, so they survive restarts).
      startupLog(`Bot state: ${await applyStoredBotState(client, { testModeEnabled: testMode.enabled }).catch((error) => `not loaded (${error.message})`)}`);
      const blacklistCount = await loadBlacklist().catch((error) => {
        logger.error(`Bot blacklist could not be loaded: ${error.message}`);
        return null;
      });
      startupLog(blacklistCount == null ? "Blacklist: not loaded (database unavailable)" : `Blacklist: ${blacklistCount} active`);

      if (testMode.enabled) {
        const problems = await verifyTestResources(client);
        if (problems.length > 0) {
          logger.error("Test mode: configured resources are not in the test servers — shutting down:\n" + problems.map((p) => `  - ${p}`).join("\n"));
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
      startupLog(`Community: ${await loadCommunityCaches(client)}`);

      const reconciliationSummary = await reconcileReactionRoleMessages(client);
      startupLog(
        `Reaction role reconciliation: scanned ${reconciliationSummary.scannedMessages}, removed ${reconciliationSummary.removedMessages}, errors ${reconciliationSummary.errors}`
      );

      const ticketPanelSummary = await reconcileTicketPanels(client);
      startupLog(
        `Ticket panel health: scanned ${ticketPanelSummary.scannedGuilds} guilds, healthy ${ticketPanelSummary.healthyPanels}, deleted ${ticketPanelSummary.deletedPanels}, missing channel ${ticketPanelSummary.missingChannels}, recovered ${ticketPanelSummary.recoveredIds}, errors ${ticketPanelSummary.errors}`
      );

      const verificationPanelSummary = await reconcileVerificationPanels(client);
      startupLog(
        `Verification panel health: scanned ${verificationPanelSummary.scannedGuilds} guilds, healthy ${verificationPanelSummary.healthyPanels}, deleted ${verificationPanelSummary.deletedPanels}, missing channel ${verificationPanelSummary.missingChannels}, recovered ${verificationPanelSummary.recoveredIds}, errors ${verificationPanelSummary.errors}`
      );

      const reactionRolePanelSummary = await reconcileReactionRolePanelHealth(client);
      startupLog(
        `Reaction role panel health: scanned ${reactionRolePanelSummary.scannedPanels} panels, healthy ${reactionRolePanelSummary.healthyPanels}, deleted ${reactionRolePanelSummary.deletedPanels}, missing channel ${reactionRolePanelSummary.missingChannels}, recovered ${reactionRolePanelSummary.recoveredIds}, errors ${reactionRolePanelSummary.errors}`
      );

      const bannedRoleSummary = await reconcileBannedRoles(client).catch((error) => ({ skipped: error.message }));
      if (bannedRoleSummary.skipped) {
        const log = bannedRoleSummary.skipped === 'BANNED_ROLE_ID is not set' ? startupLog : (message) => logger.error(message);
        log(`Banned role sync skipped: ${bannedRoleSummary.skipped}`);
      } else {
        startupLog(
          `Banned role sync: scanned ${bannedRoleSummary.scanned} support members, added ${bannedRoleSummary.added}, removed ${bannedRoleSummary.removed}, errors ${bannedRoleSummary.errors}`
        );
      }

      const levelRoleSummary = await reconcileLevelRoles(client);
      startupLog(
        `Level role sync: scanned ${levelRoleSummary.scannedGuilds} guilds, pruned ${levelRoleSummary.prunedRewardEntries} stale rewards, re-awarded ${levelRoleSummary.rolesReAwarded} roles, errors ${levelRoleSummary.errors}`
      );
    } catch (error) {
      logger.error("Error in ready event:", error);
    }
  },
};