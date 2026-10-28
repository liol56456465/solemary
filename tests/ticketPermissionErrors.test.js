import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBotPermissionError, ticketAccessMessage } from '../src/handlers/ticketButtons.js';
import { createError, ErrorTypes } from '../src/utils/errorHandler.js';
import { ensureTypedServiceError } from '../src/utils/serviceErrorBoundary.js';

test('Discord permission errors (raw or wrapped by the ticket service) count as bot-side', () => {
    const raw = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    assert.equal(isBotPermissionError(raw), true);
    assert.equal(isBotPermissionError(ensureTypedServiceError(raw, { service: 'ticketService', operation: 'claimTicket' })), true);
    assert.equal(isBotPermissionError(Object.assign(new Error('Missing Access'), { code: 50001 })), true);
});

test('a denied user and unrelated failures are not bot permission errors', () => {
    assert.equal(isBotPermissionError(createError('Ticket permission denied', ErrorTypes.PERMISSION, 'nope')), false);
    assert.equal(isBotPermissionError(new Error('boom')), false);
    assert.equal(isBotPermissionError(Object.assign(new Error('Unknown Channel'), { code: 10003 })), false);
});

test('access message names the staff role and says when none is configured', () => {
    assert.equal(
        ticketAccessMessage({ config: { ticketStaffRoleId: '1' } }, 'claim tickets', false),
        'You need the **Ticket Staff** role or **Manage Channels** to claim tickets.'
    );
    assert.match(ticketAccessMessage({ config: {} }, 'claim tickets', false), /none is configured yet/);
    assert.match(ticketAccessMessage({ config: {} }, 'close this ticket', true), /person who opened this ticket/);
});
