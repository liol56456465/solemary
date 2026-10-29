// Contrast guard for the front site (src/services/site/static/site.css): reads the light and
// dark token sets and checks every text / background pair the pages and mock-ups use against
// WCAG AA (4.5:1 text, 3:1 large text and UI marks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/services/site/static/site.css', import.meta.url), 'utf8');

/** The `--name: #hex;` tokens of the first block that starts at `marker`. */
function tokens(marker) {
    const start = css.indexOf(marker);
    assert.ok(start >= 0, `missing ${marker}`);
    const open = css.indexOf('{', css.indexOf(':root', start));
    const body = css.slice(open, css.indexOf('}', open));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const UI = 3;
const PAIRS = [
    // Page text, links, labels on every page background.
    ...['bg', 'bg-alt', 'raised'].flatMap((bg) => [['text', bg, TEXT], ['text-muted', bg, TEXT], ['accent', bg, TEXT], ['accent-hover', bg, TEXT]]),
    ['on-ink', 'ink', TEXT], ['on-ink', 'ink-hover', TEXT], // buttons
    ['accent', 'accent-soft', TEXT], // "Planned" labels
    ['text-muted', 'accent-soft', TEXT],
    ['border-strong', 'bg', UI], ['border-strong', 'raised', UI], ['accent', 'bg', UI], // focus ring, markers
    ['ok', 'bg', UI], ['warn', 'bg', UI], ['bad', 'bg', UI], // status dots
    // Discord mock-ups.
    ['dc-text', 'dc-bg', TEXT], ['dc-head', 'dc-bg', TEXT], ['dc-muted', 'dc-bg', TEXT], ['dc-link', 'dc-bg', TEXT],
    ['dc-text', 'dc-embed', TEXT], ['dc-head', 'dc-embed', TEXT], ['dc-muted', 'dc-embed', TEXT], ['dc-mention', 'dc-embed', TEXT],
    ['dc-text', 'dc-code', TEXT], ['dc-text', 'dc-input', TEXT], ['dc-muted', 'dc-input', TEXT],
    ['dc-mention', 'dc-mention-bg', TEXT],
    ['dc-on-button', 'dc-primary', TEXT], ['dc-on-button', 'dc-danger', TEXT], ['dc-on-button', 'dc-success', TEXT], ['dc-on-button', 'dc-grey', TEXT],
    ['dc-on-avatar', 'dc-avatar', UI],
];

const SCHEMES = { light: ':root {', dark: '@media (prefers-color-scheme: dark)' };

test('site tokens: light and dark define the same set', () => {
    assert.deepEqual(Object.keys(tokens(SCHEMES.dark)).sort(), Object.keys(tokens(SCHEMES.light)).sort());
});

for (const [scheme, marker] of Object.entries(SCHEMES)) {
    test(`site colours (${scheme}): every pair meets WCAG AA`, () => {
        const t = tokens(marker);
        const failures = PAIRS
            .map(([fg, bg, min]) => ({ fg, bg, min, value: ratio(t[fg], t[bg]) }))
            .filter((p) => !(p.value >= p.min))
            .map((p) => `${p.fg} on ${p.bg}: ${p.value.toFixed(2)} < ${p.min}`);
        assert.deepEqual(failures, []);
    });
}
