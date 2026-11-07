// database.js — /database: owner-only, read-only lookups across the whole database.
//
// Registered as a guild command in OWNER_TOOLS_GUILD_ID only (config/ownerTools.js), never in
// the main server, the support server or globally. Only OWNER_IDS, only in that server: checked
// by the gate (commandGate.js, scope 'owner') and again here. Slash only (no prefix: a prefix
// reply would be public). Every reply is ephemeral and mentions nobody.
//
// The queries are in services/owner/databaseLookup.js (fixed parameterized SELECTs, secrets
// shown as "(hidden)"). Each use is logged (who, subcommand, query), never the results.

import crypto from 'node:crypto';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { canUseOwnerTools, OWNER_TOOLS_REFUSAL } from '../../utils/commandGate.js';
import { query } from '../../services/enforcement/db.js';
import { LookupInputError, createDatabaseLookup, lookupPages, paginate } from '../../services/owner/databaseLookup.js';
import { LOOKUP_DB_ERROR, lookupMessage } from '../../handlers/databaseLookupView.js';

const SUBCOMMANDS = {
    user: { option: 'user', run: (lookup, input) => lookup.user(input) },
    server: { option: 'server_id', run: (lookup, input) => lookup.server(input) },
    case: { option: 'code', run: (lookup, input) => lookup.caseByCode(input) },
    stats: { option: null, run: (lookup) => lookup.stats() },
    search: { option: 'text', run: (lookup, input) => lookup.search(input) },
};

let defaultLookup = null;
function getDefaultLookup() {
    defaultLookup ??= createDatabaseLookup({ query });
    return defaultLookup;
}

export function newNonce() {
    return crypto.randomBytes(6).toString('hex');
}

/** What the log line records about the query: the input as typed, cut to 100 characters. */
export function loggedQuery(input) {
    return input == null ? null : String(input).replace(/\s+/g, ' ').slice(0, 100);
}

/**
 * Runs /database. Dependencies are injectable for tests.
 */
export async function runDatabaseCommand(interaction, {
    lookup = getDefaultLookup(),
    store = lookupPages,
    log = logger,
    canUse = canUseOwnerTools,
    nonce = newNonce,
} = {}) {
    const userId = interaction.user?.id;
    if (interaction._isPrefixCommand || !canUse({ guildId: interaction.guildId, userId })) {
        log.warn('Refused /database', { event: 'owner.database.refused', userId, guildId: interaction.guildId });
        await InteractionHelper.safeReply(interaction, {
            content: OWNER_TOOLS_REFUSAL, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        });
        return;
    }

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    const subcommand = interaction.options.getSubcommand();
    const spec = SUBCOMMANDS[subcommand];
    if (!spec) {
        await InteractionHelper.safeEditReply(interaction, { content: 'Unknown subcommand.', allowedMentions: { parse: [] } });
        return;
    }
    const input = spec.option ? interaction.options.getString(spec.option, true) : null;
    log.info(`Owner /database ${subcommand} by ${userId}`, {
        event: 'owner.database.lookup', userId, username: interaction.user?.username, guildId: interaction.guildId,
        subcommand, query: loggedQuery(input),
    });

    let result;
    try {
        result = await spec.run(lookup, input);
    } catch (error) {
        if (error instanceof LookupInputError) {
            await InteractionHelper.safeEditReply(interaction, { content: error.message, allowedMentions: { parse: [] } });
            return;
        }
        log.error(`Owner /database ${subcommand} failed: ${error?.message}`, { event: 'owner.database.error', userId, subcommand, code: error?.code });
        await InteractionHelper.safeEditReply(interaction, { content: LOOKUP_DB_ERROR, embeds: [], components: [], allowedMentions: { parse: [] } });
        return;
    }

    const { title, pages } = paginate(result);
    const id = nonce();
    store.put(id, { ownerId: userId, title, pages });
    await InteractionHelper.safeEditReply(interaction, lookupMessage({ title, pages }, 0, { ownerId: userId, nonce: id }));
}

export default {
    // OWNER_TOOLS_GUILD_ID only; see commandLoader.js (sets.owner) and commandGate.js.
    scope: 'owner',
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('database')
        .setDescription('Owner only: read-only lookups across the whole database')
        .addSubcommand((sub) => sub
            .setName('user')
            .setDescription('Everything stored about one user, in every server')
            .addStringOption((option) => option.setName('user').setDescription('User ID or @mention').setRequired(true).setMaxLength(30)))
        .addSubcommand((sub) => sub
            .setName('server')
            .setDescription('Settings, module states, row counts and open appeals of one server')
            .addStringOption((option) => option.setName('server_id').setDescription('Server ID').setRequired(true).setMaxLength(20)))
        .addSubcommand((sub) => sub
            .setName('case')
            .setDescription('One case with its edits, evidence, notes and appeals')
            .addStringOption((option) => option.setName('code').setDescription('Case code').setRequired(true).setMaxLength(7)))
        .addSubcommand((sub) => sub
            .setName('stats')
            .setDescription('Row counts per table, schema version, size, oldest and newest rows'))
        .addSubcommand((sub) => sub
            .setName('search')
            .setDescription('Search case codes, reasons and stored usernames')
            .addStringOption((option) => option.setName('text').setDescription('Text to look for').setRequired(true).setMinLength(2).setMaxLength(100))),

    async execute(interaction) {
        return runDatabaseCommand(interaction);
    },
};
