import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLogChannel, LOG_DESTINATIONS, TICKET_LOG_KEYS } from '../src/services/loggingService.js';
import { LOG_CHANNEL_KEYS } from '../src/utils/schemas.js';

test('log channels per kind: own channel when set, else the main log; dashboard/applications/reports never fall back', () => {
    const config = { logging: { channels: { audit: '1', members: '2', dashboard: '3' } } };
    assert.ok(['moderation', 'members', 'messages', 'server', 'community', 'dashboard'].every((d) => LOG_DESTINATIONS.includes(d)));
    assert.equal(resolveLogChannel(config, 'members'), '2');
    assert.equal(resolveLogChannel(config, 'messages'), '1');
    assert.equal(resolveLogChannel(config, 'dashboard'), '3');
    assert.equal(resolveLogChannel({ logging: { channels: { audit: '1' } } }, 'dashboard'), null);
    assert.equal(resolveLogChannel({ logging: { channels: { audit: '1' } } }, 'reports'), null);
});

// Bug (owner, 2026-11-13: "I selected the website log channel but it still sends in the old one"):
// the config normalizer rebuilt logging.channels with audit/applications/reports only, so every
// per-kind channel was dropped on save and on read. Every destination must survive both.
test('every log destination survives normalize + validate (the save and read path of guild config)', async () => {
    const { normalizeGuildConfig, validateGuildConfigOrThrow } = await import('../src/utils/schemas.js');
    const { GUILD_CONFIG_DEFAULTS } = await import('../src/config/guild/guildConfigDefaults.js');
    const channels = Object.fromEntries(LOG_CHANNEL_KEYS.map((d, i) => [d, `70000000000000000${i}`]));
    const saved = validateGuildConfigOrThrow(normalizeGuildConfig({ logging: { enabled: true, channels } }, GUILD_CONFIG_DEFAULTS));
    const read = normalizeGuildConfig(saved, GUILD_CONFIG_DEFAULTS);
    for (const d of LOG_CHANNEL_KEYS) {
        assert.equal(saved.logging.channels[d], channels[d], `saved: ${d}`);
        assert.equal(read.logging.channels[d], channels[d], `read: ${d}`);
        assert.equal(resolveLogChannel(read, d), channels[d], `resolved: ${d}`);
    }
    // Clearing one keeps the others; the legacy flat main channel still migrates.
    const cleared = normalizeGuildConfig({ logging: { channels: { ...channels, dashboard: null } } }, GUILD_CONFIG_DEFAULTS);
    assert.equal(cleared.logging.channels.dashboard, null);
    assert.equal(cleared.logging.channels.members, channels.members);
    assert.equal(normalizeGuildConfig({ logChannelId: '700000000000000099' }, GUILD_CONFIG_DEFAULTS).logging.channels.audit, '700000000000000099');
});

// Owner (2026-11-14): "make it so all log channels are up to date": ticket logs and transcripts are set
// on the Logging page with the others, but stay stored in their ticket keys (the ticket code reads those).
test('ticket log kinds: listed, resolved from the ticket keys, never the main log', () => {
    assert.ok(LOG_DESTINATIONS.includes('tickets') && LOG_DESTINATIONS.includes('transcripts'));
    assert.deepEqual(TICKET_LOG_KEYS, { tickets: 'ticketLogsChannelId', transcripts: 'ticketTranscriptChannelId' });
    const config = { logging: { channels: { audit: '1' } }, ticketLogsChannelId: '5', ticketTranscriptChannelId: null };
    assert.equal(resolveLogChannel(config, 'tickets'), '5');
    assert.equal(resolveLogChannel(config, 'transcripts'), null);
});

