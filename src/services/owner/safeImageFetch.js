// safeImageFetch.js — downloads an image for the bot's avatar / banner from a URL the owner
// typed, without letting that URL reach internal addresses (SSRF). The host name is resolved
// here and every address must be public; the connection then goes to the address that was
// checked (the lookup hook hands it to the socket), so a second DNS answer cannot swap it
// for an internal one. No redirects, a timeout and a size cap. Returns a fetch-like response.

import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

// IPv4: everything that is not public. IPv6: only global unicast (2000::/3) is allowed, minus
// the ranges that tunnel or embed IPv4 (6to4, Teredo) and documentation; anything else (::1,
// ::ffff:… in any spelling, NAT64 64:ff9b::/96, unique/link-local, multicast) is refused.
const BLOCKED_V4 = new net.BlockList();
for (const [net4, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
    BLOCKED_V4.addSubnet(net4, prefix, 'ipv4');
}
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const BLOCKED_V6 = new net.BlockList();
for (const [net6, prefix] of [['2002::', 16], ['2001::', 32], ['2001:db8::', 32], ['2001:10::', 28], ['2001:20::', 28]]) {
    BLOCKED_V6.addSubnet(net6, prefix, 'ipv6');
}

/** True for addresses that are not on the public internet (loopback, private, link-local, …). */
export function isPrivateAddress(address) {
    if (net.isIPv4(address)) return BLOCKED_V4.check(address, 'ipv4');
    if (net.isIPv6(address)) return !GLOBAL_V6.check(address, 'ipv6') || BLOCKED_V6.check(address, 'ipv6');
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
