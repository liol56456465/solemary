// autocompleteDeadline.js — autocomplete must be answered within 3 seconds and can't be
// deferred. runAutocompleteWithDeadline() runs a handler and, if it hasn't called respond()
// by the deadline, answers for it with the last choices that handler returned for the same
// server, command and option (filtered by what the user typed), or an empty list. The
// handler's own late respond() is then dropped (a second respond would fail anyway).
// A slow autocomplete is logged as a warning once per command per hour.

import { logger } from './logger.js';
import { BoundedMap } from './boundedMap.js';

export const AUTOCOMPLETE_DEADLINE_MS = 2500;
const AUTOCOMPLETE_TARGET_AGE_MS = 2700;
const MIN_DEADLINE_MS = 200;
const LOG_INTERVAL_MS = 60 * 60 * 1000;
const MAX_CHOICES = 25;

const lastChoices = new BoundedMap(1000);
const lastLogByKey = new BoundedMap(200);

function focusedOption(interaction) {
    try {
        return interaction.options?.getFocused?.(true) || null;
    } catch {
        return null;
    }
}

function cacheKey(interaction, focused) {
    return `${interaction.guildId || 'dm'}:${interaction.commandName}:${focused?.name || ''}`;
}

/** The cached choices that still match what the user typed. */
export function cachedChoicesFor(choices, typed) {
    const query = String(typed ?? '').trim().toLowerCase();
    const list = Array.isArray(choices) ? choices : [];
    const matching = query ? list.filter((c) => String(c?.name ?? '').toLowerCase().includes(query)) : list;
    return matching.slice(0, MAX_CHOICES);
}

export function autocompleteDeadlineMs(interaction, { timeoutMs = AUTOCOMPLETE_DEADLINE_MS, now = Date.now } = {}) {
    const age = interaction?.createdTimestamp ? Math.max(0, now() - interaction.createdTimestamp) : 0;
    return Math.max(MIN_DEADLINE_MS, Math.min(timeoutMs, AUTOCOMPLETE_TARGET_AGE_MS - age));
}

/** For tests. */
export function resetAutocompleteDeadlineState() {
    lastChoices.clear();
    lastLogByKey.clear();
}

/**
 * Runs handler(interaction) and guarantees one respond() before the deadline.
 * Returns 'handler' | 'timeout' | 'error' | 'empty' (who answered).
 */
export async function runAutocompleteWithDeadline(interaction, handler, {
    timeoutMs = AUTOCOMPLETE_DEADLINE_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = logger,
} = {}) {
    const originalRespond = interaction.respond.bind(interaction);
    const focused = focusedOption(interaction);
    const key = cacheKey(interaction, focused);
    const startedAt = now();
    let responded = false;
    let outcome = null;

    interaction.respond = async (choices) => {
        if (responded) return undefined;
        responded = true;
        outcome = 'handler';
        const list = Array.isArray(choices) ? choices.slice(0, MAX_CHOICES) : [];
        lastChoices.set(key, list);
        return originalRespond(list);
    };

    const timer = setTimer(() => {
        if (responded) return;
        responded = true;
        outcome = 'timeout';
        const fallback = cachedChoicesFor(lastChoices.get(key), focused?.value);
        originalRespond(fallback).catch(() => {});
        const commandKey = `/${interaction.commandName} ${focused?.name || ''}`.trim();
        const at = now();
        if (!lastLogByKey.has(commandKey) || at - lastLogByKey.get(commandKey) >= LOG_INTERVAL_MS) {
            lastLogByKey.set(commandKey, at);
            log.warn(`Slow autocomplete: ${commandKey} did not answer within ${at - startedAt} ms; sent ${fallback.length} cached choice(s)`, {
                event: 'interaction.autocomplete.timeout',
                key: commandKey,
                elapsedMs: at - startedAt,
                cachedChoices: fallback.length,
            });
        }
    }, autocompleteDeadlineMs(interaction, { timeoutMs, now }));
    timer?.unref?.();

    try {
        await handler(interaction);
    } catch (error) {
        log.error('Error handling command autocomplete:', {
            error: error?.message,
            guildId: interaction.guildId,
            commandName: interaction.commandName,
        });
        if (!responded) {
            responded = true;
            outcome = 'error';
            await originalRespond([]).catch(() => {});
        }
    } finally {
        clearTimer(timer);
    }

    if (!responded) {
        responded = true;
        outcome = 'empty';
        await originalRespond([]).catch(() => {});
    }
    return outcome;
}
