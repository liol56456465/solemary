// ackSafetyNet.js — the 3-second safety net for interactions.
//
// Discord shows "The application did not respond" when an interaction is not acknowledged
// (reply, deferReply, deferUpdate, update, showModal) within 3 seconds. The dispatcher
// (events/interactionCreate.js) arms a net for every registered handler: if the handler has
// not acknowledged within AUTO_ACK_AFTER_MS, the net does it for it, a deferReply (ephemeral)
// for commands and a deferUpdate for buttons, select menus and modals sent from a message.
//
// After an auto-ack the handler keeps running unchanged. The wrappers installed by
// installAckWrappers() turn its own acknowledgement into the call that is still valid:
//   deferReply / deferUpdate  -> no-op (deferReply after an auto deferUpdate remembers that
//                                the handler wanted a reply of its own)
//   reply                      -> editReply (command) or followUp (component)
//   update                     -> editReply (edits the component's message, as update would)
//   editReply after "wanted a reply" on a component -> the first one is a followUp, later
//                                ones edit that follow-up (never the panel message)
//   showModal                  -> impossible after an ack: an ephemeral "try again" follow-up
// Handlers that open a modal must be exempt (a modal must be the first response): they
// declare it with `opensModal` (true, or a predicate) on the handler/command object. For them
// the net only steps in at the last moment (MODAL_FALLBACK_AFTER_MS), when the form could no
// longer open in time anyway: the user then gets "please try again" instead of
// "The application did not respond".
//
// Interactions arriving while the bot is still starting (not ready, caches loading, database
// known down) are acknowledged at once (fireNow) instead of after the delay.
//
// Every handler that needed the net is logged as a warning (once per handler key per hour),
// so the slow ones show up in Owner -> Health -> Recent errors.

import { MessageFlags } from 'discord.js';
import { logger } from './logger.js';
import { BoundedMap } from './boundedMap.js';

export const AUTO_ACK_AFTER_MS = 2000;
export const MODAL_FALLBACK_AFTER_MS = 2600;
const MODAL_FALLBACK_TARGET_AGE_MS = 2700;
const MIN_AUTO_ACK_DELAY_MS = 250;
// Age (by the interaction's own timestamp) at which the net aims to have acked at the latest.
const ACK_TARGET_AGE_MS = 2500;
export const SLOW_HANDLER_LOG_INTERVAL_MS = 60 * 60 * 1000;
const EXPIRED_INTERACTION_CODE = 10062;
const ALREADY_ACKED_CODE = 40060;

export const MODAL_TOO_LATE_MESSAGE = 'That took too long to open the form. Please try again.';

const lastSlowLogByKey = new BoundedMap(500);
const slowHandlerStats = new BoundedMap(200);

function isEphemeralRequest(options) {
    if (!options || typeof options !== 'object') return false;
    if (options.ephemeral === true) return true;
    const flags = options.flags;
    if (typeof flags === 'number' || typeof flags === 'bigint') return (Number(flags) & MessageFlags.Ephemeral) !== 0;
    if (Array.isArray(flags)) return flags.includes(MessageFlags.Ephemeral) || flags.includes('Ephemeral');
    if (flags && typeof flags.has === 'function') return flags.has(MessageFlags.Ephemeral);
    return false;
}

function asOptions(options) {
    if (typeof options === 'string') return { content: options };
    return options && typeof options === 'object' ? options : {};
}

/** Options for editReply: no ephemeral flag (an edit can't change it), Components V2 kept. */
function editOptions(options) {
    const { flags, ephemeral, withResponse, fetchReply, ...rest } = asOptions(options);
    if (typeof flags === 'number' && (flags & MessageFlags.IsComponentsV2)) rest.flags = MessageFlags.IsComponentsV2;
    return rest;
}

/** Options for a follow-up that stands in for the handler's own reply. */
function followUpOptions(options, ephemeral) {
    const { flags, ephemeral: _e, withResponse, fetchReply, message, ...rest } = asOptions(options);
    let bits = typeof flags === 'number' && (flags & MessageFlags.IsComponentsV2) ? MessageFlags.IsComponentsV2 : 0;
    if (ephemeral) bits |= MessageFlags.Ephemeral;
    if (bits) rest.flags = bits;
    return rest;
}

/** True when the net acknowledged the interaction and the handler has not answered since. */
export function isAutoAckedAwaitingHandler(interaction) {
    const net = interaction?._ackNet;
    return Boolean(net?.autoAcked && !net.handlerAcked);
}

/** Resolves once an auto-ack that is in flight has settled. */
export async function waitForAutoAck(interaction) {
    const pending = interaction?._ackNet?.acking;
    if (pending) await pending.catch(() => {});
}

