// Guards the mention policy (CLAUDE.md: no @everyone/@here/role pings from user-supplied text).
// The client default pings users only; messages that ping a role on purpose say so themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('client default allowedMentions parses users only (no roles, no everyone)', () => {
    const match = source('src/app.js').match(/allowedMentions:\s*\{\s*parse:\s*\[([^\]]*)\]/);
    assert.ok(match, 'client allowedMentions not found in src/app.js');
    assert.deepEqual(match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean), ['users']);
});

test('intentional staff-role pings list the role in their own allowedMentions', () => {
    assert.match(source('src/services/ticket.js'), /allowedMentions:\s*\{\s*users:\s*\[member\.id\],\s*roles:\s*config\.ticketStaffRoleId/);
    for (const file of ['src/services/modmailService.js', 'src/services/ticketReminderService.js', 'src/services/enforcement/staleAppealService.js']) {
        assert.match(source(file), /allowedMentions:\s*\{\s*roles:\s*staffRoleId/, file);
    }
});

test('level-up messages ping the member only', () => {
    const xp = source('src/services/leveling/xpSystem.js');
    assert.match(xp, /levelUpChannel\.send\(\{ content: message, allowedMentions: \{ parse: \['users'\] \} \}\)/);
    // The card send (level-up image card) keeps the same mentions.
    assert.match(xp, /levelUpChannel\.send\(\{ content: message, allowedMentions: \{ parse: \['users'\] \}, files: \[/);
    assert.equal((xp.match(/levelUpChannel\.send\(/g) || []).length, 2, 'only the text send and the card send');
});

test('welcome messages keep users + roles from the admin text, never everyone', () => {
    const welcome = source('src/events/guildMemberAdd.js');
    assert.match(welcome, /WELCOME_MENTIONS = Object\.freeze\(\{ parse: \['users', 'roles'\] \}\)/);
    assert.equal((welcome.match(/allowedMentions: WELCOME_MENTIONS/g) || []).length, 2, 'both welcome sends use it');
});
