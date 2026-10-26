// panelState.js — short-lived state for one moderator's panel flow.
//
// Bounded and TTL'd; lost on restart by design. A missing entry means the panel
// expired and the moderator is told to run /enforcements again.

import { randomBytes } from 'crypto';
import { enforcementConfig } from '../../config/enforcement.js';

const flows = new Map();

function prune(now = Date.now()) {
    for (const [nonce, flow] of flows) {
        if (now - flow.createdAt > enforcementConfig.panelTtlMs) {
            flows.delete(nonce);
        }
    }
    // Map iteration is insertion order, so the oldest entries go first.
    while (flows.size > enforcementConfig.panelMaxEntries) {
        flows.delete(flows.keys().next().value);
    }
}

export function createFlow(data) {
    prune();
    const nonce = randomBytes(6).toString('hex');
    flows.set(nonce, { ...data, createdAt: Date.now() });
    return nonce;
}

export function getFlow(nonce) {
    const flow = flows.get(nonce);
    if (!flow) {
        return null;
    }
    if (Date.now() - flow.createdAt > enforcementConfig.panelTtlMs) {
        flows.delete(nonce);
        return null;
    }
    return flow;
}

export function updateFlow(nonce, patch) {
    const flow = getFlow(nonce);
    if (!flow) {
        return null;
    }
    Object.assign(flow, patch);
    return flow;
}

/** Removes the flow and returns it, so a double-clicked Confirm executes once. */
export function takeFlow(nonce) {
    const flow = getFlow(nonce);
    flows.delete(nonce);
    return flow;
}

export const PANEL_EXPIRED_MESSAGE = 'This panel expired, run /enforcements again.';
