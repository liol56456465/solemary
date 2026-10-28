// safeImageFetch.js — downloads an image for the bot's avatar / banner from a URL the owner
// typed, without letting that URL reach internal addresses (SSRF). The host name is resolved
// here and every address must be public; the connection then goes to the address that was
// checked (the lookup hook hands it to the socket), so a second DNS answer cannot swap it
// for an internal one. No redirects, a timeout and a size cap. Returns a fetch-like response.

import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

/** True for addresses that are not on the public internet (loopback, private, link-local, …). */
export function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127) // CGNAT
            || (a === 169 && b === 254) // link-local, cloud metadata
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && (b === 168 || (b === 0 && address.startsWith('192.0.0.'))))
            || (a === 198 && (b === 18 || b === 19));
    }
    if (net.isIPv6(address)) {
        const v = address.toLowerCase();
        const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateAddress(mapped[1]);
        return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
    }
    return true;
}

/** dns.lookup replacement for the socket: resolves, refuses non-public answers, returns a checked one. */
function checkedLookup(resolve = dns.lookup) {
    return (hostname, options, callback) => {
        resolve(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error);
            const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
            if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
                return callback(Object.assign(new Error('That host resolves to a private address'), { code: 'EPRIVATE' }));
            }
            const pick = list[0];
            if (options?.all) return callback(null, [pick]);
            return callback(null, pick.address, pick.family);
        });
    };
}

/** Minimal fetch: GET over https to a checked public address; { ok, status, headers, arrayBuffer }. */
export function pinnedFetch(url, { timeoutMs = 10_000, maxBytes = 8 * 1024 * 1024, resolve } = {}) {
    return new Promise((done, fail) => {
        const req = https.get(url, { lookup: checkedLookup(resolve), timeout: timeoutMs }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    req.destroy(Object.assign(new Error('too large'), { code: 'ETOOLARGE' }));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                done({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
                    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
                });
            });
            res.on('error', fail);
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
        req.on('error', fail);
    });
}
