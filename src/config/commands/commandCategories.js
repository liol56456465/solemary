/**
 * Command category metadata for the command access manager.
 */

// Categories show as plain names (no emoji). Kept as a map so an icon can be
// added back for one category without touching the callers.
export const CATEGORY_ICONS = {};

/** Commands that always stay available so admins can recover access. */
export const PROTECTED_COMMANDS = new Set(['commands', 'configwizard']);

export function normalizeCategoryKey(category) {
  return String(category || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

export function formatCategoryName(rawCategory) {
  return String(rawCategory || '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * A command folder's name in `tr`'s language (bot catalog core.categories.<Folder>), else the
 * folder name made readable ("Reaction_roles" → "Reaction Roles").
 */
export function categoryLabel(category, tr) {
  const key = `core.categories.${category}`;
  try {
    if (category && tr?.has?.(key)) return tr.t(key);
  } catch {
    // an odd folder name is shown as it is
  }
  return formatCategoryName(category);
}

export function getCategoryIcon(category) {
  return CATEGORY_ICONS[category] || CATEGORY_ICONS[formatCategoryName(category)] || '';
}
