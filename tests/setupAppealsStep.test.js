// /setup and the dashboard checklist agree on "where members appeal" (other servers): done only when the
// choice was saved on purpose, and with an invite when it is the server's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSetupState } from '../src/services/setup/setupGuide.js';
import { defaultSetupData } from '../src/services/setup/setupGuide.js';

const G = '923456789012345678';
function data({ source, appealsHome = 'own', appealsInvite = null }) {
    return {
        ...defaultSetupData,
        settingsFor: () => ({ appealsHome, appealsInvite }),
        languageSource: () => 'database',
        appealsSource: () => source,
        isHomeGuild: () => false,
        detectedLanguage: () => null,
        memberReach: () => null,
        getGuildConfig: async () => ({}),
        getWelcomeConfig: async () => ({}),
        getAutomodSettings: async () => ({}),
    };
}

test('appealsSaved follows the saved source', async () => {
    assert.equal((await collectSetupState({ client: null, guildId: G, data: data({ source: 'default' }) })).appealsSaved, false);
    assert.equal((await collectSetupState({ client: null, guildId: G, data: data({ source: 'database' }) })).appealsSaved, true);
});
