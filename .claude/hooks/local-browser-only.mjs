#!/usr/bin/env node
// PreToolUse guard for the browser MCP servers (playwright, chrome-devtools): the
// browser may only talk to this machine. Any tool call whose input contains a URL that
// is not http(s)://localhost, 127.0.0.1 or [::1] (or about:blank) is refused, and a
// `url` field that is not such a URL is refused too. Exit 2 = block, reason on stderr.
// Rule from CLAUDE.md: never open the production site or any other non-local URL.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocal(text) {
    if (text === 'about:blank') return true;
    let url;
    try {
        url = new URL(text);
    } catch {
        return false;
    }
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
}

function strings(value, key = '', out = []) {
    if (typeof value === 'string') out.push([key, value]);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, key, out));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, k, out);
    return out;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    let call;
    try {
        call = JSON.parse(input);
    } catch {
        process.stderr.write('local-browser-only: could not read the tool call; refused.\n');
        process.exit(2);
    }
    const bad = [];
    for (const [key, text] of strings(call.tool_input || {})) {
        if (/^url$/i.test(key) && !isLocal(text.trim())) bad.push(text);
        for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)]+/gi)) {
            if (!isLocal(match[0])) bad.push(match[0]);
        }
    }
    if (bad.length) {
        process.stderr.write(`Blocked by .claude/hooks/local-browser-only.mjs: browser tools may only use localhost / 127.0.0.1 (CLAUDE.md). Refused: ${[...new Set(bad)].slice(0, 3).join(', ')}\n`);
        process.exit(2);
    }
    process.exit(0);
});