/**
 * Marks that the handler is acknowledging the interaction itself (synchronously, before its
 * request is sent), so the net never sends a second acknowledgement.
 */
function noteHandlerAck(net) {
    if (net && !net.autoAcked && !net.acking) net.handlerAcked = true;
}

/**
 * Wraps the acknowledgement methods of an interaction (idempotent). Without an armed net
 * (`interaction._ackNet`) every wrapper calls straight through.
 */
export function installAckWrappers(interaction) {
    if (!interaction || interaction.__ackWrapped) return;
    const bind = (name) => (typeof interaction[name] === 'function' ? interaction[name].bind(interaction) : null);
    const original = {
        reply: bind('reply'),
        deferReply: bind('deferReply'),
        deferUpdate: bind('deferUpdate'),
        update: bind('update'),
        editReply: bind('editReply'),
        followUp: bind('followUp'),
        deleteReply: bind('deleteReply'),
        fetchReply: bind('fetchReply'),
        showModal: bind('showModal'),
    };
    interaction.__ackOriginals = original;
    interaction.__ackWrapped = true;

    async function redirectMessage(net, options) {
        if (!net.redirect.messagePromise) {
            net.redirect.messagePromise = original.followUp(followUpOptions(options, net.redirect.ephemeral));
            try {
                return await net.redirect.messagePromise;
            } catch (error) {
                net.redirect.messagePromise = null;
                throw error;
            }
        }
        return null;
    }

    if (original.editReply) {
        interaction.editReply = async (options) => {
            await waitForAutoAck(interaction);
            const net = interaction._ackNet;
            // Any edit after the auto-ack is the handler's answer (e.g. a handler that saw
            // `deferred` and edited): later replies follow up as usual.
            if (net?.autoAcked) net.handlerAcked = true;
            if (net?.redirect) {
                const first = await redirectMessage(net, options);
                if (first) {
                    interaction.replied = true;
                    return first;
                }
                const message = await net.redirect.messagePromise;
                return original.editReply({ ...editOptions(options), message: message.id });
            }
            return original.editReply(options);
        };
    }

    if (original.deferReply) {
        interaction.deferReply = async (options = {}) => {
            const net = interaction._ackNet;
            noteHandlerAck(net);
            await waitForAutoAck(interaction);
            if (net?.autoAcked && !net.handlerAcked) {
                net.handlerAcked = true;
                if (net.mode === 'update') net.redirect = { ephemeral: isEphemeralRequest(options), messagePromise: null };
                return undefined;
            }
            return original.deferReply(options);
        };
    }

    if (original.deferUpdate) {
        interaction.deferUpdate = async (options = {}) => {
            const net = interaction._ackNet;
            noteHandlerAck(net);
            await waitForAutoAck(interaction);
            if (net?.autoAcked && !net.handlerAcked) {
                net.handlerAcked = true;
                return undefined;
            }
            return original.deferUpdate(options);
        };
    }

    if (original.update) {
        interaction.update = async (options = {}) => {
            const net = interaction._ackNet;
            noteHandlerAck(net);
            await waitForAutoAck(interaction);
            if (net?.autoAcked && !net.handlerAcked) {
                net.handlerAcked = true;
                // deferUpdate + editReply == update (the component's message is edited).
                return original.editReply(editOptions(options));
            }
            return original.update(options);
        };
    }

    if (original.showModal) {
        interaction.showModal = async (modal, options) => {
            const net = interaction._ackNet;
            noteHandlerAck(net);
            await waitForAutoAck(interaction);
            if (net?.autoAcked && !net.handlerAcked) {
                net.handlerAcked = true;
                (net.log || logger).warn(`Safety net: ${net.key} opened a form after the auto-acknowledgement; mark it opensModal so it is exempt`, {
                    event: 'interaction.safety_net.modal_after_ack',
                    key: net.key,
                });
                await original.followUp({ content: MODAL_TOO_LATE_MESSAGE, flags: MessageFlags.Ephemeral }).catch(() => {});
                return undefined;
            }
            return original.showModal(modal, options);
        };
    }

    if (original.deleteReply) {
        interaction.deleteReply = async (message) => {
            const net = interaction._ackNet;
            if ((message === undefined || message === '@original') && net?.redirect?.messagePromise) {
                const sent = await net.redirect.messagePromise;
                return original.deleteReply(sent.id);
            }
            return original.deleteReply(message);
        };
    }

    if (original.fetchReply) {
        interaction.fetchReply = async (message) => {
            const net = interaction._ackNet;
            if ((message === undefined || message === '@original') && net?.redirect?.messagePromise) {
                const sent = await net.redirect.messagePromise;
                return original.fetchReply(sent.id);
            }
            return original.fetchReply(message);
        };
    }
}

