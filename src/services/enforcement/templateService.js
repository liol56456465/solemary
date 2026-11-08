// templateService.js: one-click presets for /enforcements ("Spam: 1h mute").
//
// Stored as the setting enforcementTemplates (main server, edited on the dashboard's
// Enforcement page): up to 10 of { name, action: warn|mute|kick|ban, reasonKey (a prebuilt
// reason), duration ("1h", "7d"; a mute needs one, a ban without one is permanent) }.
// Picking one in the panel fills the action, reason and duration and goes straight to the
// confirm step; the normal checks (hierarchy, ladder, mass-action guard) still run.

import { createHash, randomBytes } from 'node:crypto';
import { getReason } from '../../config/enforcement.js';
import { parseDuration } from './format.js';

export const TEMPLATE_ACTIONS = ['warn', 'mute', 'kick', 'ban'];
export const MAX_TEMPLATES = 10;
export const TEMPLATE_NAME_MAX = 40;
/** A template's stable id (dashboard remove-by-id): 't' + 10 lowercase hex characters. */
export const TEMPLATE_ID = /^t[0-9a-f]{10}$/;

/** The id of a template saved before ids existed: derived from its (unique) name, so it is the same on every read. */
export function derivedTemplateId(name) {
    return `t${createHash('sha256').update(String(name ?? '').toLowerCase()).digest('hex').slice(0, 10)}`;
}

/** A fresh id for a new template. */
export function newTemplateId() {
    return `t${randomBytes(5).toString('hex')}`;
}

/** The list with every template's id: stored ids kept, missing ones derived (nothing is saved here). */
export function withTemplateIds(list) {
    return (Array.isArray(list) ? list : []).map((t) => (t && TEMPLATE_ID.test(t.id || '') ? t : { ...t, id: derivedTemplateId(t?.name) }));
}

export class TemplateError extends Error {
    constructor(message) { super(message); this.userMessage = message; }
}

/** Checks one template; returns it cleaned. Throws TemplateError with a readable message. */
export function cleanTemplate(input = {}) {
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new TemplateError('Give the template a name.');
    if (name.length > TEMPLATE_NAME_MAX) throw new TemplateError(`Keep the name under ${TEMPLATE_NAME_MAX} characters.`);
    const action = String(input.action ?? '');
    if (!TEMPLATE_ACTIONS.includes(action)) throw new TemplateError('Choose warn, mute, kick or ban.');
    const reasonKey = String(input.reasonKey ?? '');
    if (!getReason(reasonKey)) throw new TemplateError('Choose one of the prebuilt reasons.');
    const raw = String(input.duration ?? '').trim().toLowerCase();
    let duration = null;
    if (action === 'mute' || action === 'ban') {
        if (raw && raw !== 'permanent') {
            if (parseDuration(raw) == null) throw new TemplateError(`"${raw.slice(0, 20)}" is not a duration. Use 30m, 24h, 7d or 1mo.`);
            duration = raw;
        }
        if (action === 'mute' && !duration) throw new TemplateError('A mute template needs a duration, like 1h.');
    }
    const id = typeof input.id === 'string' && TEMPLATE_ID.test(input.id) ? input.id : undefined;
    return { ...(id ? { id } : {}), name, action, reasonKey, duration };
}

/** The whole list (the setting's schema uses this). */
export function cleanTemplates(list) {
    if (!Array.isArray(list)) throw new TemplateError('Templates must be a list.');
    if (list.length > MAX_TEMPLATES) throw new TemplateError(`At most ${MAX_TEMPLATES} templates.`);
    const out = list.map(cleanTemplate);
    const names = new Set();
    const ids = new Set();
    for (const t of out) {
        if (t.id) {
            if (ids.has(t.id)) throw new TemplateError('Two templates have the same id.');
            ids.add(t.id);
        }
        const key = t.name.toLowerCase();
        if (names.has(key)) throw new TemplateError(`There is already a template called "${t.name}".`);
        names.add(key);
    }
    return out;
}

/** "Spam: 1h mute", "Raiding: permanent ban", "Rude: warn". */
export function templateLabel(t) {
    if (t.action === 'mute') return `${t.duration} mute`;
    if (t.action === 'ban') return t.duration ? `${t.duration} ban` : 'permanent ban';
    return t.action;
}

/** Templates usable right now: only for actions the panel offers for this member. [{ index, template }] */
export function usableTemplates(templates, availableActions) {
    const allowed = new Set(availableActions);
    return (templates || []).map((template, index) => ({ index, template })).filter(({ template }) => allowed.has(template.action));
}

/** The flow fields a template sets (reason, duration); the action is the flow type. */
export function templatePatch(t) {
    const reason = getReason(t.reasonKey);
    const durationMs = t.duration ? parseDuration(t.duration) : null;
    return {
        reasonKey: t.reasonKey,
        reasonSource: 'prebuilt',
        reason: reason.label,
        unappealable: t.action === 'ban' ? Boolean(reason.severe) : false,
        ...(t.action === 'mute' || t.action === 'ban' ? { durationInput: t.duration || '', durationMs } : {}),
        evidenceInput: '',
        evidenceEntries: [],
        templateName: t.name,
    };
}
