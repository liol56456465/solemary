// dashboard.js — small enhancements for the Meowist web dashboard.
//
// Progressive enhancement only: every page and form works without this file (CSP
// script-src 'self', no inline scripts). Nothing here talks to the network; it only
// changes how the page behaves in the browser.
//
//   select[data-search]     a filter box above long channel / role lists
//   form[data-confirm]      asks before a destructive submit
//   form[data-dirty]        warns before leaving the page with unsaved changes
//   [data-copy]             a copy-to-clipboard button (case codes)
//   time[data-relative]     "in 3 h" / "5 min ago" (the UTC time stays in the tooltip)
//   details[data-key]       remembers which sections were open (per page)
//   #nav-toggle             the mobile drawer: Escape and link clicks close it

(function () {
    'use strict';

    const store = {
        get(key) {
            try { return window.localStorage.getItem(key); } catch { return null; }
        },
        set(key, value) {
            try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
        },
    };

    // ── Searchable selects ───────────────────────────────────────────────
    function enhanceSelect(select) {
        if (select.dataset.enhanced) return;
        select.dataset.enhanced = '1';
        const input = document.createElement('input');
        input.type = 'search';
        input.className = 'select-filter';
        input.placeholder = 'Type to filter…';
        input.setAttribute('aria-label', 'Filter the list below');
        input.autocomplete = 'off';
        select.parentNode.insertBefore(input, select);
        input.addEventListener('input', () => {
            const needle = input.value.trim().toLowerCase();
            let first = null;
            for (const option of select.options) {
                const match = !needle || option.value === '' || option.textContent.toLowerCase().includes(needle);
                option.hidden = !match;
                if (match && !first && option.value !== '') first = option;
            }
            for (const group of select.querySelectorAll('optgroup')) {
                group.hidden = ![...group.children].some((o) => !o.hidden);
            }
            // A single select jumps to the first match so Enter/submit picks it.
            if (!select.multiple && needle && first && select.selectedOptions[0]?.hidden) first.selected = true;
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') event.preventDefault();
        });
    }

    // ── Confirm before destructive submits ───────────────────────────────
    document.addEventListener('submit', (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const message = form.dataset.confirm;
        if (message && !window.confirm(message)) {
            event.preventDefault();
            return;
        }
        form.dataset.submitting = '1';
        const button = form.querySelector('button[type="submit"]');
        if (button) {
            // Avoid double submits; re-enabled if the user comes back (bfcache).
            window.setTimeout(() => { button.disabled = true; }, 0);
        }
    }, true);

    window.addEventListener('pageshow', () => {
        for (const button of document.querySelectorAll('button[type="submit"][disabled]')) {
            if (!button.closest('fieldset[disabled]')) button.disabled = false;
        }
        for (const form of document.querySelectorAll('form[data-submitting]')) delete form.dataset.submitting;
    });

    // ── Unsaved changes ──────────────────────────────────────────────────
    const dirty = new Set();
    document.addEventListener('input', (event) => {
        const form = event.target.closest?.('form[data-dirty]');
        if (form && !event.target.classList.contains('select-filter')) {
            dirty.add(form);
            form.classList.add('is-dirty');
        }
    });
    window.addEventListener('beforeunload', (event) => {
        const pending = [...dirty].some((form) => document.contains(form) && !form.dataset.submitting);
        if (pending) {
            event.preventDefault();
            event.returnValue = '';
        }
    });

    // ── Copy to clipboard ────────────────────────────────────────────────
    function addCopyButton(element) {
        if (element.dataset.copyReady || !navigator.clipboard) return;
        element.dataset.copyReady = '1';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'copy';
        button.textContent = 'Copy';
        button.setAttribute('aria-label', `Copy ${element.dataset.copy}`);
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await navigator.clipboard.writeText(element.dataset.copy);
                button.textContent = 'Copied';
            } catch {
                button.textContent = 'Copy failed';
            }
            window.setTimeout(() => { button.textContent = 'Copy'; }, 1500);
        });
        element.insertAdjacentElement('afterend', button);
    }

    // ── Relative times ───────────────────────────────────────────────────
    const units = [['d', 86400], ['h', 3600], ['min', 60]];
    function relative(date) {
        const seconds = Math.round((date.getTime() - Date.now()) / 1000);
        const abs = Math.abs(seconds);
        if (abs < 60) return seconds >= 0 ? 'in under a minute' : 'just now';
        const [unit, size] = units.find(([, s]) => abs >= s) || units[units.length - 1];
        const n = Math.floor(abs / size);
        return seconds >= 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
    }
    function updateTimes() {
        for (const el of document.querySelectorAll('time[data-relative]')) {
            const date = new Date(el.getAttribute('datetime'));
            if (Number.isNaN(date.getTime())) continue;
            if (!el.title) el.title = el.textContent.trim();
            el.textContent = relative(date);
        }
    }

    // ── Remember open sections ───────────────────────────────────────────
    function rememberDetails(details) {
        const key = `meowist:open:${window.location.pathname}:${details.dataset.key}`;
        const saved = store.get(key);
        if (saved === '1') details.open = true;
        if (saved === '0') details.open = false;
        details.addEventListener('toggle', () => store.set(key, details.open ? '1' : '0'));
    }

    // ── Mobile drawer ────────────────────────────────────────────────────
    function setupDrawer() {
        const toggle = document.getElementById('nav-toggle');
        if (!toggle) return;
        const button = document.querySelector('label[for="nav-toggle"]');
        const sync = () => button?.setAttribute('aria-expanded', toggle.checked ? 'true' : 'false');
        toggle.addEventListener('change', sync);
        sync();
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && toggle.checked) {
                toggle.checked = false;
                sync();
                button?.focus();
            }
        });
        for (const link of document.querySelectorAll('.sidebar a')) {
            link.addEventListener('click', () => { toggle.checked = false; sync(); });
        }
        // The label acts as a button: Enter / Space open it from the keyboard.
        button?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle.checked = !toggle.checked;
                sync();
            }
        });
    }

    function init() {
        document.documentElement.classList.add('js');
        document.querySelectorAll('select[data-search]').forEach(enhanceSelect);
        document.querySelectorAll('[data-copy]').forEach(addCopyButton);
        document.querySelectorAll('details[data-key]').forEach(rememberDetails);
        updateTimes();
        window.setInterval(updateTimes, 60 * 1000);
        setupDrawer();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}());
