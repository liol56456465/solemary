// common.js — helpers shared by the module pages.

import { html, raw, slug, unsavedAttr } from '../html.js';
import { currentText, textFor } from '../language.js';

export { slug };

/**
 * Splits a long help text into its first sentence (shown under the card title) and the
 * rest (behind "More about this"). Short texts and markup (SafeHtml) stay whole; an array
 * [line, more] is a hand-written split.
 */
export function splitHelp(help) {
    // A hand-written pair: [short line, the rest].
    if (Array.isArray(help)) return [help[0] || '', help[1] || ''];
    if (typeof help !== 'string' || help.length <= 110) return [help, ''];
    const match = help.match(/^(.{20,}?[.!?:])\s+(?=[A-Z/(“"])/);
    if (!match) return [help, ''];
    return [match[1], help.slice(match[0].length)];
}

/**
 * A settings card on a module page (v6 layout): bold title, one short line of what it
 * controls, then its settings (usually its own form with its own Save). Cards sit in a grid
 * (moduleSettingsPage wraps the page, `topic` wraps a group). options:
 * { key, size: 'auto' | 'normal' | 'wide' | 'full' }: 'auto' gives a card with a table the full row;
 * 'wide' is the same (the settings grid has two columns); both lay their fields out in two columns.
 * `open` / `collapsible` (old collapsible sections) are accepted and ignored: cards are always open.
 */
export function section(title, body, help = '', { key = slug(title), size = 'auto' } = {}) {
    const [line, more] = splitHelp(help);
    const width = size === 'auto' ? (/<table[\s>]/.test(String(body)) ? 'full' : 'normal') : size;
    return html`<section class="tile-card section${width === 'normal' ? '' : ` size-${width}`}" id="s-${key}" data-card="${key}"><header class="card-top"><h2 class="card-title"${unsavedAttr()}>${title}</h2>${line ? html`<p class="card-desc">${line}</p>` : ''}${more ? html`<details class="card-more"><summary>${currentText().t('frame.module.more')}</summary><p>${more}</p></details>` : ''}</header><div class="section-body">${body}</div></section>`;
}

/**
 * A group of cards about one topic: a heading with one plain line, then the cards in a grid.
 * The cards' titles become h3 under the topic's h2.
 */
export function topic(title, line, cards, { key = slug(title) } = {}) {
    const inner = String(html`${cards}`).replace(/<h2 class="card-title"([^>]*)>([\s\S]*?)<\/h2>/g, '<h3 class="card-title"$1>$2</h3>');
    return html`<section class="topic" id="g-${key}"><header class="topic-head"><h2>${title}</h2>${line ? html`<p>${line}</p>` : ''}</header><div class="card-grid">${raw(inner)}</div></section>`;
}
import { guildIdFor, isOtherGuild, resolveSetting, resolvedSource, settingGuildId, settingSource } from '../../settings/guildSettings.js';
import { getSettingEntry, neutralValue } from '../../settings/settingsRegistry.js';
import { InputError, intField } from '../forms.js';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A plain table: headers + rows of cells (SafeHtml or text). */
export function table(headers, rows, empty = currentText().t('frame.module.none')) {
    if (!rows.length) return html`<p class="muted">${empty}</p>`;
    return html`<div class="scroll"><table><thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>
${rows.map((cells) => html`<tr>${cells.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}

const envOf = (ctx) => ctx?.env || process.env;

/** The server the dashboard request is for: ctx.guildId, else the main server. */
function ctxGuildId(ctx) {
    return (typeof ctx?.guildId === 'string' && ctx.guildId.trim()) || guildIdFor('main', envOf(ctx));
}

/**
 * The guild id a registry key is read from / saved to on this dashboard (settingGuildId):
 * in Mewvo's home servers the registry's main or support server, as before; in any other
 * server ctx.guildId, or null for support-server and homeOnly keys (it has none of its own).
 * The old form registryGuildId(key, env) (no ctx) still means "the main server's dashboard".
 */
export function registryGuildId(ctx, key) {
    if (typeof ctx === 'string') return settingGuildId(null, ctx, key || process.env); // old form (key, env)
    return settingGuildId(ctxGuildId(ctx), key, envOf(ctx));
}

/**
 * Saves registry settings (guild_settings) through the settings service, which validates
 * them and writes the dashboard_audit rows itself. Returns an action result. A server other
 * than Mewvo's own writes only its own row (ctx.guildId); a key it does not have is refused.
 */
export async function saveRegistry(ctx, patch, module) {
    const other = isOtherGuild(ctxGuildId(ctx), envOf(ctx));
    const byGuild = new Map();
    for (const [key, value] of Object.entries(patch)) {
        const guildId = registryGuildId(ctx, key);
        if (!guildId) {
            const label = getSettingEntry(key).label;
            throw new InputError(textFor(ctx).t(other ? 'common.homeOnlySetting' : 'common.serverNotConfigured', { label }));
        }
        if (!byGuild.has(guildId)) byGuild.set(guildId, {});
        byGuild.get(guildId)[key] = value;
    }
    const changes = [];
    for (const [guildId, part] of byGuild) {
        const result = await ctx.services.updateSettings(guildId, part, { userId: ctx.actor.userId, username: ctx.actor.username, module }, ctx.env);
        changes.push(...result.changes.map((c) => ({ key: c.key, old: c.old, new: c.new })));
    }
    return { changes, audited: true };
}

/**
 * A read-modify-write of registry settings under the row lock (updateSettings with a build
 * function): build(valueOf) gets the locked current values and returns the patch (or null / {}
 * for nothing; it may throw an InputError to refuse, and nothing is written then). All `keys`
 * must live on the same server row. Returns an action result like saveRegistry.
 */
export async function saveRegistryWith(ctx, keys, build, module) {
    const other = isOtherGuild(ctxGuildId(ctx), envOf(ctx));
    const guildIds = new Set();
    for (const key of keys) {
        const guildId = registryGuildId(ctx, key);
        if (!guildId) {
            const label = getSettingEntry(key).label;
            throw new InputError(textFor(ctx).t(other ? 'common.homeOnlySetting' : 'common.serverNotConfigured', { label }));
        }
        guildIds.add(guildId);
    }
    if (guildIds.size !== 1) throw new Error(`saveRegistryWith: ${keys.join(', ')} are not on one server row`);
    const [guildId] = guildIds;
    const result = await ctx.services.updateSettings(guildId, build, { userId: ctx.actor.userId, username: ctx.actor.username, module }, ctx.env);
    return { changes: result.changes.map((c) => ({ key: c.key, old: c.old, new: c.new })), audited: true };
}

/**
 * The current value of a registry key on this dashboard. Home servers: the registry's server,
 * as before (getSetting, which equals resolveSetting there). Any other server: resolveSetting
 * of its own row (no env or home fallbacks), neutralValue() for a key it does not have.
 */
export function registryValue(ctx, key) {
    const guildId = registryGuildId(ctx, key);
    if (!isOtherGuild(ctxGuildId(ctx), envOf(ctx))) return ctx.services.getSetting(guildId, key, ctx.env);
    if (!guildId) return neutralValue(getSettingEntry(key));
    return (ctx.services.resolveSetting || resolveSetting)(guildId, key, envOf(ctx));
}

/**
 * True when this server saved `key` itself (not a default). A failed read counts as saved, so a
 * caller falls back to its old "same value: nothing changed" rule (the save itself still checks).
 */
export function registrySaved(ctx, key) {
    try {
        const guildId = registryGuildId(ctx, key);
        if (!guildId) return false;
        if (ctx.services?.registrySource) return ctx.services.registrySource(guildId, key) === 'database';
        if (!isOtherGuild(ctxGuildId(ctx), envOf(ctx))) return settingSource(guildId, key, envOf(ctx)) === 'database';
        return resolvedSource(guildId, key, envOf(ctx)) === 'database';
    } catch {
        return true;
    }
}

/** A duration field typed in `unitMs` units (days, minutes, …), returned in ms. */
export function durationField(form, name, unitMs, { min, max, label }) {
    return intField(form, name, { min, max, label }) * unitMs;
}

/** Only the keys whose value differs from `current`. */
export function changedOnly(patch, current) {
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(value ?? null) !== JSON.stringify(current?.[key] ?? null)) out[key] = value;
    }
    return out;
}

/** "Nothing changed." result (the message in the running request's language). */
export const NOTHING = Object.freeze({
    changes: [],
    get message() { return currentText().t('errors.nothingChanged'); },
});
