import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekStart } from '../src/services/staffActivityService.js';

test('weeks start on Monday (UTC)', () => {
    assert.equal(weekStart(new Date('2026-10-26T00:00:00Z')), '2026-10-26'); // Monday
    assert.equal(weekStart(new Date('2026-10-28T12:00:00Z')), '2026-10-26'); // Wednesday
    assert.equal(weekStart(new Date('2026-11-01T23:59:59Z')), '2026-10-26'); // Sunday
    assert.equal(weekStart(new Date('2026-11-02T00:00:00Z')), '2026-11-02'); // next Monday
});
