import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedPlayQuery } from '../src/services/music/queryPolicy.js';

const ok = (q) => assert.doesNotThrow(() => assertAllowedPlayQuery(q), q);
const refused = (q) => assert.throws(() => assertAllowedPlayQuery(q), /Play query refused/, q);

test('search terms pass, including ones with colons', () => {
    ok('never gonna give you up');
    ok('Re:Zero opening');
    ok('AC/DC thunderstruck');
});

test('links from the allowed music sites pass', () => {
    ok('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    ok('https://music.youtube.com/watch?v=abc');
    ok('https://youtu.be/dQw4w9WgXcQ');
    ok('https://soundcloud.com/artist/track');
    ok('https://m.soundcloud.com/artist/track');
    ok('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    ok('youtube.com/watch?v=abc');
});

test('every other URL is refused', () => {
    refused('http://169.254.169.254/latest/meta-data/');
    refused('http://localhost:2333/version');
    refused('https://evil.example/stream.mp3');
    refused('https://youtube.com.evil.example/x');
    refused('https://notyoutube.com/watch');
    refused('https://user:pw@youtube.com/watch');
    refused('ftp://youtube.com/x');
    refused('evil.example/stream.mp3');
    refused('local:/etc/passwd');
    refused('file:///etc/passwd');
    refused('spotify.com/track/x'); // only open.spotify.com
});
