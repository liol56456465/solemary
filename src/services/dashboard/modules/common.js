// common.js — helpers shared by the module pages.

import { html, raw } from '../html.js';
import { guildIdFor } from '../../settings/guildSettings.js';
import { getSettingEntry } from '../../settings/settingsRegistry.js';
import { InputError, intField } from '../forms.js';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "Channel exceptions" → "channel-exceptions" (a stable key for remembering open sections). */
export function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section';
}

/**
 * A titled block on a module page: a collapsible card (<details>, keyboard accessible
 * without JS; the static script remembers which ones were open). options:
 * { open (default true), collapsible (default true), key }.
 */
export function section(title, body, help = '', { open = true, collapsible = true, key = slug(title) } = {}) {
    const inner = html`${help ? html`<p class="muted section-help">${help}</p>` : ''}${body}`;
    if (!collapsible) return html`<section class="card"><h2>${title}</h2>${inner}</section>`;
    return html`<details class="card section" data-key="${key}"${open ? raw(' open') : ''}><summary><h2>${title}</h2></summary><div class="section-body">${inner}</div></details>`;
}

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
