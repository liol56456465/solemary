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
