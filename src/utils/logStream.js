// logStream.js — keeps the latest log lines in memory and fans new ones out to
// subscribers (the /admin/logs/stream endpoint). Bounded: only the last
// BUFFER_SIZE lines are kept, and lines are plain JSON strings.

import { Writable } from 'stream';

const BUFFER_SIZE = 500;
const buffer = [];
const subscribers = new Set();

export const logStreamSink = new Writable({
    objectMode: true,
    write(info, _encoding, callback) {
        // winston's Stream transport hands over the formatted info object; the
        // JSON line lives under the MESSAGE symbol.
        const line = info?.[Symbol.for('message')] ?? JSON.stringify(info);
        buffer.push(line);
        if (buffer.length > BUFFER_SIZE) buffer.shift();
        for (const send of subscribers) {
            try {
                send(line);
            } catch {
                subscribers.delete(send);
            }
        }
        callback();
    },
});

export function getRecentLogLines(limit = 100) {
    return buffer.slice(-limit);
}

export function subscribeToLogs(send) {
    subscribers.add(send);
    return () => subscribers.delete(send);
}
