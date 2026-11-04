// canonicalHost.js — sends browsers that reach the app on an old address (for example the
// *.replit.app host after the move to app.mewvo.com) to the same page on PUBLIC_URL.
//
// Off unless CANONICAL_REDIRECT=true. Even then it does nothing when:
//   - PUBLIC_URL is unset or not an http(s) URL, or NODE_ENV=test;
//   - the request already uses the PUBLIC_URL host, or comes to localhost / 127.0.0.1 / ::1;
//   - the method is not GET or HEAD (a form POST in flight must not turn into a GET);
//   - the path is a health check or an OAuth callback (EXEMPT_PATHS): Discord sends people back
//     to the exact redirect_uri that started the login, and the state cookie lives on that host.
// The target origin comes only from PUBLIC_URL, never from Host or X-Forwarded-Host. A path that
// does not start with exactly one "/" (e.g. "//evil.com") is never redirected.

/** Paths that always answer on whatever host they were called on. Compared lowercased, without trailing "/". */
export const EXEMPT_PATHS = Object.freeze([
    '/health',
    '/ready',
    '/oauth/callback',
    '/dashboard/oauth/callback',
    '/me/callback',
]);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Redirect responses may be cached for an hour only, so turning the redirect off (rollback) takes effect soon. */
const REDIRECT_CACHE_CONTROL = 'public, max-age=3600';

/** The PUBLIC_URL origin + hostname, or null when it is unset or not http(s). */
export function canonicalOrigin(publicUrl) {
    const raw = String(publicUrl || '').trim();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        return { origin: url.origin, hostname: url.hostname.toLowerCase() };
    } catch {
        return null;
    }
}

/** Settings read once from env: { enabled, origin, hostname }. */
export function canonicalSettings(env = process.env) {
    const canonical = canonicalOrigin(env.PUBLIC_URL);
    const switchedOn = String(env.CANONICAL_REDIRECT || '').trim().toLowerCase() === 'true';
    const enabled = Boolean(canonical) && switchedOn && env.NODE_ENV !== 'test';
    return { enabled, origin: canonical?.origin || null, hostname: canonical?.hostname || null };
}

function isExemptPath(pathname) {
    const normalized = pathname.toLowerCase().replace(/\/+$/, '') || '/';
    return EXEMPT_PATHS.includes(normalized);
}

/**
 * The absolute URL to redirect this request to, or null to let it through.
 * `req` needs method, hostname and originalUrl (or url), as Express provides.
 */
export function redirectTarget(req, settings) {
    if (!settings?.enabled || !settings.origin) return null;
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;

    const hostname = String(req.hostname || '').trim().toLowerCase();
    if (!hostname || hostname === settings.hostname || LOCAL_HOSTS.has(hostname)) return null;

    const pathAndQuery = String(req.originalUrl || req.url || '');
    // Exactly one leading "/": "//host" and "/\host" are protocol-relative in browsers.
    if (!pathAndQuery.startsWith('/') || pathAndQuery[1] === '/' || pathAndQuery[1] === '\\') return null;

    const pathname = pathAndQuery.split(/[?#]/, 1)[0];
    if (isExemptPath(pathname)) return null;

    const target = `${settings.origin}${pathAndQuery}`;
    try {
        // Belt and braces: whatever the path held, the result must stay on PUBLIC_URL's origin.
        if (new URL(target).origin !== settings.origin) return null;
    } catch {
        return null;
    }
    return target;
}

/** Express middleware. Reads env once; a no-op pass-through when disabled. */
export function createCanonicalHostRedirect(env = process.env) {
    const settings = canonicalSettings(env);
    const middleware = (req, res, next) => {
        const target = settings.enabled ? redirectTarget(req, settings) : null;
        if (!target) return next();
        res.set('Cache-Control', REDIRECT_CACHE_CONTROL);
        return res.redirect(301, target);
    };
    middleware.settings = settings;
    return middleware;
}
