import './config/loadEnv.js';
// Second on purpose: exits before anything else runs if test-mode safety checks fail.
import { testMode, installGuildAllowlist, describeTestMode } from './config/testMode.js';
// Exits in the Replit workspace so it never runs next to the deployment.
import './config/instanceGuard.js';
import { Client, Collection, Events, Partials } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';

import config from './config/application.js';
import { makeCache, sweepers } from './config/clientCache.js';
import { buildIntents } from './config/intents.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import { updateAllServerCounters } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { runEnforcementExpiry } from './services/enforcement/expiryService.js';
import { runTempRoleExpiry } from './services/members/tempRoleService.js';
import { runRoleRules } from './services/members/roleRuleService.js';
import { pruneMemberEvents } from './services/members/memberInsightsService.js';
import { pruneExpiredSessions } from './services/dashboard/sessionStore.js';
import { reminderStore, runReminders } from './services/reminders/reminderService.js';
import { accountStore } from './services/accounts/accountStore.js';
import { remindStaleAppeals } from './services/enforcement/appealStatusService.js';
import { flushActivity, pruneActivity } from './services/stats/activityService.js';
import { purgeIncidentTimelines } from './services/automod/incidentTimeline.js';
import { runRetention, scheduleRetention } from './services/privacy/retentionService.js';
import { reconcileInviteLeaves, scheduleInviteLeaveReconcile } from './services/invites/inviteReconcile.js';
import { backfillLegacyRatings } from './services/ticketRatingService.js';
import { sweepChannelSurveyAccess } from './services/ticketRatingEffects.js';
import { runDueDeletions as runDueServerDataDeletions } from './services/privacy/serverDataDeletion.js';
import { checkCatGrowth } from './services/community/catService.js';
import { runVoiceXpTick } from './services/leveling/voiceXp.js';
import { query as enforcementQuery } from './services/enforcement/db.js';
import { importModmailTopicsOnce } from './services/modmailLinks.js';
import { enforcementConfig } from './config/enforcement.js';
import { expireNoContactOrders } from './services/enforcement/noContactService.js';
import { expireWatchlist } from './services/enforcement/watchlistService.js';
import { importLegacyWarnings } from './services/enforcement/warnImportService.js';
import { flushStaffMessages, postWeeklyStaffReport } from './services/staffActivityService.js';
import { snapshotMainServer } from './services/structureBackupService.js';
import { runTicketReminders } from './services/ticketReminderService.js';
import { tidyStaleAppealChannels } from './services/enforcement/staleAppealService.js';
import { postWeeklyAutomodReport } from './services/automod/automodReport.js';
import { postWeeklyDigest } from './services/stats/weeklyDigest.js';
import { postDailyAutomodDigest } from './services/automod/automodDigest.js';
import { liftCalmSlowmodes } from './services/automod/autoSlowmode.js';
import { runHeadsUpChecks } from './services/automod/automodService.js';
import { pollFeeds, pollTwitchFeeds } from './services/community/feedService.js';
import { isTwitchConfigured } from './services/community/twitchService.js';
import { runDueScheduledMessages } from './services/scheduledMessageService.js';
import { recordCronRun, recordCronSkip } from './utils/cronStats.js';
import { installHealthMonitors, postHealthReport } from './services/homeServers/healthReport.js';
import { reconcileRoleMirror } from './services/homeServers/roleMirror.js';
import { startAdminConsole } from './console/adminConsole.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import { registerOAuthRoutes } from './services/oauthVerification.js';
import { registerDashboard } from './services/dashboard/routes.js';
import { registerSite } from './services/site/site.js';
import { loadSiteContent } from './services/site/siteContent.js';
import { loadSiteImages } from './services/site/siteImages.js';
import { memberAccountsOn, registerMemberPortal } from './services/site/memberPortal.js';
import { premiumSettings, premiumStore } from './services/billing/premiumService.js';
import { loadPremiumCache, runPremiumCron, setGuildOwnerResolver, setPremiumClient } from './services/billing/premiumEffects.js';
import { finalErrorHandler } from './utils/finalErrorHandler.js';
import { setGuildLocaleResolver } from './utils/botText.js';
import { loadPersonalLanguages } from './services/personalLanguage.js';
import { corsOrigins, createCompression, createCors, createRateLimit, createReadyHandler, hsts } from './utils/httpMiddleware.js';
import { createCanonicalHostRedirect } from './utils/canonicalHost.js';
import { loadAllSettings, seedFromEnvOnce } from './services/settings/guildSettings.js';
import { runSafeTask, handleTaskError, ErrorCodes } from './utils/errorHandler.js';
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/database/schemaVersion.js';
import { refreshRates } from './services/site/exchangeRates.js';
import { startEventLoopMonitor } from './utils/eventLoopMonitor.js';


