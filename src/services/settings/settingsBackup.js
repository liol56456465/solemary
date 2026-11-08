// settingsBackup.js: Dashboard → Settings backup. Download every registry setting of the main
// and support server as one JSON file, and load such a file back.
//
// Loading never writes blindly: planBackup() checks the file (format, known keys, right
// server, each value against the setting's schema) and lists what would change; the page
// shows that, and only "Apply" writes, through updateSettingsBatch (one transaction, row-locked, audited).
// Sensitive settings are never exported or imported.

import { SETTINGS, getSettingEntry, validateSetting } from './settingsRegistry.js';
import { getSetting, guildIdFor, updateSettingsBatch } from './guildSettings.js';

export const BACKUP_FORMAT = 'mewvo-settings-v1';
export const BACKUP_MAX_BYTES = 200 * 1024;
const GUILDS = ['main', 'support'];

const exportable = (entry) => !entry.sensitive;

/** The backup object for both servers (current values, including defaults). */
export function exportSettings({ env = process.env, now = new Date(), read = getSetting } = {}) {
    const guilds = {};
    for (const guild of GUILDS) {
        const guildId = guildIdFor(guild, env);
        if (!guildId) continue;
        const values = {};
        for (const entry of SETTINGS) {
            if (entry.guild !== guild || !exportable(entry)) continue;
            values[entry.key] = read(guildId, entry.key, env);
        }
        guilds[guild] = { guildId, settings: values };
    }
    return { format: BACKUP_FORMAT, exportedAt: now.toISOString(), guilds };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Checks a backup file's text. Returns { ok: false, error } or
 * { ok: true, changes: [{ guild, key, label, old, new }], problems: [text], patches: { main: {}, support: {} } }.
 * Problems (an unknown key, a value that fails its check) are listed and skipped; the rest can be applied.
 */
export function planBackup(textInput, { env = process.env, read = getSetting } = {}) {
    const text = String(textInput ?? '');
    if (!text.trim()) return { ok: false, error: 'The file is empty.' };
    if (Buffer.byteLength(text, 'utf8') > BACKUP_MAX_BYTES) return { ok: false, error: 'The file is too big for a settings backup.' };
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return { ok: false, error: 'That is not a JSON file.' };
    }
    if (data?.format !== BACKUP_FORMAT || !data.guilds || typeof data.guilds !== 'object') {
        return { ok: false, error: 'That is not a Mewvo settings backup.' };
    }
    const changes = [];
    const problems = [];
    const patches = { main: {}, support: {} };
    for (const guild of GUILDS) {
        const section = data.guilds[guild];
        if (!section) continue;
        const guildId = guildIdFor(guild, env);
        if (!guildId) { problems.push(`The ${guild} server is not configured here; its settings were skipped.`); continue; }
        const settings = section.settings && typeof section.settings === 'object' ? section.settings : {};
        for (const [key, value] of Object.entries(settings)) {
            const entry = getSettingEntry(key);
            if (!entry) { problems.push(`Unknown setting "${String(key).slice(0, 60)}" skipped.`); continue; }
            if (entry.guild !== guild) { problems.push(`${entry.label} belongs to the ${entry.guild} server; skipped.`); continue; }
            if (!exportable(entry)) { problems.push(`${entry.label} is never loaded from a file; skipped.`); continue; }
            const check = validateSetting(key, value);
            if (!check.ok) { problems.push(`${check.error}; skipped.`); continue; }
            const old = read(guildId, key, env);
            if (same(old, check.value)) continue;
            patches[guild][key] = check.value;
            changes.push({ guild, key, label: entry.label, old, new: check.value });
        }
    }
    return { ok: true, changes, problems, patches };
}

/**
 * Writes a plan's patches for both servers in ONE transaction (updateSettingsBatch): all are
 * saved, or none (a failure leaves every setting as it was). Returns the number of changed settings.
 */
export async function applyBackup(plan, actor, { env = process.env, updateBatch = updateSettingsBatch } = {}) {
    const writes = [];
    for (const guild of GUILDS) {
        const patch = plan.patches[guild];
        if (!patch || !Object.keys(patch).length) continue;
        writes.push({ guildId: guildIdFor(guild, env), patch });
    }
    if (!writes.length) return 0;
    const result = await updateBatch(writes, { ...actor, module: 'backup' }, env);
    return result.changes.length;
}
