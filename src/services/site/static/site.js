// Mewvo site script (CSP 'self'). Enhancement only: pages work without it.
(() => {
    'use strict';
    const MENUS = 'details.lang-menu, details.account-menu';
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

    // Escape closes, focus back on the toggle.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        for (const menu of openMenus()) {
            menu.open = false;
            menu.querySelector('summary')?.focus();
        }
    });

    // Phone menu: show the current item (scrolls the menu, not the page).
    const current = document.querySelector('.topnav a[aria-current="page"]');
    const nav = current?.closest('.topnav');
    if (nav && nav.scrollWidth > nav.clientWidth) {
        const box = nav.getBoundingClientRect();
        const item = current.getBoundingClientRect();
        if (item.left < box.left) nav.scrollLeft -= box.left - item.left + 8;
        else if (item.right > box.right) nav.scrollLeft += item.right - box.right + 8;
    }

    // Wide tables: .can-scroll while more is to the right.
    const wraps = [...document.querySelectorAll('.table-wrap')], quiet = { passive: true };
    const hint = (w) => w.classList.toggle('can-scroll', w.scrollLeft + w.clientWidth < w.scrollWidth - 1);
    for (const w of wraps) {
        hint(w);
        w.addEventListener('scroll', () => hint(w), quiet);
    }
    if (wraps.length) addEventListener('resize', () => wraps.forEach(hint), quiet);
})();
