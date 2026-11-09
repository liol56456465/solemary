// services.js — every service function the dashboard's module pages call, in one
// object so tests can replace any of them (createDashboard({ services })).
//
// These are the SAME functions the slash commands use: the dashboard never writes a
// store directly.

import { getGuildConfig, updateGuildConfig } from '../config/guildConfig.js';
import { getSetting, updateSettings } from '../settings/guildSettings.js';
import { applyBackup as applySettingsBackup } from '../settings/settingsBackup.js';
// Automod
import {
    getAutomodSettings, getTrustedRoleProblem, setAutomodEnabled, setAutomodMode, setChannelRuleMode, setExemptChannel,
    setHeadsUp, setJoinGateCheck, setMoodAlerts, setPanic, setRuleMode, setSecondChance, setTrusted,
} from '../automod/automodSettings.js';
import { headsUpStats } from '../automod/headsUp.js';
import { loadNativePolicies, setNativePolicy } from '../automod/nativeBridge.js';
import { automodStats } from '../automod/automodReport.js';
import { automodRuleStats } from '../automod/automodTuning.js';
import { endLockdown, getLockdownState } from '../automod/raidService.js';
import { collectOpenReviews } from '../automod/reviewQueue.js';
import { endProbation, listProbations } from '../automod/probationService.js';
import { getAutomodBacktest, startAutomodBacktest } from '../automod/backtest.js';
// Logging
import {
    getLoggingStatus, resolveLogChannel, setLogChannel, setLogChannels, setLoggingEnabled, toggleEventLogging, updateEventLogging, updateIgnoreList,
} from '../loggingService.js';
// Welcome
import { addAutoRole, getWelcomeSettings, removeAutoRole, updateWelcomeSettings } from '../welcomeService.js';
// The image store of /greet dashboard: re-posts an upload so its link keeps working.
import { resolveWelcomeImageUrl, storeWelcomeImage } from '../../utils/welcomeImageStore.js';
// Tickets, modmail, canned answers
import { getTicketSettings, updateTicketSettings } from '../ticketSettingsService.js';
import { ratingDashboard as ticketRatingDashboard } from '../ticketRatingService.js';
import { findModmailChannel, setModmailBlocked } from '../modmailService.js';
import { isBuiltInCanned, listCanned, removeCanned, saveCanned } from '../cannedService.js';
// Leveling
import {
    addLevels, getLevelingConfig, getUserLevelData, removeLevels, setLevelBoost, setLevelRoleReward, setUserLevel, updateLevelIgnoreList, updateLevelingConfig, updateVoiceXpConfig,
} from '../leveling/leveling.js';
import { syncLevelRolesForMember } from '../leveling/levelRoleSyncService.js';
// Verification
import { getVerificationSettings, updateVerificationSettings } from '../verificationSettingsService.js';
import { validateAutoVerifyCriteria } from '../verificationService.js';
// Reaction roles, giveaways
import { addPanelRole, deletePanel, getAllReactionRoleMessages, removePanelRole } from '../reactionRoleService.js';
import { endGiveawayNow, rerollGiveaway } from '../giveawayService.js';
import { getGuildGiveaways } from '../../utils/giveaways.js';
import { updateBirthdaySettings } from '../birthdayService.js';
// Counters, counting game
import { changeCounterType, getServerCounters, removeServerCounter } from '../serverstatsService.js';
import {
    activateCountingGame, disableCountingGame, getCountingGameConfig, resetCountingGame,
} from '../countingGameService.js';
// Join to create, applications
import { getConfiguration as getJoinToCreateConfiguration, removeTriggerChannel, updateChannelConfig } from '../joinToCreateService.js';
import { getApplications, getApplicationSettings } from '../../utils/database.js';
import { reviewApplicationAndNotify } from '../applicationReviewService.js';
import { updateApplicationSettings } from '../applicationSettingsService.js';
// Community
import { getCommunitySettings, updateCommunitySettings } from '../community/settingsService.js';
import { ensureCommunityCaches } from '../community/index.js';
import { getServerCat } from '../community/catService.js';
import { starboardSettingsPatch } from '../community/starboardService.js';
import { listStickies, removeSticky, setSticky } from '../community/stickyService.js';
import { createTag, deleteTag, listTags } from '../community/tagService.js';
import { decideSuggestion, getSuggestion, listOpenSuggestions } from '../community/suggestionService.js';
import { addFeed, listFeeds, removeFeed } from '../community/feedService.js';
// Commands
import {
    disableCategory, disableCommand, enableCategory, enableCommand, getCommandAccessSnapshot, resolveCommandTarget, getCategoryRegistry,
} from '../commandAccessService.js';
// Channel tools (purge, lock, unlock)
import { fixBotChannelPermissions, lockChannel, purgeChannelMessages, unlockChannel } from '../channelToolsService.js';
// Mod log
import { postModLog } from '../enforcement/enforcementService.js';
// Posting panels and creating things in Discord (shared with the commands)
import { publishTicketPanel, setupTicketSystem } from '../ticketPanelService.js';
import { publishVerificationPanel, setupVerification } from '../verificationPanelService.js';
import { postAppealPanels, postServerAppealPanel } from '../enforcement/appealPanelService.js';
import { createReactionRolePanel } from '../reactionRoleService.js';
import { createNativePoll, createPoll, endPoll, postBotMessage, startCountdownMessage } from '../botMessageService.js';
import { openPollsFor } from './pollList.js';
import { postRulesMessages, updateRulesMessages } from '../rules/rulesPost.js';
import {
    createScheduledMessage, deleteScheduledMessage, listScheduledMessages, runScheduledMessageNow, setScheduledMessagePaused, updateScheduledMessage,
} from '../scheduledMessageService.js';
import { createGiveaway, deleteGiveawayNow } from '../giveawayService.js';
import { createServerCounter } from '../serverstatsService.js';
import { setupJoinToCreate } from '../joinToCreateService.js';
import { editTag } from '../community/tagService.js';
import {
    createApplicationRole, deleteApplicationRole, listApplicationRoles, updateApplicationRole,
} from '../applicationRoleService.js';
// Bot settings (/configwizard), tools (/tools randomuser, /shorten)
import ConfigService from '../config/configService.js';
import { pickRandomMember } from '../randomMemberService.js';
import { shortenUrl } from '../urlShortener.js';
// Invite tracking (Invites page)
import { getInvitePageData, warmInviteCache } from '../invites/invitePage.js';

