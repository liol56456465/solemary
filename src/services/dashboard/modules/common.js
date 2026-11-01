// common.js — helpers shared by the module pages.

import { html, raw, slug } from '../html.js';

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
    return html`<section class="tile-card section${width === 'normal' ? '' : ` size-${width}`}" id="s-${key}" data-card="${key}"><header class="card-top"><h2 class="card-title">${title}</h2>${line ? html`<p class="card-desc">${line}</p>` : ''}${more ? html`<details class="card-more"><summary>More about this</summary><p>${more}</p></details>` : ''}</header><div class="section-body">${body}</div></section>`;
}

/**
 * A group of cards about one topic: a heading with one plain line, then the cards in a grid.
 * The cards' titles become h3 under the topic's h2.
 */
export function topic(title, line, cards, { key = slug(title) } = {}) {
    const inner = String(html`${cards}`).replace(/<h2 class="card-title">([\s\S]*?)<\/h2>/g, '<h3 class="card-title">$1</h3>');
    return html`<section class="topic" id="g-${key}"><header class="topic-head"><h2>${title}</h2>${line ? html`<p>${line}</p>` : ''}</header><div class="card-grid">${raw(inner)}</div></section>`;
}
import { guildIdFor } from '../../settings/guildSettings.js';
import { getSettingEntry } from '../../settings/settingsRegistry.js';
import { InputError, intField } from '../forms.js';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A plain table: headers + rows of cells (SafeHtml or text). */
export function table(headers, rows, empty = 'None.') {
    if (!rows.length) return html`<p class="muted">${empty}</p>`;
    return html`<div class="scroll"><table><thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>
${rows.map((cells) => html`<tr>${cells.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}

/** The guild id a registry key lives on (main or support). */
export function registryGuildId(key, env = process.env) {
    return guildIdFor(getSettingEntry(key).guild, env);
}

/**
 * Saves registry settings (guild_settings) through the settings service, which validates
 * them and writes the dashboard_audit rows itself. Returns an action result.
 */
export async function saveRegistry(ctx, patch, module) {
    const byGuild = new Map();
    for (const [key, value] of Object.entries(patch)) {
        const guildId = registryGuildId(key, ctx.env);
        if (!guildId) throw new InputError(`${getSettingEntry(key).label}: the server for this setting is not configured.`);
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

/** The current value of a registry key. */
export function registryValue(ctx, key) {
    return ctx.services.getSetting(registryGuildId(key, ctx.env), key, ctx.env);
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

/** "Nothing changed." result. */
export const NOTHING = Object.freeze({ changes: [], message: 'Nothing changed.' });