/**
 * The reply() side of the net, used by InteractionHelper's reply patch: after an auto-ack the
 * handler's first reply becomes editReply (command) or a follow-up that later editReply calls
 * edit (component). Returns { handled, result }.
 */
export async function replyThroughNet(interaction, options) {
    const net = interaction?._ackNet;
    noteHandlerAck(net);
    await waitForAutoAck(interaction);
    if (!net?.autoAcked || net.handlerAcked) return { handled: false };
    net.handlerAcked = true;
    if (net.mode === 'update') {
        net.redirect = { ephemeral: isEphemeralRequest(options), messagePromise: null };
        return { handled: true, result: await interaction.editReply(options) };
    }
    return { handled: true, result: await interaction.editReply(editOptions(options)) };
}

function acknowledgeMode(interaction) {
    const viaUpdate = interaction.isMessageComponent?.()
        || (interaction.isModalSubmit?.() && interaction.isFromMessage?.());
    return viaUpdate ? 'update' : 'reply';
}

function interactionAgeMs(interaction, now) {
    return interaction?.createdTimestamp ? Math.max(0, now() - interaction.createdTimestamp) : 0;
}

/** The delay before the auto-ack: AUTO_ACK_AFTER_MS, shortened when the interaction arrived late. */
export function autoAckDelayMs(interaction, { delayMs = AUTO_ACK_AFTER_MS, now = Date.now } = {}) {
    const age = interactionAgeMs(interaction, now);
    const remaining = ACK_TARGET_AGE_MS - age;
    return Math.max(MIN_AUTO_ACK_DELAY_MS, Math.min(delayMs, remaining));
}

/** The last-moment delay for a modal path (see MODAL_FALLBACK_AFTER_MS). */
export function modalFallbackDelayMs(interaction, { delayMs = MODAL_FALLBACK_AFTER_MS, now = Date.now } = {}) {
    const age = interactionAgeMs(interaction, now);
    return Math.max(MIN_AUTO_ACK_DELAY_MS, Math.min(delayMs, MODAL_FALLBACK_TARGET_AGE_MS - age));
}

/** A readable handler key for logs: "/ticket create", "button enf:act", "modal appeal". */
export function safetyNetKey(interaction) {
    if (!interaction) return 'unknown';
    if (interaction.isChatInputCommand?.() || interaction.isContextMenuCommand?.()) {
        let sub = null;
        try {
            sub = [interaction.options?.getSubcommandGroup?.(false), interaction.options?.getSubcommand?.(false)].filter(Boolean).join(' ');
        } catch {
            sub = null;
        }
        return `/${interaction.commandName}${sub ? ` ${sub}` : ''}`;
    }
    const kind = interaction.isButton?.() ? 'button' : interaction.isModalSubmit?.() ? 'modal' : interaction.isAnySelectMenu?.() ? 'select' : 'interaction';
    const [prefix, step] = String(interaction.customId || '').split(':');
    const stepPart = step && /^[a-z][a-z_-]{0,23}$/i.test(step) ? `:${step}` : '';
    return `${kind} ${prefix}${stepPart}`;
}

/** Whether a handler/command declares that this interaction opens a modal (exempt from the net). */
export function opensModal(handler, interaction, args = []) {
    const flag = handler?.opensModal;
    if (typeof flag === 'function') {
        try {
            return Boolean(flag(interaction, args));
        } catch {
            return true;
        }
    }
    return flag === true;
}

function logSlowHandler(net, { now, log }) {
    const at = now();
    const record = slowHandlerStats.get(net.key) || { key: net.key, count: 0, lastAt: 0, lastTotalMs: 0, maxTotalMs: 0 };
    const totalMs = at - net.armedAt;
    record.count += 1;
    record.lastAt = at;
    record.lastTotalMs = totalMs;
    record.maxTotalMs = Math.max(record.maxTotalMs, totalMs);
    slowHandlerStats.set(net.key, record);

    const last = lastSlowLogByKey.get(net.key);
    if (last != null && at - last < SLOW_HANDLER_LOG_INTERVAL_MS) return false;
    lastSlowLogByKey.set(net.key, at);
    log.warn(`Slow handler: ${net.key} needed the 3-second safety net (auto-acknowledged after ${net.firedAfterMs} ms, finished after ${totalMs} ms)`, {
        event: 'interaction.safety_net.used',
        key: net.key,
        firedAfterMs: net.firedAfterMs,
        totalMs,
        reason: net.reason,
    });
    return true;
}

