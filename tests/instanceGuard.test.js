import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceRunRefusal } from '../src/config/instanceGuard.js';

test('the Replit workspace refuses to run the live bot next to the deployment', () => {
    assert.match(workspaceRunRefusal({ REPL_ID: 'abc' }), /workspace/i);
    assert.match(workspaceRunRefusal({ REPLIT_DEV_DOMAIN: 'x.replit.dev' }), /workspace/i);
});

test('deployments, test mode, an explicit override and non-Replit machines may run', () => {
    assert.equal(workspaceRunRefusal({ REPL_ID: 'abc', REPLIT_DEPLOYMENT: '1' }), null);
    assert.equal(workspaceRunRefusal({ REPL_ID: 'abc', NODE_ENV: 'test' }), null);
    assert.equal(workspaceRunRefusal({ REPL_ID: 'abc', ALLOW_WORKSPACE_BOT: 'true' }), null);
    assert.equal(workspaceRunRefusal({}), null);
});
