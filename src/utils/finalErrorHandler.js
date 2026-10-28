// finalErrorHandler.js — the last Express error handler. Without it, Express prints the
// error's stack trace in the browser whenever NODE_ENV is not "production" (the Replit
// workspace runs "development" and its dev URL is reachable from the internet). Client
// errors (for example a malformed %-escape in the path) get a short 4xx; everything else a
// plain 500. The details go to the log only.

import { logger } from './logger.js';

export function finalErrorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    const status = Number(error?.status || error?.statusCode);
    const clientError = status >= 400 && status < 500;
    if (clientError) {
        logger.debug(`HTTP ${status} on ${req.method} ${req.path}: ${error?.message}`);
    } else {
        logger.error(`Unhandled error on ${req.method} ${req.path}: ${error?.message}`);
    }
    res.status(clientError ? status : 500).type('text/plain').set('Cache-Control', 'no-store')
        .send(clientError ? 'Bad request.' : 'Something went wrong.');
}
