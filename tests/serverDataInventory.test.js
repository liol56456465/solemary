// The server data inventory (services/privacy/serverDataInventory.js) covers EVERY table:
// a table in schema.js with a guild_id column must be deleted (or detached) by the inventory, and
// every table must be classified (covered, a child through its parent, or "no server data" with a
// reason). Fails when schema.js gains a table that the inventory does not know.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pgConfig } from '../src/config/database/postgres.js';
import {
    CHILD_TABLES, GROUP_ORDER, KINDS, NOT_SERVER_DATA, TABLES, coveredTableKeys,
} from '../src/services/privacy/serverDataInventory.js';

const schema = readFileSync(new URL('../src/utils/database/schema.js', import.meta.url), 'utf8');

/** pgConfig key → its column names, from CREATE TABLE and ALTER TABLE … ADD COLUMN. */
function schemaColumns() {
    const tables = new Map();
    for (const m of schema.matchAll(/CREATE TABLE IF NOT EXISTS \$\{t\.(\w+)\} \(([\s\S]*?)\n {4}\)`/g)) {
        const cols = new Set();
        for (const line of m[2].split('\n')) {
            const col = /^\s*([a-z_]+)\s+[A-Z]/.exec(line);
            if (col && !['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK'].includes(col[1].toUpperCase())) cols.add(col[1]);
        }
        tables.set(m[1], cols);
    }
    for (const m of schema.matchAll(/ALTER TABLE \$\{t\.(\w+)\} ADD COLUMN IF NOT EXISTS (\w+)/g)) {
        if (!tables.has(m[1])) tables.set(m[1], new Set());
        tables.get(m[1]).add(m[2]);
    }
    return tables;
}

test('schema parsing finds the tables (sanity: the guard is not checking an empty list)', () => {
    const tables = schemaColumns();
    assert.ok(tables.size >= 60, `only ${tables.size} tables parsed`);
    assert.ok(tables.get('mod_cases').has('guild_id'));
    assert.ok(tables.get('mod_appeals').has('channel_guild_id'), 'ALTER TABLE columns are read too');
    assert.ok(!tables.get('users').has('guild_id'));
});

test('every table with a guild_id column is deleted (or detached) by the inventory', () => {
    const covered = new Set(coveredTableKeys());
    const missing = [...schemaColumns()]
        .filter(([, cols]) => [...cols].some((c) => c === 'guild_id' || c.endsWith('_guild_id')))
        .map(([key]) => key)
        .filter((key) => !covered.has(key));
    assert.deepEqual(missing, [], 'add these tables to TABLES in src/services/privacy/serverDataInventory.js');
});

test('every table in schema.js is classified: covered, a child through its parent, or no server data (with a reason)', () => {
    const covered = new Set([...coveredTableKeys(), ...CHILD_TABLES]);
    const unclassified = [...schemaColumns().keys()].filter((key) => !covered.has(key) && !Object.hasOwn(NOT_SERVER_DATA, key));
    assert.deepEqual(unclassified, [], 'classify these tables in serverDataInventory.js');
    for (const [key, reason] of Object.entries(NOT_SERVER_DATA)) {
        assert.ok(String(reason).length > 10, `${key}: give the reason`);
        assert.ok(!covered.has(key), `${key} is both covered and "no server data"`);
    }
    for (const key of CHILD_TABLES) assert.ok(coveredTableKeys().includes(key), `${key}: children are deleted explicitly too`);
    // Every pgConfig table is known (a table defined outside schema.js would slip past otherwise).
    const known = new Set([...covered, ...Object.keys(NOT_SERVER_DATA)]);
    assert.deepEqual(Object.keys(pgConfig.tables).filter((key) => !known.has(key)), []);
});

test('every entry: a known table, a known kind run by a group, $1 as the only parameter, no other server id', () => {
    for (const entry of TABLES) {
        assert.ok(pgConfig.tables[entry.key], `${entry.key}: not a pgConfig table`);
        assert.ok(KINDS.includes(entry.kind), `${entry.key}: kind ${entry.kind}`);
        assert.ok(GROUP_ORDER.includes(entry.kind), `${entry.key}: kind ${entry.kind} is never run`);
        const where = entry.where(pgConfig.tables);
        assert.match(where, /\$1/, `${entry.key}: must be scoped by the server id`);
        assert.doesNotMatch(where, /\$[2-9]/, `${entry.key}: $1 is the only parameter`);
        assert.doesNotMatch(where, /\d{17,20}/, `${entry.key}: no literal ids`);
        if (entry.mode === 'detach') assert.match(entry.set, /guild_id = NULL/);
    }
    // Groups: appeals before cases (mod_appeals.case_code has no ON DELETE CASCADE); settings (the
    // guilds row, which cascades) last; logs live in the guilds row and have no entries.
    assert.ok(GROUP_ORDER.indexOf('appeals') < GROUP_ORDER.indexOf('cases'));
    assert.equal(GROUP_ORDER.at(-1), 'settings');
    assert.equal(TABLES.filter((e) => e.kind === 'logs').length, 0);
    assert.equal(TABLES.at(-1).key, 'guilds');
});

test('the key-value sweep matches the server id as a whole number only and keeps the deletion request', () => {
    const kv = TABLES.find((e) => e.kind === 'kv' && e.key === 'temp_data').where(pgConfig.tables);
    assert.match(kv, /\(\^\|\[\^0-9\]\)' \|\| \$1 \|\| '\(\[\^0-9\]\|\$\)/);
    assert.match(kv, /NOT LIKE 'serverdata:deletion:%'/);
    // The same pattern, checked in JS against keys of this and other servers.
    const id = '123456789012345678';
    const re = new RegExp(`(^|[^0-9])${id}([^0-9]|$)`);
    for (const key of [`guild:${id}:config`, `automod:settings:${id}`, `ticket_config_${id}`, `moderation_user_notes_${id}_42`, `enforcement:massguard:${id}:9`]) assert.ok(re.test(key), key);
    for (const key of [`guild:${id}9:config`, `guild:9${id}:config`, `oauth:tokens:${id.slice(1)}`, 'todo_42']) assert.ok(!re.test(key), key);
});
