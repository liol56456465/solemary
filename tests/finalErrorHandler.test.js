import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { finalErrorHandler } from '../src/utils/finalErrorHandler.js';

async function request(app, path) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
        return { status: res.status, body: await res.text() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('final error handler: no stack trace in the browser outside production; 4xx stays 4xx', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development'; // what the Replit workspace runs
    try {
        const app = express();
        app.get('/boom', () => { throw new Error('secret internals at /home/runner/app.js:1'); });
        app.get('/u/:id', (req, res) => res.send(req.params.id));
        app.use(finalErrorHandler);
        const boom = await request(app, '/boom');
        assert.equal(boom.status, 500);
        assert.equal(boom.body, 'Something went wrong.');
        const bad = await request(app, '/u/%E0%A4%A'); // malformed %-escape
        assert.equal(bad.status, 400);
        assert.equal(bad.body, 'Bad request.');
        assert.ok(!/at |\.js:/.test(boom.body + bad.body));
    } finally {
        if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
    }
});

test('final error handler: a 500 is recorded for Recent errors (source http); a 4xx is not', async () => {
    const { setErrorEventSink } = await import('../src/utils/errorEvents.js');
    const rows = [];
    setErrorEventSink((row) => { rows.push(row); });
    try {
        const app = express();
        app.get('/boom', () => { throw new Error('pool exhausted for "member text"'); });
        app.get('/u/:id', (req, res) => res.send(req.params.id));
        app.use(finalErrorHandler);
        await request(app, '/boom');
        await request(app, '/u/%E0%A4%A');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'http');
        assert.ok(!rows[0].message.includes('member text'), 'quoted values are masked');
    } finally {
        setErrorEventSink(null);
    }
});

test('event loader: guildIdOf finds the server of an event argument, else null', async () => {
    const { guildIdOf } = await import('../src/handlers/loaders/events.js');
    assert.equal(guildIdOf({ guildId: '123456789012345678' }), '123456789012345678');
    assert.equal(guildIdOf({ guild: { id: '223456789012345678' } }), '223456789012345678');
    assert.equal(guildIdOf({ content: 'hi' }), null);
    assert.equal(guildIdOf(undefined), null);
});