/** Handlers that needed the net since start: [{ key, count, lastAt, lastTotalMs, maxTotalMs }], slowest first. */
export function getSlowHandlerStats() {
    return [...slowHandlerStats.values()].map((r) => ({ ...r })).sort((a, b) => b.maxTotalMs - a.maxTotalMs);
}

/** For tests. */
export function resetSafetyNetLog() {
    lastSlowLogByKey.clear();
    slowHandlerStats.clear();
}

/**
 * Arms the net on an interaction. Returns the net: { fireNow(reason), disarm(), ... }.
 * `exempt` (a modal path): only the last-moment fallback (modalDelayMs) is armed.
 */
export function armAckSafetyNet(interaction, {
    key = safetyNetKey(interaction),
    exempt = false,
    ephemeral = true,
    delayMs = AUTO_ACK_AFTER_MS,
    modalDelayMs = MODAL_FALLBACK_AFTER_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = logger,
} = {}) {
    installAckWrappers(interaction);
    const original = interaction.__ackOriginals || {};
    const net = {
        key,
        exempt,
        mode: acknowledgeMode(interaction),
        armedAt: now(),
        autoAcked: false,
        handlerAcked: false,
        acking: null,
        redirect: null,
        expired: false,
        disarmed: false,
        firedAfterMs: null,
        reason: null,
        timer: null,
        log,
    };
    interaction._ackNet = net;

    const canFire = () => !net.disarmed && !net.autoAcked && !net.acking && !net.handlerAcked
        && !interaction.deferred && !interaction.replied && !interaction._isPrefixCommand;

    net.fireNow = (reason = 'slow') => {
        if (net.timer) {
            clearTimer(net.timer);
            net.timer = null;
        }
        if (!canFire()) return net.acking || Promise.resolve(false);
        net.reason = reason;
        net.firedAfterMs = now() - net.armedAt;
        const ack = net.mode === 'update'
            ? original.deferUpdate?.()
            : original.deferReply?.(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
        net.acking = Promise.resolve(ack).then(() => {
            net.autoAcked = true;
            return true;
        }, (error) => {
            if (error?.code === EXPIRED_INTERACTION_CODE) {
                net.expired = true;
            } else if (error?.code === ALREADY_ACKED_CODE || error?.name === 'InteractionAlreadyReplied' || error?.code === 'InteractionAlreadyReplied') {
                net.handlerAcked = true;
            } else {
                log.warn(`Safety net: auto-acknowledgement for ${net.key} failed: ${error?.message || error}`, {
                    event: 'interaction.safety_net.failed',
                    key: net.key,
                });
            }
            return false;
        }).finally(() => {
            net.acking = null;
        });
        return net.acking;
    };

    net.disarm = () => {
        if (net.disarmed) return;
        net.disarmed = true;
        if (net.timer) {
            clearTimer(net.timer);
            net.timer = null;
        }
        if (net.firedAfterMs != null && net.reason !== 'startup') logSlowHandler(net, { now, log });
    };

    if (!interaction._isPrefixCommand) {
        const delay = exempt ? modalFallbackDelayMs(interaction, { delayMs: modalDelayMs, now }) : autoAckDelayMs(interaction, { delayMs, now });
        net.timer = setTimer(() => {
            net.timer = null;
            void net.fireNow(exempt ? 'modal-late' : 'slow');
        }, delay);
        net.timer?.unref?.();
    }
    return net;
}

// ── Startup readiness ─────────────────────────────────────────────────────

let startupCachesLoaded = false;
const warmWaiters = new Set();

/** ready.js calls this once the startup caches (blacklist, watchlist, community) are loaded. */
export function markInteractionsWarm() {
    startupCachesLoaded = true;
    for (const resolve of warmWaiters) resolve(true);
    warmWaiters.clear();
}

/** For tests. */
export function resetInteractionsWarm() {
    startupCachesLoaded = false;
}

/** False while the bot is starting (gateway not ready, startup caches loading) or the database is known down. */
export function interactionsAreWarm(client) {
    if (typeof client?.isReady === 'function' && !client.isReady()) return false;
    if (!startupCachesLoaded) return false;
    if (typeof client?.db?.isAvailable === 'function' && !client.db.isAvailable()) return false;
    return true;
}

/** Waits (at most timeoutMs) for the startup caches. Resolves true when warm. */
export function waitForStartupCaches(timeoutMs = 10_000) {
    if (startupCachesLoaded) return Promise.resolve(true);
    return new Promise((resolve) => {
        const done = (value) => {
            clearTimeout(timer);
            warmWaiters.delete(done);
            resolve(value);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        timer.unref?.();
        warmWaiters.add(done);
    });
}
