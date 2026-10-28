// dashboard.js — small enhancements for the Meowist web dashboard.
//
// Progressive enhancement only: every page and form works without this file (CSP
// script-src 'self', no inline scripts). Nothing here talks to the network; it only
// changes how the page behaves in the browser.
//
//   select[data-search]     a filter box above long channel / role lists
//   form[data-confirm]      asks before a destructive submit (a <dialog>; red confirm for danger buttons)
//   form submit             the button shows "Saving…" (aria-busy) and cannot be pressed twice
//   refused settings form   what was typed comes back (sessionStorage), still marked unsaved
//   form[data-dirty]        warns before leaving the page with unsaved changes
//   [data-copy]             a copy-to-clipboard button (case codes)
//   time[data-relative]     "in 3 h" / "5 min ago" (the UTC time stays in the tooltip)
//   details[data-key]       remembers which sections were open (per page)
//   #nav-toggle             the sidebar drawer: focus stays inside while open; Escape and link clicks close it
//   details.menu-wrap       top bar menus: Escape or a click outside closes them, one open at a time
//   [data-theme-pick]       the theme picker (radio group) switches in place (same cookie)
//   main .flash             "Saved." becomes a toast that closes itself
//   form[data-dirty]        also shows a Discard / Save bar at the bottom while changed
//   [data-module-search]    a search box above the module cards
//   #s-<section> links      open the collapsible section they point to
//   [data-quick-find]       "/" focuses the top bar search

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
    // For this tab only: what a settings form sent, until the next page says how it went.
    const pending = {
        take() {
            try {
                const value = window.sessionStorage.getItem('meowist:pending');
                window.sessionStorage.removeItem('meowist:pending');
                return value ? JSON.parse(value) : null;
            } catch { return null; }
        },
        put(value) {
            try { window.sessionStorage.setItem('meowist:pending', JSON.stringify(value)); } catch { /* private mode */ }
        },
    };

    /** The user-editable values of a form: { name: [values] } (no CSRF token, hidden or file fields). */
    function formValues(form) {
        const values = {};
        for (const el of form.elements) {
            if (!el.name || el.disabled || ['hidden', 'file', 'password', 'submit', 'reset', 'button'].includes(el.type)) continue;
            const list = values[el.name] || (values[el.name] = []);
            if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) list.push(el.value); }
            else if (el.multiple) list.push(...[...el.selectedOptions].map((o) => o.value));
            else list.push(el.value);
        }
        return values;
    }

    /** After a refused save: put back what was typed in that form (the page shows the saved values). */
    function restoreRefusedForm() {
        const sent = pending.take();
        const error = document.getElementById('form-error');
        const form = error?.closest('form');
        if (!sent || !form || form.getAttribute('action') !== sent.action) return;
        for (const el of form.elements) {
            if (!el.name || !Object.hasOwn(sent.values, el.name)) continue;
            const list = sent.values[el.name];
            if (el.type === 'checkbox' || el.type === 'radio') el.checked = list.includes(el.value);
            else if (el.multiple) for (const option of el.options) option.selected = list.includes(option.value);
            else if (list.length) el.value = list.shift();
        }
        // Still unsaved: same marks and bar as after typing.
        form.querySelector('input, select, textarea')?.dispatchEvent(new Event('input', { bubbles: true }));
    }

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
    // A <dialog> titled with the form's own question (data-confirm, plus an optional
    // data-confirm-detail line); the confirm button repeats the action ("Delete panel")
    // and is red when the form's button is a danger button. Cancel has
    // the focus, so Enter or Escape never confirms by accident.
    function askConfirm(form, submitter) {
        const button = submitter || form.querySelector('button[type="submit"]');
        const action = button?.textContent.trim() || 'Continue';
        if (typeof HTMLDialogElement !== 'function') return Promise.resolve(window.confirm(form.dataset.confirm));
        return new Promise((resolve) => {
            const dialog = document.createElement('dialog');
            dialog.className = 'confirm-dialog';
            dialog.setAttribute('aria-labelledby', 'confirm-title');
            if (form.dataset.confirmDetail) dialog.setAttribute('aria-describedby', 'confirm-text');
            const body = document.createElement('div');
            body.className = 'confirm-body';
            // The form's own question names the thing and the action ("Delete the tag “rules”?").
            const title = document.createElement('h2');
            title.id = 'confirm-title';
            title.textContent = form.dataset.confirm;
            body.append(title);
            if (form.dataset.confirmDetail) {
                const text = document.createElement('p');
                text.id = 'confirm-text';
                text.textContent = form.dataset.confirmDetail;
                body.append(text);
            }
            const actions = document.createElement('div');
            actions.className = 'confirm-actions';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'secondary';
            cancel.textContent = 'Cancel';
            const ok = document.createElement('button');
            ok.type = 'button';
            ok.className = button?.classList.contains('danger') ? 'danger is-filled' : 'primary';
            ok.textContent = action;
            actions.append(cancel, ok);
            dialog.append(body, actions);
            document.body.appendChild(dialog);
            let answer = false;
            cancel.addEventListener('click', () => dialog.close());
            ok.addEventListener('click', () => { answer = true; dialog.close(); });
            dialog.addEventListener('close', () => {
                dialog.remove();
                if (!answer) button?.focus();
                resolve(answer);
            });
            dialog.showModal();
            cancel.focus();
        });
    }

    document.addEventListener('submit', (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (form.dataset.confirm && form.dataset.confirmed !== '1') {
            event.preventDefault();
            const submitter = event.submitter;
            askConfirm(form, submitter).then((yes) => {
                if (!yes) return;
                form.dataset.confirmed = '1';
                if (typeof form.requestSubmit === 'function') form.requestSubmit(submitter || undefined);
                else form.submit();
            });
            return;
        }
        delete form.dataset.confirmed;
        form.dataset.submitting = '1';
        if (form.matches('form[data-dirty]')) pending.put({ action: form.getAttribute('action'), values: formValues(form) });
        const button = event.submitter || form.querySelector('button[type="submit"]');
        if (button) {
            // Loading state, and no double submits; undone if the user comes back (bfcache).
            button.dataset.label = button.textContent;
            button.setAttribute('aria-busy', 'true');
            if (/^save/i.test(button.textContent.trim())) button.textContent = 'Saving…';
            window.setTimeout(() => { button.disabled = true; }, 0);
        }
    }, true);

    window.addEventListener('pageshow', () => {
        for (const button of document.querySelectorAll('button[aria-busy="true"]')) {
            button.removeAttribute('aria-busy');
            if (button.dataset.label) button.textContent = button.dataset.label;
        }
        for (const button of document.querySelectorAll('button[type="submit"][disabled]')) {
            if (!button.closest('fieldset[disabled]')) button.disabled = false;
        }
        for (const form of document.querySelectorAll('form[data-submitting]')) delete form.dataset.submitting;
    });

    // ── Unsaved changes ──────────────────────────────────────────────────
    // The form and its section are marked ("Unsaved changes"); Reset puts the loaded
    // values back and clears the mark; leaving the page asks first.
    const dirty = new Set();
    const markSection = (form, on) => form.closest('details.section')?.classList.toggle('is-changed', on);
    document.addEventListener('input', (event) => {
        const form = event.target.closest?.('form[data-dirty]');
        if (form && !event.target.classList.contains('select-filter')) {
            dirty.add(form);
            form.classList.add('is-dirty');
            markSection(form, true);
        }
    });
    document.addEventListener('reset', (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || !dirty.has(form)) return;
        dirty.delete(form);
        form.classList.remove('is-dirty');
        markSection(form, false);
        document.dispatchEvent(new CustomEvent('meowist:clean', { detail: form }));
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

    // ── Sidebar drawer (tablets and phones) ──────────────────────────────
    function setupDrawer() {
        const toggle = document.getElementById('nav-toggle');
        if (!toggle) return;
        const button = document.querySelector('label[for="nav-toggle"]');
        const sidebar = document.getElementById('sidebar');
        const links = () => [...(sidebar?.querySelectorAll('a[href]') || [])];
        const sync = () => {
            button?.setAttribute('aria-expanded', toggle.checked ? 'true' : 'false');
            if (toggle.checked) (sidebar?.querySelector('a.on') || links()[0])?.focus();
        };
        toggle.addEventListener('change', sync);
        button?.setAttribute('aria-expanded', 'false');
        document.addEventListener('keydown', (event) => {
            if (!toggle.checked) return;
            if (event.key === 'Escape') {
                toggle.checked = false;
                sync();
                button?.focus();
                return;
            }
            // While the drawer is open, Tab moves between its links only (focus trap).
            if (event.key === 'Tab') {
                const all = links();
                if (!all.length) return;
                const index = all.indexOf(document.activeElement);
                if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === all.length - 1)) {
                    event.preventDefault();
                    all[event.shiftKey ? (index <= 0 ? all.length - 1 : index - 1) : (index === -1 || index === all.length - 1 ? 0 : index + 1)].focus();
                }
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

    // ── Top bar menus (server switcher, user menu) ───────────────────────
    function setupMenus() {
        const menus = [...document.querySelectorAll('details.menu-wrap')];
        if (!menus.length) return;
        const close = (menu, focus) => {
            if (!menu.open) return;
            menu.open = false;
            if (focus) menu.querySelector('summary')?.focus();
        };
        for (const menu of menus) {
            menu.addEventListener('toggle', () => {
                if (menu.open) for (const other of menus) if (other !== menu) close(other, false);
            });
        }
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            for (const menu of menus) if (menu.open) close(menu, true);
        });
        document.addEventListener('click', (event) => {
            for (const menu of menus) if (menu.open && !menu.contains(event.target)) close(menu, false);
        });
    }

    // ── Theme picker ─────────────────────────────────────────────────────
    // Without the script each option is a link through GET /dashboard/theme (cookie +
    // redirect); here the same cookie is set and the page switches in place. The options
    // are a radio group: arrow keys move and select, Space/Enter select. Both pickers
    // (account menu, phone sheet) stay in step.
    const THEMES = ['system', 'white', 'gray', 'dark', 'black', 'paper', 'sage', 'sand'];
    function setupThemePicker() {
        const options = [...document.querySelectorAll('[data-theme-pick]')];
        if (!options.length) return;
        const choose = (theme) => {
            if (!THEMES.includes(theme)) return;
            const secure = window.location.protocol === 'https:' ? '; Secure' : '';
            document.cookie = `meowist_theme=${theme}; Path=/dashboard; Max-Age=31536000; SameSite=Lax${secure}`;
            if (theme === 'system') delete document.documentElement.dataset.theme;
            else document.documentElement.dataset.theme = theme;
            for (const opt of options) {
                const on = opt.dataset.themePick === theme;
                opt.setAttribute('aria-checked', on ? 'true' : 'false');
                opt.tabIndex = on ? 0 : -1;
            }
        };
        for (const opt of options) {
            opt.addEventListener('click', (event) => {
                event.preventDefault();
                choose(opt.dataset.themePick);
            });
            opt.addEventListener('keydown', (event) => {
                const group = [...opt.closest('[role="radiogroup"]').querySelectorAll('[data-theme-pick]')];
                const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
                if (step) {
                    event.preventDefault();
                    const next = group[(group.indexOf(opt) + step + group.length) % group.length];
                    choose(next.dataset.themePick);
                    next.focus();
                } else if (event.key === ' ') {
                    event.preventDefault();
                    choose(opt.dataset.themePick);
                }
            });
        }
    }

    // ── Section tabs: on phones (one scrolling row) the current tab is scrolled into view ──
    function showCurrentTab() {
        const tab = document.querySelector('.section-tabs a.on');
        const strip = tab?.parentElement;
        if (!tab || strip.scrollWidth <= strip.clientWidth) return;
        strip.scrollLeft = tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2;
    }

    // ── Toasts ───────────────────────────────────────────────────────────
    // The "Saved." line after a form becomes a toast in the corner that closes itself
    // after a few seconds (errors stay in the page, next to the form).
    function setupToasts() {
        const flashes = document.querySelectorAll('main .flash');
        if (!flashes.length) return;
        const stack = document.createElement('div');
        stack.className = 'toast-stack';
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
        for (const flash of flashes) {
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'toast-close';
            close.setAttribute('aria-label', 'Dismiss');
            close.textContent = '×';
            const dismiss = () => {
                flash.classList.add('is-leaving');
                window.setTimeout(() => flash.remove(), 160);
            };
            close.addEventListener('click', dismiss);
            flash.appendChild(close);
            stack.appendChild(flash);
            let timer = window.setTimeout(dismiss, 4000);
            // Hovering or focusing keeps it open.
            flash.addEventListener('mouseenter', () => window.clearTimeout(timer));
            flash.addEventListener('focusin', () => window.clearTimeout(timer));
            flash.addEventListener('mouseleave', () => { timer = window.setTimeout(dismiss, 3000); });
        }
    }

    // ── Unsaved-changes bar ──────────────────────────────────────────────
    // When a settings form has changes, a bar at the bottom offers Discard / Save for
    // that form (the form's own Save button still works; nothing is sent until Save).
    function setupSaveBar() {
        if (!document.querySelector('form[data-dirty]')) return;
        const bar = document.createElement('div');
        bar.className = 'save-bar';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Unsaved changes');
        bar.hidden = true;
        const text = document.createElement('span');
        text.className = 'save-bar-text';
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'secondary';
        discard.textContent = 'Discard';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'primary';
        save.textContent = 'Save changes';
        bar.append(text, discard, save);
        document.body.appendChild(bar);

        let current = null;
        const where = (form) => form.closest('details.section')?.querySelector('summary h2')?.textContent.trim() || '';
        const show = (form) => {
            current = form;
            const place = where(form);
            text.textContent = place ? `Unsaved changes in ${place}` : 'Unsaved changes';
            bar.hidden = false;
            document.body.classList.add('has-save-bar');
        };
        const hide = () => {
            current = null;
            bar.hidden = true;
            document.body.classList.remove('has-save-bar');
        };
        document.addEventListener('input', (event) => {
            const form = event.target.closest?.('form[data-dirty]');
            if (form && !event.target.classList.contains('select-filter')) show(form);
        });
        discard.addEventListener('click', () => {
            if (current) current.reset(); // the reset listener clears the marks
        });
        document.addEventListener('meowist:clean', () => {
            const next = [...dirty].find((form) => document.contains(form));
            if (next) show(next); else hide();
        });
        save.addEventListener('click', () => {
            if (!current) return;
            const button = current.querySelector('button[type="submit"]');
            if (typeof current.requestSubmit === 'function') current.requestSubmit(button || undefined);
            else current.submit();
        });
        document.addEventListener('submit', (event) => {
            if (event.target === current && !event.defaultPrevented) hide();
        });
    }

    // ── Module search (Modules page) ─────────────────────────────────────
    function setupModuleSearch() {
        const slot = document.querySelector('[data-module-search]');
        const grid = document.querySelector('[data-module-grid]');
        if (!slot || !grid) return;
        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'Search modules…';
        input.setAttribute('aria-label', 'Search modules');
        input.autocomplete = 'off';
        const none = document.createElement('p');
        none.className = 'empty';
        none.textContent = 'No module matches.';
        none.hidden = true;
        grid.insertAdjacentElement('afterend', none);
        slot.appendChild(input);
        // The word searched from the top bar (?q=) shows here too (the list is already filtered).
        const q = new URLSearchParams(window.location.search).get('q');
        if (q) input.value = q;
        input.addEventListener('input', () => {
            const needle = input.value.trim().toLowerCase();
            let shown = 0;
            for (const card of grid.querySelectorAll('[data-name]')) {
                const match = !needle || card.dataset.name.includes(needle) || card.textContent.toLowerCase().includes(needle);
                card.hidden = !match;
                if (match) shown += 1;
            }
            none.hidden = shown > 0;
        });
    }

    /** The word searched from the top bar stays visible in the search box (?q=). */
    function keepSearchWord() {
        const q = new URLSearchParams(window.location.search).get('q');
        const input = document.querySelector('[data-quick-find]');
        if (q && input && !input.value) input.value = q;
    }

    // ── A refused form: open its section and bring the error into view ───
    function showFormError() {
        const error = document.getElementById('form-error');
        if (!error) return;
        const details = error.closest('details');
        if (details) details.open = true;
        error.scrollIntoView({ block: 'center' });
        // The page came from the form's POST address; show the module page's own address so a
        // reload does not send the form again (that address answers GET with 404).
        const action = error.closest('form')?.getAttribute('action') || '';
        if (window.location.pathname === action && window.history?.replaceState) {
            window.history.replaceState(null, '', action.replace(/\/[^/]+$/, '') + (details?.id ? `#${details.id}` : ''));
        }
    }

    // ── "On this page" links open their section ──────────────────────────
    function openSectionFromHash() {
        const id = decodeURIComponent(window.location.hash.slice(1));
        const target = id && document.getElementById(id);
        if (target instanceof HTMLDetailsElement) target.open = true;
    }

    // ── "/" focuses the top bar search (not while typing somewhere) ────────
    function setupQuickFind() {
        const input = document.querySelector('[data-quick-find]');
        if (!input) return;
        document.addEventListener('keydown', (event) => {
            if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target;
            if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
            event.preventDefault();
            input.focus();
        });
    }

    function init() {
        document.documentElement.classList.add('js');
        setupQuickFind();
        keepSearchWord();
        setupThemePicker();
        showCurrentTab();
        setupToasts();
        setupSaveBar();
        setupModuleSearch();
        openSectionFromHash();
        window.addEventListener('hashchange', openSectionFromHash);
        document.querySelectorAll('select[data-search]').forEach(enhanceSelect);
        document.querySelectorAll('[data-copy]').forEach(addCopyButton);
        document.querySelectorAll('details[data-key]').forEach(rememberDetails);
        showFormError();
        restoreRefusedForm();
        updateTimes();
        window.setInterval(updateTimes, 60 * 1000);
        setupDrawer();
        setupMenus();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}());
