import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES } from '../src/services/dashboard/html.js';

// The picker script refuses any theme not in its own list, so it must match the server's.
test('dashboard.js theme list matches THEMES in html.js', () => {
    const src = readFileSync(new URL('../src/services/dashboard/static/dashboard.js', import.meta.url), 'utf8');
    const match = src.match(/const THEMES = \[([^\]]*)\]/);
    assert.ok(match, 'THEMES list not found in dashboard.js');
    const client = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(client, THEMES);
});
