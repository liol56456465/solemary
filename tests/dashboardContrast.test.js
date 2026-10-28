// Contrast guard for the dashboard themes: reads every theme's colour tokens straight from
// dashboard.css and checks every pair the pages use against WCAG AA, in all 7 themes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES } from '../src/services/dashboard/html.js';

const css = readFileSync(new URL('../src/services/dashboard/static/dashboard.css', import.meta.url), 'utf8');

/** The `--name: #hex;` tokens of the first block that starts with `selector {`. */
function tokens(selector) {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `missing ${selector}`);
    const body = css.slice(start, css.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2].toLowerCase()]));
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

const TEXT = 4.5; // normal text
const UI = 3; // input borders, switch tracks, focus ring on the chrome
const PAIRS = [
    ['text', 'bg', TEXT], ['text', 'surface', TEXT], ['text', 'raised', TEXT],
    ['text-muted', 'bg', TEXT], ['text-muted', 'surface', TEXT], ['text-muted', 'raised', TEXT],
    ['accent', 'bg', TEXT], ['accent', 'raised', TEXT], ['accent', 'accent-soft', TEXT],
    ['on-accent', 'accent', TEXT], ['on-accent', 'accent-hover', TEXT],
    ['green', 'bg', TEXT], ['green', 'surface', TEXT], ['green', 'raised', TEXT], ['green', 'green-soft', TEXT],
    ['red', 'bg', TEXT], ['red', 'surface', TEXT], ['red', 'raised', TEXT], ['red', 'red-soft', TEXT],
    ['amber', 'bg', TEXT], ['amber', 'surface', TEXT], ['amber', 'raised', TEXT], ['amber', 'amber-soft', TEXT],
    ['accent', 'surface', TEXT],
    ['bg', 'red', TEXT], // filled danger button
    ['chrome-text', 'ink', TEXT], ['feature-text', 'feature', TEXT], ['feature-muted', 'feature', TEXT],
    ['on-green', 'green', UI], ['accent-ink', 'ink', UI],
    ['border-strong', 'bg', UI], ['border-strong', 'raised', UI],
];

const named = THEMES.filter((t) => t !== 'system');

test('dashboard themes: 7 themes, each a full token set', () => {
    assert.deepEqual(named, ['white', 'gray', 'dark', 'black', 'paper', 'sage', 'sand']);
    const keys = Object.keys(tokens(':root[data-theme="white"]')).sort();
    for (const theme of named) assert.deepEqual(Object.keys(tokens(`:root[data-theme="${theme}"]`)).sort(), keys, theme);
});

for (const theme of named) {
    test(`dashboard theme ${theme}: every pair meets WCAG AA`, () => {
        const t = tokens(`:root[data-theme="${theme}"]`);
        const failures = PAIRS
            .map(([fg, bg, min]) => ({ fg, bg, min, value: ratio(t[fg], t[bg]) }))
            .filter((p) => !(p.value >= p.min))
            .map((p) => `${p.fg} on ${p.bg}: ${p.value.toFixed(2)} < ${p.min}`);
        assert.deepEqual(failures, []);
    });
}

test('dashboard themes: no theme chosen = White by day, Dark at night (same tokens as those themes)', () => {
    const base = tokens(':root');
    for (const [k, v] of Object.entries(tokens(':root[data-theme="white"]'))) assert.equal(base[k], v, k);
    assert.deepEqual(tokens(':root:not([data-theme])'), tokens(':root[data-theme="dark"]'));
});
