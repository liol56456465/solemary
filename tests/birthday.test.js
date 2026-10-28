import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBirthdayOn } from '../src/services/birthdayService.js';

test('Feb 29 birthdays are celebrated on Feb 28 in non-leap years', () => {
    const leapling = { month: 2, day: 29 };
    assert.equal(isBirthdayOn(leapling, new Date('2027-02-28T12:00:00Z')), true);
    assert.equal(isBirthdayOn(leapling, new Date('2027-03-01T12:00:00Z')), false);
    assert.equal(isBirthdayOn(leapling, new Date('2028-02-28T12:00:00Z')), false);
    assert.equal(isBirthdayOn(leapling, new Date('2028-02-29T12:00:00Z')), true);
    assert.equal(isBirthdayOn({ month: 2, day: 28 }, new Date('2027-02-28T00:00:00Z')), true);
    assert.equal(isBirthdayOn({ month: 10, day: 27 }, new Date('2026-10-27T23:59:59Z')), true);
});
