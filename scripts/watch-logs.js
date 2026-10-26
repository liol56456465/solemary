// watch-logs.js — shows the bot's logs live, readably. Read-only: it never starts
// or touches the bot, so it can be opened and closed any time.
//
// Remote (bot on Replit): set LOG_STREAM_URL and LOG_STREAM_TOKEN, e.g. in the
// gitignored .logviewer.env, and run
//   node --env-file=.logviewer.env scripts/watch-logs.js [--errors]
// Local (bot on this machine): without LOG_STREAM_URL it follows
// logs/combined-<date>.log instead.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const onlyProblems = process.argv.includes('--errors');
const BACKLOG_LINES = 30;

const color = {
    error: (s) => `\x1b[31m${s}\x1b[0m`,
    warn: (s) => `\x1b[33m${s}\x1b[0m`,
    info: (s) => `\x1b[36m${s}\x1b[0m`,
    debug: (s) => `\x1b[90m${s}\x1b[0m`,
    dim: (s) => `\x1b[90m${s}\x1b[0m`,
};

function newestLogFile() {
    const files = fs.existsSync(LOG_DIR)
        ? fs.readdirSync(LOG_DIR).filter((name) => /^combined-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort()
        : [];
    return files.length ? path.join(LOG_DIR, files.at(-1)) : null;
}

function render(line) {
    if (!line.trim()) return;
    let entry;
    try {
        entry = JSON.parse(line);
    } catch {
        console.log(line);
        return;
    }

    const level = entry.level || 'info';
    if (onlyProblems && level !== 'error' && level !== 'warn') return;

    const time = String(entry.timestamp || '').slice(11);
    const paint = color[level] || ((s) => s);
    const where = [entry.guildId && `guild ${entry.guildId}`, entry.command && `/${entry.command}`].filter(Boolean).join(' ');
    console.log(`${color.dim(time)} ${paint(level.toUpperCase().padEnd(5))} ${entry.message}${where ? color.dim(`  (${where})`) : ''}`);
    if (entry.stack && level === 'error') {
        console.log(color.dim(String(entry.stack).split('\n').slice(1, 4).join('\n')));
    }
}

let currentFile = null;
let offset = 0;
let partial = '';

function readNew() {
    const newest = newestLogFile();
    if (newest !== currentFile) {
        currentFile = newest;
        offset = 0;
        partial = '';
        if (currentFile) console.log(color.dim(`── following ${path.basename(currentFile)} ──`));
    }
    if (!currentFile) return;

    const size = fs.statSync(currentFile).size;
    if (size < offset) offset = 0;
    if (size === offset) return;

    const fd = fs.openSync(currentFile, 'r');
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
    offset = size;

    const lines = (partial + buffer.toString('utf8')).split('\n');
    partial = lines.pop();
    lines.forEach(render);
}

function showBacklog() {
    currentFile = newestLogFile();
    if (!currentFile) {
        console.log(color.dim(`No log file yet in ${LOG_DIR}. Waiting for the bot to start…`));
        return;
    }
    console.log(color.dim(`── following ${path.basename(currentFile)} ──`));
    const content = fs.readFileSync(currentFile, 'utf8');
    offset = Buffer.byteLength(content);
    const lines = content.split('\n');
    partial = lines.pop();
    lines.slice(-BACKLOG_LINES).forEach(render);
}

async function followRemote(url, token) {
    let delay = 2000;
    for (;;) {
        try {
            const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
            if (response.status === 404) {
                console.log(color.error('Log stream refused (404): wrong LOG_STREAM_TOKEN, or LOG_STREAM_TOKEN is not set on Replit.'));
            } else if (!response.ok) {
                console.log(color.warn(`Log stream answered HTTP ${response.status}; retrying…`));
            } else {
                console.log(color.dim(`── connected to ${new URL(url).host} ──`));
                delay = 2000;
                let pending = '';
                for await (const chunk of response.body) {
                    pending += Buffer.from(chunk).toString('utf8');
                    const events = pending.split('\n\n');
                    pending = events.pop();
                    for (const event of events) {
                        for (const line of event.split('\n')) {
                            if (line.startsWith('data: ')) render(line.slice(6));
                        }
                    }
                }
                console.log(color.warn('Connection closed (bot restarting?); reconnecting…'));
            }
        } catch (error) {
            console.log(color.warn(`Cannot reach ${new URL(url).host} (${error.cause?.code || error.message}); is the bot running on Replit? Retrying…`));
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30000);
    }
}

const remoteUrl = (process.env.LOG_STREAM_URL || '').trim();
const remoteToken = (process.env.LOG_STREAM_TOKEN || '').trim();

console.log(color.dim(`Meowist logs${onlyProblems ? ' (warnings and errors only)' : ''} — read-only, close this window any time.`));
if (remoteUrl) {
    if (!remoteToken) {
        console.log(color.error('LOG_STREAM_URL is set but LOG_STREAM_TOKEN is empty.'));
        process.exit(1);
    }
    followRemote(remoteUrl, remoteToken);
} else {
    showBacklog();
    setInterval(readNew, 1000);
}