/**
 * Ratings saved in the ticket JSONB before schema v14 → ticket_ratings (O4). Every start;
 * INSERT … SELECT … ON CONFLICT DO NOTHING, so a second run adds nothing (ticketRatingService.js).
 * A failure is logged: the old surveys still work (a click copies its ticket in by itself).
 */
async function backfillTicketRatingsOnce() {
  try {
    const added = await backfillLegacyRatings();
    if (added) logger.info(`Ticket ratings: ${added} old rating(s) copied from ticket data`);
  } catch (error) {
    logger.warn(`Ticket ratings backfill skipped this start: ${error.message}`);
  }
}

class Mewvo extends Client {
  constructor() {
    super({
      // Privileged intents (Message Content, Guild Members) can be switched off from env: config/intents.js.
      intents: buildIntents(),
      // DM channels aren't cached; without this partial, DMs (modmail) never arrive.
      // Message + Reaction: reactions, edits and deletes of uncached (older) messages (starboard).
      // GuildMember + User: guildMemberRemove also fires for members that were not cached
      // (cache limits, config/clientCache.js); the handler copes with a partial member.
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.GuildMember, Partials.User],
      // No message may ping @everyone/@here or a role unless it opts in: user text
      // (prizes, reports, names) ends up in bot messages. Messages that ping a role on
      // purpose list it in their own allowedMentions (tickets, modmail, reminders, feeds).
      allowedMentions: { parse: ['users'], repliedUser: true },
      // Cache limits and sweepers (B5): config/clientCache.js says what is kept and why.
      makeCache: makeCache(),
      sweepers: sweepers(),
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
    installGuildAllowlist(this);
  }

  async start() {
    try {
      startupLog('Starting Mewvo...');
      // Event-loop lag (a blocked loop can't acknowledge interactions): warns when p99 > 500 ms.
      startEventLoopMonitor();
      if (testMode.enabled) {
        startupLog(`TEST MODE, effective config: ${JSON.stringify(describeTestMode())}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;

      // Check database status and report
      const dbStatus = this.db.getStatus();
      if (dbStatus.isDegraded) {
        logger.warn('');
        logger.warn('╔═══════════════════════════════════════════════════════╗');
        logger.warn('║ ⚠️  DATABASE RUNNING IN DEGRADED MODE                 ║');
        logger.warn('║                                                       ║');
        logger.warn('║ Connection: In-Memory Storage (PostgreSQL unavailable)║');
        logger.warn('║ Data Persistence: DISABLED - data lost on restart    ║');
        logger.warn('║ Action Required: Fix PostgreSQL and restart bot      ║');
        logger.warn('╚═══════════════════════════════════════════════════════╝');
        logger.warn('');
      } else {
        startupLog(`✅ Database Status: ${dbStatus.connectionType} (fully operational)`);
      }
      
      await this.loadSettings(dbStatus);
      // Members' own DM languages (/language without a role) into memory; a failed load is
      // logged and retried later, DMs then use the server language (never throws).
      const personal = await loadPersonalLanguages(this.db);
      startupLog(personal === null ? 'Personal languages: not loaded (retried later)' : `Personal languages loaded: ${personal}`);

      // The owner's website text and images (dashboard Owner → Website). A DB error is logged and
      // the site runs on the catalog files and default images (these never throw).
      await loadSiteContent();
      await loadSiteImages();

      startupLog('Starting web server...');
      this.startWebServer();
      
      startupLog('Loading commands...');
      await loadCommands(this);
      startupLog(`Commands loaded: ${this.commands.size}`);
      
      startupLog('Loading handlers...');
      await this.loadHandlers();
      startupLog('Handlers loaded');

      startupLog('Logging into Discord...');
      await this.login(this.config.bot.token);
      startupLog('Discord login successful');
      
      startupLog(testMode.enabled ? 'Registering slash commands in test guilds only...' : 'Registering slash commands...');
      await this.registerCommands();
      startupLog('Slash commands registration complete');
      
      const databaseMode = dbStatus.isDegraded
        ? 'Optional in-memory mode (data resets after restart)'
        : 'Connected (persistent data enabled)';
      const handlerSummary = `${this.buttons.size} buttons, ${this.selectMenus.size} menus, ${this.modals.size} modals`;
      startupLog(
        `ONLINE ✅ | ${this.commands.size} commands loaded | ${handlerSummary} | Database: ${databaseMode}`
      );

      startAdminConsole(this);
      
      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  /**
   * Per-server settings (guild_settings) into memory before anything handles events,
   * then the one-time env seed. With the database down the bot runs on env values.
   */
  async loadSettings(dbStatus) {
    if (dbStatus.isDegraded) {
      startupLog('Settings: database unavailable, running on env/default values');
      return;
    }
    try {
      const rows = await loadAllSettings();
      const seeded = rows === null ? null : await seedFromEnvOnce();
      const seededText = seeded
        ? Object.entries(seeded).map(([guildId, keys]) => `${guildId}: ${keys.length ? `seeded ${keys.length} key(s) from env` : 'nothing to seed'}`).join('; ')
        : 'not seeded';
      startupLog(rows === null
        ? 'Settings: not loaded, running on env/default values'
        : `Settings loaded: ${rows} guild row(s); ${seededText || 'no MAIN_GUILD_ID/SUPPORT_GUILD_ID'}`);
    } catch (error) {
      logger.error(`Settings could not be loaded or seeded (running on env/default values): ${error.message}`);
    }
  }

  startWebServer() {
    const app = express();
    // Don't advertise the server software in every response.
    app.disable('x-powered-by');
    // Railway (and similar hosts) sit behind one reverse proxy; trust it so req.ip is the real client.
    app.set('trust proxy', 1);

    // TEMPORARY (first deploy only, remove in the next one): shows how many proxies
    // Replit puts in front of the app, to set 'trust proxy' to the real hop count.
    let loggedProxyHops = false;
    app.use((req, res, next) => {
      if (!loggedProxyHops) {
        loggedProxyHops = true;
        startupLog(`Proxy check (first HTTP request): req.ip=${req.ip} req.ips=${JSON.stringify(req.ips)} X-Forwarded-For=${req.get('x-forwarded-for') || '(none)'}`);
      }
      next();
    });

    // Old address (e.g. *.replit.app) → same page on PUBLIC_URL, GET/HEAD only, health checks
    // and OAuth callbacks exempt. Off unless CANONICAL_REDIRECT=true (src/utils/canonicalHost.js).
    const canonicalRedirect = createCanonicalHostRedirect();
    if (canonicalRedirect.settings.enabled) {
      startupLog(`Canonical host redirect ON: GET/HEAD on other hosts → ${canonicalRedirect.settings.origin}`);
    }
    app.use(canonicalRedirect);
    const configuredPort = Number(this.config.api?.port || process.env.PORT || 3000);
    // A host-provided PORT is the only port the proxy routes to, so never drift off it.
    // Port retry is a local-dev convenience only.
    const maxPortRetryAttempts = process.env.PORT ? 0 : Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    // HTTPS only (production): 180 days, site-wide. The dashboard and /me send their own (longer) value.
    app.use(hsts());
    // gzip/brotli for pages, styles and scripts; already-compressed images are sent as they are.
    app.use(createCompression());
    // CORS only for PUBLIC_URL (+ CORS_ORIGIN), never "*"; Vary: Origin on every response.
    app.use(createCors({ origins: corsOrigins(process.env) }));
    // Per IP: pages only (static assets, /health, /ready and the dashboard are not counted).
    app.use(createRateLimit({
      windowMs: this.config.api?.rateLimit?.windowMs,
      max: this.config.api?.rateLimit?.max,
    }));

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: dbStatus.connectionType !== 'none',
          degraded: dbStatus.isDegraded,
          type: dbStatus.connectionType
        }
      };
      res.status(200).json(status);
    });

    // Public: { status: ok|degraded, schemaVersion } (200 / 503). Details only for local requests.
    // A database outage after boot (PostgreSQL known down) is "degraded" too (httpMiddleware.js).
    app.get('/ready', createReadyHandler(this, { schemaVersion: EXPECTED_SCHEMA_VERSION, schemaLabel: EXPECTED_SCHEMA_LABEL }));

    registerOAuthRoutes(app, this);
    const dashboardEnabled = registerDashboard(app, this);

    // The front website (Home, Commands, Leaderboard, About, Status, Privacy, Terms, robots.txt) at
    // the root, after every other route. Leaderboard and status read this client (site.js defaults).
    // "My record" (/me): members see their own moderation record (MEMBER_PORTAL_ENABLED, off by default),
    // and appeal their own cases in any server on the web (/me/appeals: needs this client, multi-server B4a).
    // Plans (test checkout): changes made on the website reach Discord through this client
    // (role + DM); a server's limits follow its owner's plan.
    // supportInvite: Mewvo's own Support server (the website is Mewvo's; home-only by design, B0b).
    setPremiumClient(this);
    setGuildOwnerResolver((guildId) => this.guilds.cache.get(guildId)?.ownerId || null);
    // A server that never picked a bot language gets its Discord language (utils/botText.js serverLanguage).
    setGuildLocaleResolver((guildId) => this.guilds.cache.get(guildId)?.preferredLocale || null);
    const memberPortalEnabled = registerMemberPortal(app, { dashboardEnabled, supportInvite: () => enforcementConfig.supportServerInvite, client: this });
    registerSite(app, this, { dashboardEnabled, memberPortalEnabled, memberAccountsEnabled: memberPortalEnabled && memberAccountsOn(), billingEnabled: premiumSettings().testCheckout, supportInvite: () => enforcementConfig.supportServerInvite });

    // Last: no stack traces in the browser, whatever NODE_ENV is.
    app.use(finalErrorHandler);

    const startServer = (port, attempt = 0) => {
      let hasStartedListening = false;
      const server = app.listen(port, host, () => {
        hasStartedListening = true;
        this.webServer = server;
        startupLog(`✅ Web Server running on ${host}:${port}`);
        startupLog(`Health endpoint: http://${host}:${port}/health`);
        startupLog(`Ready endpoint: http://${host}:${port}/ready`);
      });

      server.on('error', (error) => {
        const errorCode = error?.code || 'UNKNOWN_ERROR';
        const errorMessage = error?.message || 'Unknown server error';

        if (!hasStartedListening && errorCode === 'EADDRINUSE' && attempt < maxPortRetryAttempts) {
          const nextPort = port + 1;
          startupLog(`Port ${port} is already in use. Trying port ${nextPort}...`);
          setTimeout(() => startServer(nextPort, attempt + 1), 250);
          return;
        }

        if (hasStartedListening && errorCode === 'EADDRINUSE') {
          logger.warn(`Web server reported a duplicate bind warning on ${host}:${port}, but the bot remains online.`);
          return;
        }

        logger.error(`❌ Web server error on port ${port} (${errorCode}): ${errorMessage}`);

        if (!hasStartedListening) {
          process.exit(1);
        }
      });
    };

    startServer(configuredPort, 0);
  }

  setupCronJobs() {
    if (testMode.enabled && !testMode.cronEnabled) {
      startupLog('Test mode: cron jobs disabled (set TEST_ENABLE_CRON=true to enable)');
      // Legacy warn import only touches the local test database.
      const importOnly = runSafeTask('enforcement_import', async () => {
        await importLegacyWarnings(this);
        await importModmailTopicsOnce(this.guilds.cache.get(enforcementConfig.mainGuildId));
        await backfillTicketRatingsOnce();
      });
      if (this.isReady()) importOnly(); else this.once(Events.ClientReady, () => importOnly());
      return;
    }

    // A tick is skipped while the previous run of the same job is still going, so a
    // slow run (e.g. ending many giveaways) can never overlap and act twice.
    const running = new Set();
    this.cronRunning = running; // shutdown waits for this to empty
    // Each run's result goes to cronStats (the 5-minute health report shows last runs and failures).
    const exclusive = (name, fn) => runSafeTask(name, async () => {
      if (running.has(name)) {
        recordCronSkip(name);
        logger.warn(`Cron job ${name} is still running; skipping this tick`);
        return;
      }
      running.add(name);
      const startedAt = Date.now();
      try {
        await fn();
        recordCronRun(name, { ok: true, startedAt });
      } catch (error) {
        recordCronRun(name, { ok: false, startedAt, error });
        throw error;
      } finally {
        running.delete(name);
      }
    });

    cron.schedule('0 6 * * *', exclusive('birthday_check', () => checkBirthdays(this)));
    cron.schedule('* * * * *', exclusive('giveaway_check', () => checkGiveaways(this)));
    cron.schedule('*/15 * * * *', exclusive('counter_update', () => this.updateAllCounters()));
    cron.schedule('*/15 * * * *', exclusive('youtube_feeds', () => pollFeeds(this)));
    // Twitch "went live" feeds: every 2 minutes. Off (no requests) without TWITCH_CLIENT_ID/SECRET.
    if (isTwitchConfigured()) cron.schedule('*/2 * * * *', exclusive('twitch_feeds', () => pollTwitchFeeds(this)));
    else logger.info('Twitch feeds are off: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are not set');
    cron.schedule('* * * * *', exclusive('enforcement_expiry', () => runEnforcementExpiry(this)));
    cron.schedule('* * * * *', exclusive('temp_role_expiry', () => runTempRoleExpiry(this)));
    // Plans: "ends in 3 days" / "has ended" DMs, the plan cache, supporter roles (premiumEffects.js).
    cron.schedule('*/5 * * * *', exclusive('premium', () => runPremiumCron(this, premiumStore)));
    // Role rules (dashboard Members): every 10 minutes, capped changes per run (roleRuleService.js).
    cron.schedule('*/10 * * * *', exclusive('role_rules', () => runRoleRules(this)));
    // Joins/leaves for Members → Insights are kept 90 days.
    cron.schedule('30 3 * * *', exclusive('member_events_prune', () => pruneMemberEvents()), { timezone: 'UTC' });
    // Expired dashboard / My record sessions (Privacy Policy: 12 h / 1 h).
    cron.schedule('17 * * * *', exclusive('session_prune', () => pruneExpiredSessions(enforcementQuery)));
    // /remind: send what is due; sent reminders are deleted after 30 days.
    cron.schedule('* * * * *', exclusive('reminders', () => runReminders(this)));
    cron.schedule('40 3 * * *', exclusive('reminders_prune', () => reminderStore.prune()), { timezone: 'UTC' });
    // Mewvo accounts: never linked to Discord after 7 days, and old email-link tokens from before v8 (Privacy Policy).
    cron.schedule('50 3 * * *', exclusive('member_accounts_prune', () => accountStore.prune()), { timezone: 'UTC' });
    // Appeals still pending after the quiet time: one "still open" DM to the member (staff: staleAppealService).
    cron.schedule('5 * * * *', exclusive('appeal_reminders', () => remindStaleAppeals(this)));
    cron.schedule('* * * * *', exclusive('no_contact_expiry', () => expireNoContactOrders(this)));
    cron.schedule('* * * * *', exclusive('watchlist_expiry', () => expireWatchlist(this)));
    cron.schedule('* * * * *', exclusive('staff_activity_flush', () => flushStaffMessages()));
    // Messages per server per day (Dashboard → Activity), a count only; kept 400 days.
    cron.schedule('* * * * *', exclusive('activity_flush', () => flushActivity()));
    cron.schedule('45 3 * * *', exclusive('activity_prune', () => pruneActivity()), { timezone: 'UTC' });
    // Ticket ratings (O2): a closed ticket's opener loses the read-only view once the channel survey is done.
    cron.schedule('*/10 * * * *', exclusive('rating_survey_access', () => sweepChannelSurveyAccess(this)));
    // Raid timeline incidents (dashboard Raid timeline) are kept 90 days after they ended.
    cron.schedule('55 3 * * *', exclusive('incident_timeline_prune', () => purgeIncidentTimelines()), { timezone: 'UTC' });
    // ECB reference rates for the approximate złoty / real prices on /pricing (payment stays EUR/USD):
    // once now (not awaited; the bundled fallback rates are used until it lands) and daily after the
    // ECB publishes (~16:00 CET). A failure keeps the previous rates (services/site/exchangeRates.js).
    exclusive('exchange_rates', () => refreshRates())();
    cron.schedule('30 15 * * *', exclusive('exchange_rates', () => refreshRates()), { timezone: 'UTC' });
    // Retention (GDPR storage limitation): old watchlist, no-contact, raid-report and verification
    // data, daily at 03:30 UTC and once ~5 minutes after ready (privacy/retentionService.js).
    scheduleRetention({
      schedule: (expression, job, options) => cron.schedule(expression, job, options),
      wrap: exclusive,
      run: () => runRetention(this),
      whenReady: (fn) => (this.isReady() ? fn() : this.once(Events.ClientReady, () => fn())),
    });
    // Invite tracking: close join rows of members who left while Mewvo could not see it (offline,
    // database down), only when the member list is complete; daily at 05:10 UTC and once ~10
    // minutes after ready, after the invite warm-up (invites/inviteReconcile.js).
    scheduleInviteLeaveReconcile({
      schedule: (expression, job, options) => cron.schedule(expression, job, options),
      wrap: exclusive,
      run: () => reconcileInviteLeaves(this),
      whenReady: (fn) => (this.isReady() ? fn() : this.once(Events.ClientReady, () => fn())),
    });
    // Server data deletions a server owner asked for, once their 7-day grace period is over
    // (privacy/serverDataDeletion.js): daily at 04:20 UTC.
    cron.schedule('20 4 * * *', exclusive('server_data_deletions', () => runDueServerDataDeletions(this)), { timezone: 'UTC' });
    // The server cat: posts once in the level-up channel when it grows a stage (never per message).
    cron.schedule('*/5 * * * *', exclusive('server_cat_growth', () => checkCatGrowth(this)));
    // Voice XP: one counted minute per eligible member per tick (leveling/voiceXp.js); off per server by default.
    cron.schedule('* * * * *', exclusive('voice_xp', () => runVoiceXpTick(this)));
    cron.schedule('* * * * *', exclusive('auto_slowmode_lift', () => liftCalmSlowmodes(this)));
    // Automod heads-up first: act on messages still breaking the rule after the 2-minute wait (headsUp.js).
    cron.schedule('* * * * *', exclusive('automod_headsup', () => runHeadsUpChecks(this)));
    // Scheduled and recurring messages (dashboard Messages page).
    cron.schedule('* * * * *', exclusive('scheduled_messages', () => runDueScheduledMessages(this)));
    cron.schedule('*/5 * * * *', exclusive('ticket_reminders', async () => {
      await runTicketReminders(this);
      await tidyStaleAppealChannels(this);
    }));
    // Times are UTC: a daily structure snapshot, and the weekly reports on Monday morning.
    cron.schedule('0 4 * * *', exclusive('structure_snapshot', () => snapshotMainServer(this)), { timezone: 'UTC' });
    // Daily automod digest in the alerts channel (BOT_ALERTS_CHANNEL_ID, falls back to the mod log).
    cron.schedule('0 8 * * *', exclusive('automod_digest', () => postDailyAutomodDigest(this)), { timezone: 'UTC' });
    cron.schedule('0 9 * * 1', exclusive('weekly_reports', async () => {
      await postWeeklyStaffReport(this);
      await postWeeklyAutomodReport(this);
      await postWeeklyDigest(this);
    }), { timezone: 'UTC' });

    // Home servers (config/homeServers.js): the health message in the database server, edited
    // every 5 minutes; and the hourly role mirror reconcile (main -> support / database).
    installHealthMonitors(this);
    cron.schedule('*/5 * * * *', exclusive('health_report', () => postHealthReport(this)));
    cron.schedule('25 * * * *', exclusive('role_mirror', () => reconcileRoleMirror(this)));

    // Expired per-user command cooldowns are dead weight; sweep them every 10 minutes.
    cron.schedule('*/10 * * * *', runSafeTask('cooldown_sweep', () => {
      const now = Date.now();
      for (const [key, expiresAt] of this.cooldowns) {
        if (expiresAt <= now) this.cooldowns.delete(key);
      }
    }));

    // Catch up on bans/mutes that expired while the bot was offline, then import
    // legacy KV warnings (idempotent) once the gateway is ready.
    const startupEnforcement = runSafeTask('enforcement_startup', async () => {
      await runEnforcementExpiry(this);
      await runTempRoleExpiry(this);
      // Active plans into memory before limits are checked (a failure keeps everyone on Free limits until the cron).
      await loadPremiumCache(premiumStore).catch((error) => logger.warn(`Plan cache not loaded at startup: ${error.message}`));
      await importLegacyWarnings(this);
      // Modmail channels opened before modmail_links existed: linked once from their topic.
      await importModmailTopicsOnce(this.guilds.cache.get(enforcementConfig.mainGuildId));
      await backfillTicketRatingsOnce();
    });
    if (this.isReady()) {
      startupEnforcement();
    } else {
      this.once(Events.ClientReady, () => startupEnforcement());
    }
  }

  async updateAllCounters() {
    if (!this.db) {
      logger.warn('Database not available for counter updates');
      return;
    }
    // Only servers with counters (one query), stats once per server, paced (serverstatsService.js).
    try {
      const summary = await updateAllServerCounters(this);
      if (summary.errors) logger.warn(`Counter update: ${summary.servers} server(s), ${summary.errors} error(s)`);
    } catch (error) {
      logger.error(`Counter update skipped: the server list could not be read (${error.message})`);
    }
  }

  async loadHandlers() {
    startupLog('Loading handlers...');
    const handlers = [
      { path: 'events', type: 'default', required: true },
      { path: 'interactions', type: 'default', required: true }
    ];

    for (const handler of handlers) {
      try {
        startupLog(`Loading handler: ${handler.path}`);
        const module = await import(`./handlers/loaders/${handler.path}.js`);
        const loaderFn = handler.type.startsWith('named:')
          ? module[handler.type.split(':')[1]]
          : module.default;

        if (typeof loaderFn === 'function') {
          await loaderFn(this);
          startupLog(`✅ Loaded ${handler.path}`);
        } else {
          throw new Error(`Invalid loader export from ${handler.path}`);
        }
      } catch (error) {
        if (handler.required) {
          logger.error(`❌ Failed to load required handler ${handler.path}:`, error.message);
          throw error;
        } else if (error.code !== 'MODULE_NOT_FOUND') {
          logger.warn(`⚠️  Failed to load optional handler ${handler.path}:`, error.message);
        }
      }
    }
  }

  async registerCommands() {
    try {
      await registerSlashCommands(this, { clientId: this.config.bot.clientId });
    } catch (error) {
      logger.error('Error registering commands:', error);
    }
  }

  /** Once only: a second signal, or an error while stopping, gets the run already going. */
  shutdown(reason = 'UNKNOWN') {
    this.shutdownPromise ??= this.runShutdown(reason);
    return this.shutdownPromise;
  }

  // Order and timeouts: utils/gracefulShutdown.js. Loaded here, so a broken import there can
  // never stop the bot from starting.
  async runShutdown(reason) {
    shutdownLog(`Bot is shutting down (${reason})...`);
    try {
      const [{ createGracefulShutdown }, { pgDb }] = await Promise.all([
        import('./utils/gracefulShutdown.js'),
        import('./utils/postgresDatabase.js'),
      ]);
      const server = this.webServer;
      const run = createGracefulShutdown({
        log: logger,
        stopCrons: () => cron.getTasks().forEach((task) => task.stop()),
        running: () => this.cronRunning,
        destroyClient: () => this.destroy(),
        flushers: [['activity counts', flushActivity], ['staff message counts', flushStaffMessages]],
        closeHttp: () => (server ? new Promise((resolve) => server.close(() => resolve())) : null),
        closeDb: () => pgDb.disconnect(),
        exit: (code) => {
          shutdownLog(`Bot stopped (exit code ${code}).`);
          process.exit(code);
        },
      });
      await run(reason);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}

try {
  const bot = new Mewvo();
  
  const setupShutdown = () => {
    process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
    process.on('SIGINT', () => bot.shutdown('SIGINT'));
    
    process.on('uncaughtException', (error) => {
      // Process state may be corrupt after an uncaught throw; log and shut down cleanly.
      handleTaskError('uncaught_exception', error, { fatal: true });
      bot.shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason) => {
      const code = reason?.code;
      if (code === 10062 || code === 40060 || code === 50027) {
        logger.warn('Recoverable Discord interaction rejection:', reason?.message || reason);
        return;
      }
      if (reason?.message?.includes('Queue is empty')) {
        return;
      }

      // A stray rejection is a bug to fix, not a reason to take the bot down.
      // Log loudly with full context; the central task handler categorizes it.
      handleTaskError('unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)), {
        errorCode: ErrorCodes.UNHANDLED_REJECTION,
      });
    });
  };
  
  setupShutdown();
  bot.start().catch((error) => {
    logger.error('Fatal error during bot startup:', error);
    bot.shutdown('STARTUP_ERROR');
  });
} catch (error) {
  logger.error('Fatal error during bot startup:', error);
  process.exit(1);
}

export default Mewvo;
