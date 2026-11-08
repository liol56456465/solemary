import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    runAutocompleteWithDeadline,
    cachedChoicesFor,
    autocompleteDeadlineMs,
    resetAutocompleteDeadlineState,
    AUTOCOMPLETE_DEADLINE_MS,
} from '../src/utils/autocompleteDeadline.js';

function fakeAutocomplete(typed = '') {
    const responses = [];
    return {
        responses,
        guildId: 'g1',
        commandName: 'background',
        createdTimestamp: Date.now(),
        options: { getFocused: () => ({ name: 'name', value: typed }) },
        async respond(choices) {
            if (responses.length) throw new Error('already responded');
            responses.push(choices);
        },
    };
}

function manualTimer() {
    const timers = [];
    return {
        timers,
        setTimer: (fn, ms) => {
            const t = { fn, ms, cleared: false };
            timers.push(t);
            return t;
        },
        clearTimer: (t) => {
            t.cleared = true;
        },
    };
}

const quietLog = () => {
    const lines = [];
    return { lines, warn: (m) => lines.push(m), error: (m) => lines.push(m) };
};

beforeEach(() => resetAutocompleteDeadlineState());

test('a fast autocomplete answers itself and the deadline timer is cleared', async () => {
    const i = fakeAutocomplete();
    const timer = manualTimer();
    const outcome = await runAutocompleteWithDeadline(i, async (x) => x.respond([{ name: 'alice', value: '1' }]), { ...timer, log: quietLog() });
    assert.equal(outcome, 'handler');
    assert.equal(timer.timers[0].ms, AUTOCOMPLETE_DEADLINE_MS);
    assert.equal(timer.timers[0].cleared, true);
    assert.deepEqual(i.responses, [[{ name: 'alice', value: '1' }]]);
});

test('a slow autocomplete is answered at the deadline with cached choices, the late answer is dropped', async () => {
    const log = quietLog();
    // First run caches choices for this server/command/option.
    await runAutocompleteWithDeadline(fakeAutocomplete(), async (x) => x.respond([{ name: 'alice', value: '1' }, { name: 'bob', value: '2' }]), { ...manualTimer(), log });

    const i = fakeAutocomplete('ali');
    const timer = manualTimer();
    let release;
    const handler = async (x) => {
        await new Promise((r) => { release = r; });
        await x.respond([{ name: 'late', value: 'x' }]);
    };
    const run = runAutocompleteWithDeadline(i, handler, { ...timer, log });
    await new Promise((r) => setImmediate(r));
    timer.timers[0].fn(); // the deadline
    release();
    const outcome = await run;
    assert.equal(outcome, 'timeout');
    assert.deepEqual(i.responses, [[{ name: 'alice', value: '1' }]]);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /Slow autocomplete: \/background name/);
});

test('no cache: the deadline answers with an empty list', async () => {
    const i = fakeAutocomplete('x');
    const timer = manualTimer();
    let release;
    const run = runAutocompleteWithDeadline(i, () => new Promise((r) => { release = r; }), { ...timer, log: quietLog() });
    await new Promise((r) => setImmediate(r));
    timer.timers[0].fn();
    release();
    assert.equal(await run, 'timeout');
    assert.deepEqual(i.responses, [[]]);
});

test('a throwing or silent handler still gets one empty answer', async () => {
    const a = fakeAutocomplete();
    assert.equal(await runAutocompleteWithDeadline(a, async () => { throw new Error('db down'); }, { ...manualTimer(), log: quietLog() }), 'error');
    assert.deepEqual(a.responses, [[]]);
    const b = fakeAutocomplete();
    assert.equal(await runAutocompleteWithDeadline(b, async () => {}, { ...manualTimer(), log: quietLog() }), 'empty');
    assert.deepEqual(b.responses, [[]]);
});

test('cached choices are filtered by what was typed and capped at 25', () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ name: `user${n}`, value: String(n) }));
    assert.equal(cachedChoicesFor(many, '').length, 25);
    assert.deepEqual(cachedChoicesFor(many, 'USER39'), [{ name: 'user39', value: '39' }]);
    assert.deepEqual(cachedChoicesFor(null, 'a'), []);
});

test('the deadline shrinks for a late arrival but keeps a minimum', () => {
    const now = 50_000;
    assert.equal(autocompleteDeadlineMs({ createdTimestamp: now - 1000 }, { now: () => now }), 1700);
    assert.equal(autocompleteDeadlineMs({ createdTimestamp: now - 2900 }, { now: () => now }), 200);
});
