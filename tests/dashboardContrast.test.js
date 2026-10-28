// Contrast guard for the dashboard palette (design system v2, plan.md): reads the colour
// tokens straight from dashboard.css and checks every pair the pages use against WCAG AA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
const UI = 3; // input borders, switch tracks
const PAIRS = [
    ['text', 'bg', TEXT], ['text', 'surface', TEXT], ['text', 'raised', TEXT],
    ['text-muted', 'bg', TEXT], ['text-muted', 'surface', TEXT], ['text-muted', 'raised', TEXT],
    ['purple', 'bg', TEXT], ['purple', 'surface', TEXT], ['purple', 'raised', TEXT], ['purple', 'purple-soft', TEXT],
    ['on-purple', 'purple', TEXT], ['on-purple', 'purple-hover', TEXT],
    ['green', 'bg', TEXT], ['green', 'surface', TEXT], ['green', 'raised', TEXT], ['green', 'green-soft', TEXT],
    ['red', 'bg', TEXT], ['red', 'surface', TEXT], ['red', 'raised', TEXT], ['red', 'red-soft', TEXT],
    ['amber', 'bg', TEXT], ['amber', 'surface', TEXT], ['amber', 'raised', TEXT], ['amber', 'amber-soft', TEXT],
    ['bg', 'red', TEXT], // filled danger button
    ['on-green', 'green', UI],
    ['border-strong', 'bg', UI], ['border-strong', 'surface', UI], ['border-strong', 'raised', UI],
];

const light = tokens(':root');
const dark = tokens(':root[data-theme="dark"]');

for (const [name, theme] of [['light', light], ['dark', dark]]) {
    test(`dashboard palette (${name}): every pair meets WCAG AA`, () => {
        const failures = PAIRS
            .map(([fg, bg, min]) => ({ fg, bg, min, value: ratio(theme[fg], theme[bg]) }))
            .filter((p) => !(p.value >= p.min))
            .map((p) => `${p.fg} on ${p.bg}: ${p.value.toFixed(2)} < ${p.min}`);
        assert.deepEqual(failures, []);
    });
}

test('dashboard palette: the system-dark block and the data-theme="dark" block are identical', () => {
    assert.deepEqual(tokens(':root:not([data-theme="light"])'), dark);
});
