// icons.js — the dashboard's icons: one inline SVG sprite (simple 24×24 line icons
// drawn for this dashboard, stroke = currentColor so they follow the theme), placed
// once per page and referenced with <use href="#i-name">. No icon font, no CDN, no
// external file (CSP default-src 'none').

// Plain strings only (html.js wraps them): html.js imports this file.

/** The Meowist cat (24×24, evenodd): also the website logo and the favicon. */
export const CAT_PATH = 'M5.4 6.4C5.6 4.8 7.2 3.9 8.7 4.6L9.7 5.2C11.2 4.9 12.8 4.9 14.3 5.2L15.3 4.6C16.8 3.9 18.4 4.8 18.6 6.4L20.1 12.6C20.5 15 19.8 17.2 18.3 18.8L16.3 20.6L15.5 18.6C13.2 19.2 10.8 19.2 8.5 18.6L7.7 20.6L5.7 18.8C4.2 17.2 3.5 15 3.9 12.6ZM6.3 7.7C7.3 6.4 8.8 5.8 10.3 5.9C8.8 6.4 7.5 7 6.3 7.7ZM17.7 7.7C16.7 6.4 15.2 5.8 13.7 5.9C15.2 6.4 16.5 7 17.7 7.7ZM7 11.7a2.1 2.4 0 1 0 4.2 0a2.1 2.4 0 1 0-4.2 0ZM9.1 9.7C9.7 10.8 9.7 12.6 9.1 13.7C8.5 12.6 8.5 10.8 9.1 9.7ZM12.8 11.7a2.1 2.4 0 1 0 4.2 0a2.1 2.4 0 1 0-4.2 0ZM14.9 9.7C15.5 10.8 15.5 12.6 14.9 13.7C14.3 12.6 14.3 10.8 14.9 9.7ZM11 14.8H13L12 16ZM6.6 16C9.6 18.6 14.4 18.6 17.4 16C14.4 17.6 9.6 17.6 6.6 16Z';

const PATHS = {
    inbox: '<path d="M4 13l2.5-8h11l2.5 8v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h4.5l1.5 2.5h4l1.5-2.5H20"/>',
    overview: '<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/>',
    modules: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
        bans: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5 1.6 0 3 .5 4.1 1.4"/><circle cx="18" cy="17" r="3.5"/><path d="M15.5 19.5l5-5"/>',
        users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
    cases: '<path d="M8 4h8M6 7h12a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><path d="M9 12h6M9 16h4"/>',
    appeals: '<path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
    nocontact: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    staff: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    channels: '<path d="M10 4L8 20M16 4l-1.1 9M5 9h14M4 15h9"/><rect x="15" y="15" width="6" height="5" rx="1"/><path d="M16.5 15v-1.5a1.5 1.5 0 0 1 3 0V15"/>',
    enforcement: '<path d="M14 4l6 6M4 20l7-7M12 6l6 6-4 4-6-6z"/><path d="M3 21h9"/>',
    automod: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5"/><circle cx="12" cy="3.5" r="1"/>',
    logging: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    welcome: '<path d="M4 20V5a1 1 0 0 1 1-1h9l6 4v12z"/><path d="M14 4v4h6M8 13h8M8 16h5"/>',
    tickets: '<path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 0 0 4v2h18v-2a2 2 0 0 1 0-4 2 2 0 0 1 0-4V6H3z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
    leveling: '<path d="M4 20V14M10 20V10M16 20V6M22 20H2"/><path d="M15 4l2-2 2 2"/>',
    verification: '<path d="M12 3l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 21l-2.4-1.8-3 .2-.9-2.9L3.2 14.8l1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    'reaction-roles': '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
    messages: '<path d="M20 4L3 11l6 2.5L11.5 20z"/><path d="M9 13.5L20 4"/>',
    giveaways: '<rect x="3" y="9" width="18" height="4" rx="1"/><path d="M5 13v8h14v-8M12 9v12M12 9c-1.5-4-6-4-6-1.5S10 9 12 9zM12 9c1.5-4 6-4 6-1.5S14 9 12 9z"/>',
    birthdays: '<path d="M4 21h16M5 21v-7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v7"/><path d="M5 16c2 1 3-1 4.5 0s3 1 4.5 0 3-1 5 0M12 13V9M12 6.5v.01"/>',
    counters: '<path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16"/>',
    'join-to-create': '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
    applications: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 11h7M9 14h7M9 17h4"/>',
    community: '<path d="M4 5h11v8H8l-4 3z"/><path d="M15 9h5v8l-3-2h-6v-2"/>',
    commands: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
    support: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M6 6l3.5 3.5M14.5 14.5L18 18M18 6l-3.5 3.5M9.5 14.5L6 18"/>',
    rules: '<path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8.5 8h.01M11 8h5M8.5 12h.01M11 12h5M8.5 16h.01M11 16h5"/>',
    audit: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.9"/>',
    circle: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 2.4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
    mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/>',
    kick: '<path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4M18 12H9"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10"/>',
    // The Meowist mark (owner's logo): a filled cat head with eyes, nose, smile and ear lines cut out
    // (evenodd, the slit pupils filled again), so the cut-outs show the tile colour.
    cat: `<path fill="currentColor" stroke="none" fill-rule="evenodd" d="${CAT_PATH}"/>`,
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
    server: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 10h.01M15 10h.01M9 15c1.7 1.3 4.3 1.3 6 0"/>',
};

export const ICON_NAMES = Object.keys(PATHS);
export const hasIcon = (name) => Object.hasOwn(PATHS, name);

/** The sprite markup, hidden, once per page (a trusted constant). */
export const ICON_SPRITE_MARKUP = (`<svg xmlns="http://www.w3.org/2000/svg" class="sprite" aria-hidden="true" focusable="false">${Object.entries(PATHS)
    .map(([name, d]) => `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</symbol>`).join('')}</svg>`);

