// Mewvo site script (CSP 'self'). Enhancement only: pages work without it.
(() => {
    'use strict';
    const MENUS = 'details.lang-menu, details.account-menu, details.nav-menu';
    const openMenus = () => [...document.querySelectorAll(MENUS)].filter((m) => m.open);

    // One menu open at a time (toggle does not bubble: capture).
    document.addEventListener('toggle', (e) => {
        const menu = e.target;
        if (!menu.open || !menu.matches?.(MENUS)) return;
        for (const other of openMenus()) if (other !== menu) other.open = false;
    }, true);

    // Tap/click outside closes (iOS sends no click on plain areas).
    document.addEventListener('pointerdown', (e) => {
        for (const menu of openMenus()) if (!menu.contains(e.target)) menu.open = false;
    });

    // A tapped link in a menu closes it, and so does coming back with Back (the page from the cache).
    document.addEventListener('click', (e) => {
        const link = e.target.closest?.('a[href]');
        const menu = link?.closest(MENUS);
        if (menu) menu.open = false;
    });
    addEventListener('pageshow', (e) => { if (e.persisted) for (const menu of openMenus()) menu.open = false; });

    // Escape closes, focus back on the toggle.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        for (const menu of openMenus()) {
            menu.open = false;
            menu.querySelector('summary')?.focus();
        }
    });

    // Wide tables: .can-scroll while more is to the right.
    const wraps = [...document.querySelectorAll('.table-wrap')], quiet = { passive: true };
    const hint = (w) => w.classList.toggle('can-scroll', w.scrollLeft + w.clientWidth < w.scrollWidth - 1);
    for (const w of wraps) {
        hint(w);
        w.addEventListener('scroll', () => hint(w), quiet);
    }
    if (wraps.length) addEventListener('resize', () => wraps.forEach(hint), quiet);

    // /commands: live filter, the server's rules (pages/commands.js matchesFilters); the URL follows.
    const ex = document.querySelector('[data-cmd-explorer]'), q = ex?.querySelector('[data-cmd-q]');
    if (q) {
        const $ = (s) => ex.querySelector(s), cat = $('[data-cmd-cat]'), who = $('[data-cmd-who]'), out = $('[data-cmd-shown]'), empty = $('[data-cmd-empty]');
        const fmt = new Intl.NumberFormat(document.documentElement.lang || 'en');
        const qs = (o) => String(new URLSearchParams(Object.entries(o).filter(([, v]) => v)));
        const apply = () => {
            const text = q.value.trim().slice(0, 100), words = text.toLowerCase().split(/\s+/).filter(Boolean);
            const c = cat.value, v = who.value, w = v === 'all' ? '' : v;
            let n = 0;
            for (const g of ex.querySelectorAll('[data-cmd-group]')) {
                let any = false;
                for (const card of g.querySelectorAll('.cmd-card')) {
                    const d = card.dataset;
                    card.hidden = !((!c || d.cat === c) && (!w || d.who.split(' ').includes(w)) && words.every((x) => d.search.includes(x)));
                    if (!card.hidden) { any = true; n += 1; }
                }
                g.hidden = !any;
                const jump = $(`[data-cmd-jump="${g.dataset.cmdGroup}"]`);
                if (jump) jump.hidden = !any;
            }
            out.textContent = fmt.format(n);
            empty.hidden = n > 0;
            // "everyone" (default): no ?who=, the "Show all" note.
            $('[data-cmd-default]').hidden = v !== 'everyone';
            $('[data-cmd-all]').search = qs({ q: text, cat: c, who: 'all' });
            const p = qs({ q: text, cat: c, who: v === 'everyone' ? '' : v });
            history.replaceState(history.state, '', `${location.pathname}${p ? `?${p}` : ''}${location.hash}`);
        };
        q.addEventListener('input', apply);
        cat.addEventListener('change', apply);
        who.addEventListener('change', apply);
    }
})();