/** The /configwizard write (validated, history recorded): prefix, modRole, … */
function updateConfigSetting(client, guildId, key, value, actorId) {
    return ConfigService.updateSetting(client, guildId, key, value, actorId);
}

export const defaultServices = {
    getGuildConfig, updateGuildConfig, getSetting, updateSettings, applySettingsBackup,
    getAutomodSettings, getTrustedRoleProblem, setAutomodEnabled, setAutomodMode, setChannelRuleMode, setExemptChannel,
    setHeadsUp, setJoinGateCheck, setMoodAlerts, setPanic, setRuleMode, setSecondChance, setTrusted,
    loadNativePolicies, setNativePolicy, automodStats, automodRuleStats, headsUpStats,
    endLockdown, getLockdownState, collectOpenReviews, endProbation, listProbations,
    startAutomodBacktest, getAutomodBacktest,
    getLoggingStatus, resolveLogChannel, setLogChannel, setLogChannels, setLoggingEnabled, toggleEventLogging, updateEventLogging, updateIgnoreList,
    addAutoRole, getWelcomeSettings, removeAutoRole, updateWelcomeSettings, storeWelcomeImage, resolveWelcomeImageUrl,
    getTicketSettings, updateTicketSettings, ticketRatingDashboard, setModmailBlocked, findModmailChannel, isBuiltInCanned, listCanned, removeCanned, saveCanned,
    addLevels, getLevelingConfig, getUserLevelData, removeLevels, setLevelBoost, setLevelRoleReward, setUserLevel, updateLevelingConfig, updateLevelIgnoreList, updateVoiceXpConfig,
    syncLevelRolesForMember,
    getVerificationSettings, updateVerificationSettings, validateAutoVerifyCriteria,
    addPanelRole, deletePanel, getAllReactionRoleMessages, removePanelRole,
    endGiveawayNow, rerollGiveaway, getGuildGiveaways, updateBirthdaySettings,
    changeCounterType, getServerCounters, removeServerCounter,
    activateCountingGame, disableCountingGame, getCountingGameConfig, resetCountingGame,
    getJoinToCreateConfiguration, removeTriggerChannel, updateChannelConfig,
    getApplicationSettings, updateApplicationSettings, getApplications, reviewApplicationAndNotify,
    getServerCat, ensureCommunityCaches, getCommunitySettings, updateCommunitySettings, starboardSettingsPatch, listStickies, removeSticky, setSticky,
    createTag, deleteTag, listTags, addFeed, listFeeds, removeFeed, listOpenSuggestions, getSuggestion, decideSuggestion,
    disableCategory, disableCommand, enableCategory, enableCommand, getCommandAccessSnapshot, resolveCommandTarget, getCategoryRegistry,
    purgeChannelMessages, lockChannel, unlockChannel, fixBotChannelPermissions,
    postModLog,
    publishTicketPanel, setupTicketSystem, publishVerificationPanel, setupVerification, postAppealPanels, postServerAppealPanel,
    createReactionRolePanel, createGiveaway, deleteGiveawayNow, createServerCounter, setupJoinToCreate, editTag,
    createApplicationRole, deleteApplicationRole, listApplicationRoles, updateApplicationRole,
    postBotMessage, createPoll, createNativePoll, endPoll, openPollsFor, startCountdownMessage, postRulesMessages, updateRulesMessages,
    listScheduledMessages, createScheduledMessage, updateScheduledMessage, setScheduledMessagePaused, runScheduledMessageNow, deleteScheduledMessage,
    updateConfigSetting, pickRandomMember, shortenUrl,
    getInvitePageData, warmInviteCache,
};
