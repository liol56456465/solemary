import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLogChannel, LOG_DESTINATIONS } from '../src/services/loggingService.js';

test('log channels per kind: own channel when set, else the main log; dashboard/applications/reports never fall back', () => {
    const config = { logging: { channels: { audit: '1', members: '2', dashboard: '3' } } };
    assert.ok(['moderation', 'members', 'messages', 'server', 'community', 'dashboard'].every((d) => LOG_DESTINATIONS.includes(d)));
    assert.equal(resolveLogChannel(config, 'members'), '2');
    assert.equal(resolveLogChannel(config, 'messages'), '1');
    assert.equal(resolveLogChannel(config, 'dashboard'), '3');
    assert.equal(resolveLogChannel({ logging: { channels: { audit: '1' } } }, 'dashboard'), null);
    assert.equal(resolveLogChannel({ logging: { channels: { audit: '1' } } }, 'reports'), null);
});
