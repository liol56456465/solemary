import './config/loadEnv.js';
// Second on purpose: exits before anything else runs if test-mode safety checks fail.
import { testMode, installGuildAllowlist, describeTestMode } from './config/testMode.js';
// Exits in the Replit workspace so it never runs next to the deployment.
import './config/instanceGuard.js';
import { Client, Collection, Events, GatewayIntentBits, Partials } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';

import config from './config/application.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import { getServerCounters, saveServerCounters, updateCounter } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { runEnforcementExpiry } from './services/enforcement/expiryService.js';
import { runTempRoleExpiry } from './services/members/tempRoleService.js';
import { expireNoContactOrders } from './services/enforcement/noContactService.js';
import { importLegacyWarnings } from './services/enforcement/warnImportService.js';
import { flushStaffMessages, postWeeklyStaffReport } from './services/staffActivityService.js';
import { snapshotMainServer } from './services/structureBackupService.js';
import { runTicketReminders } from './services/ticketReminderService.js';
import { tidyStaleAppealChannels } from './services/enforcement/staleAppealService.js';
import { postWeeklyAutomodReport } from './services/automod/automodReport.js';
import { postDailyAutomodDigest } from './services/automod/automodDigest.js';
import { liftCalmSlowmodes } from './services/automod/autoSlowmode.js';
import { pollFeeds } from './services/community/feedService.js';
import { startAdminConsole } from './console/adminConsole.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import { registerOAuthRoutes } from './services/oauthVerification.js';
import { registerDashboard } from './services/dashboard/routes.js';
import { finalErrorHandler } from './utils/finalErrorHandler.js';
import { isGlobalRateLimitExempt } from './services/dashboard/security.js';
import { loadAllSettings, seedFromEnvOnce } from './services/settings/guildSettings.js';
import { runSafeTask, handleTaskError, ErrorCodes } from './utils/errorHandler.js';
import pkg from '../package.json' with { type: 'json' };
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/database/schemaVersion.js';

class Meowist extends Client {
  constructor() {
    super({
      intents: [
        
        GatewayIntentBits.Guilds,                        
        GatewayIntentBits.GuildMembers,                 

        GatewayIntentBits.GuildMessages,                
        GatewayIntentBits.GuildMessageReactions,        
        GatewayIntentBits.MessageContent,               
        GatewayIntentBits.DirectMessages,

        GatewayIntentBits.GuildVoiceStates,             

        GatewayIntentBits.GuildBans,                    

        // Native Discord AutoMod executions (services/automod/nativeBridge.js); the
        // events only arrive while the bot has Manage Server.
        GatewayIntentBits.AutoModerationExecution,
      ],
      // DM channels aren't cached; without this partial, DMs (modmail) never arrive.
      // Message + Reaction: reactions, edits and deletes of uncached (older) messages (starboard).
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
      // No message may ping @everyone/@here unless it opts in: user text (track
      // titles, prizes, reports) ends up in bot messages.
      allowedMentions: { parse: ['users', 'roles'], repliedUser: true },
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
      startupLog('Starting Meowist...');
      if (testMode.enabled) {
        startupLog(`TEST MODE — effective config: ${JSON.stringify(describeTestMode())}`);
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
    const configuredPort = Number(this.config.api?.port || process.env.PORT || 3000);
    // A host-provided PORT is the only port the proxy routes to, so never drift off it.
    // Port retry is a local-dev convenience only.
    const maxPortRetryAttempts = process.env.PORT ? 0 : Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    const corsOrigin = this.config.api?.cors?.origin || '*';
    
    app.use((req, res, next) => {
      const allowedOrigins = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
      const origin = req.headers.origin;
      
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    const requestCounts = new Map();
    const windowMs = this.config.api?.rateLimit?.windowMs || 60000;
    const maxRequests = this.config.api?.rateLimit?.max || 100;
    
    app.use((req, res, next) => {
      // The dashboard has its own per-session and per-IP limits (services/dashboard/routes.js).
      if (isGlobalRateLimitExempt(req)) return next();
      const ip = req.ip;
      const now = Date.now();
      const windowStart = now - windowMs;
      
      if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
      }
      
      const times = requestCounts.get(ip).filter(t => t > windowStart);
      
      if (times.length >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      
      times.push(now);
      requestCounts.set(ip, times);
      next();
    });

    // Drop idle IPs so the map can't grow without bound on an internet-facing port.
    const requestSweep = setInterval(() => {
      const windowStart = Date.now() - windowMs;
      for (const [ip, times] of requestCounts) {
        if (!times.some((t) => t > windowStart)) requestCounts.delete(ip);
      }
    }, windowMs);
    requestSweep.unref();

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

    app.get('/ready', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: true, connectionType: 'none' };
      const isReady = this.isReady() && !dbStatus.isDegraded;

      const metrics = {
        guildCount: this.guilds?.cache?.size ?? 0,
        commandCount: this.commands?.size ?? 0,
        database: {
          mode: dbStatus.connectionType,
          degraded: dbStatus.isDegraded,
          degradedReason: dbStatus.degradedReason ?? null,
        },
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        schemaLabel: EXPECTED_SCHEMA_LABEL,
      };

      if (isReady) {
        return res.status(200).json({
          ready: true,
          message: 'Bot is ready',
          metrics,
        });
      }

      res.status(503).json({
        ready: false,
        reason: !this.isReady() ? 'Bot not Ready' : 'Database degraded',
        metrics,
      });
    });

    registerOAuthRoutes(app, this);
    registerDashboard(app, this);

    app.get('/', (req, res) => {
      res.status(200).json({ 
        message: 'Meowist System Online',
        version: pkg.version,
        timestamp: new Date().toISOString()
      });
    });

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
      const importOnly = runSafeTask('enforcement_import', () => importLegacyWarnings(this));
      if (this.isReady()) importOnly(); else this.once(Events.ClientReady, () => importOnly());
      return;
    }

    // A tick is skipped while the previous run of the same job is still going, so a
    // slow run (e.g. ending many giveaways) can never overlap and act twice.
    const running = new Set();
    const exclusive = (name, fn) => runSafeTask(name, async () => {
      if (running.has(name)) {
        logger.warn(`Cron job ${name} is still running; skipping this tick`);
        return;
      }
      running.add(name);
      try {
        await fn();
      } finally {
        running.delete(name);
      }
    });

    cron.schedule('0 6 * * *', exclusive('birthday_check', () => checkBirthdays(this)));
    cron.schedule('* * * * *', exclusive('giveaway_check', () => checkGiveaways(this)));
    cron.schedule('*/15 * * * *', exclusive('counter_update', () => this.updateAllCounters()));
    cron.schedule('*/15 * * * *', exclusive('youtube_feeds', () => pollFeeds(this)));
    cron.schedule('* * * * *', exclusive('enforcement_expiry', () => runEnforcementExpiry(this)));
    cron.schedule('* * * * *', exclusive('temp_role_expiry', () => runTempRoleExpiry(this)));
    cron.schedule('* * * * *', exclusive('no_contact_expiry', () => expireNoContactOrders(this)));
    cron.schedule('* * * * *', exclusive('staff_activity_flush', () => flushStaffMessages()));
    cron.schedule('* * * * *', exclusive('auto_slowmode_lift', () => liftCalmSlowmodes(this)));
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
    }), { timezone: 'UTC' });

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
      await importLegacyWarnings(this);
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
    
