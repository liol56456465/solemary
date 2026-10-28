// instanceGuard.js — stops a second copy of the live bot in the Replit workspace.
//
// The workspace Run button and the deployment use the same token, so both receive
// every event and buttons get answered twice (duplicate messages). In the workspace
// (REPL_ID / REPLIT_DEV_DOMAIN set, REPLIT_DEPLOYMENT not set) the bot exits before
// logging in, unless it runs in test mode or ALLOW_WORKSPACE_BOT=true.

import { logger } from '../utils/logger.js';

/** Why this process must not start, or null when it may. */
export function workspaceRunRefusal(env = process.env) {
    const onReplit = Boolean(env.REPL_ID || env.REPLIT_DEV_DOMAIN);
    if (!onReplit || env.REPLIT_DEPLOYMENT || env.NODE_ENV === 'test' || env.ALLOW_WORKSPACE_BOT === 'true') {
        return null;
    }
    return 'Not starting: this is the Replit workspace, and the deployment already runs the bot with the same token '
        + '(two copies answer every button twice). Use the deployment, or set ALLOW_WORKSPACE_BOT=true while the deployment is stopped.';
}

const refusal = workspaceRunRefusal();
if (refusal) {
    logger.error(refusal);
    process.exit(1);
}