    for (const [guildId, guild] of this.guilds.cache) {
      try {
        const counters = await getServerCounters(this, guildId);
        const validCounters = [];
        const orphanedCounters = [];
        
        for (const counter of counters) {
          if (counter && counter.type && counter.channelId && counter.enabled !== false) {
            const channel = guild.channels.cache.get(counter.channelId);
            if (channel) {
              validCounters.push(counter);
              await updateCounter(this, guild, counter);
            } else {
              orphanedCounters.push(counter);
              logger.info(`Removing orphaned counter ${counter.id} (type: ${counter.type}, deleted channel: ${counter.channelId}) from guild ${guildId}`);
            }
          }
        }
        
        // Save cleaned counters if any were orphaned
        // Save cleaned counters if any were orphaned
        if (orphanedCounters.length > 0) {
          await saveServerCounters(this, guildId, validCounters);
          logger.info(`Cleaned up ${orphanedCounters.length} orphaned counter(s) from guild ${guildId} during scheduled update`);
        }
      } catch (error) {
        logger.error(`Error updating counters for guild ${guildId}:`, error);
      }
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

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Bot is shutting down (${reason})...`);
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`🛑 Graceful Shutdown Initiated (${reason})`);
    logger.info(`${'='.repeat(60)}`);

    try {
      
      logger.info('Stopping cron jobs...');
      cron.getTasks().forEach(task => task.stop());
      logger.info('✅ Cron jobs stopped');

      if (this.webServer) {
        logger.info('Closing web server...');
        await new Promise((resolve) => this.webServer.close(resolve));
        logger.info('✅ Web server closed');
      }

      // Close database connection
      // Close database connection
      if (this.db && this.db.db) {
        logger.info('Closing database connection...');
        try {
          if (this.db.db.pool) {
            await this.db.db.pool.end();
            logger.info('✅ Database connection closed');
          }
        } catch (error) {
          logger.warn('Error closing database pool:', error.message);
        }
      }

      logger.info('Destroying Discord client...');
      if (this.isReady()) {
        try {
          this.destroy();
          logger.info('✅ Discord client destroyed');
        } catch (error) {

          logger.warn('Discord client destroy warning (non-critical):', error.message);
        }
      }

      logger.info('✅ Graceful shutdown complete');
  shutdownLog('Bot stopped successfully.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}

try {
  const bot = new Meowist();
  
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

export default Meowist;
