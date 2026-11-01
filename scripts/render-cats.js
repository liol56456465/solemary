// render-cats.js — draws the Mewvo server cat (5 stages × 4 moods) as SVG and rasterizes each
// one to a 256×256 PNG with the headless Chromium that Playwright installed on this machine.
//
//   node scripts/render-cats.js                      → scripts/cat-art/<stage>-<mood>.svg
//                                                      src/services/site/static/img/cat/<stage>-<mood>.png
//   node scripts/render-cats.js --sheet <out.png>    also writes a contact sheet of all 20
//   node scripts/render-cats.js --chrome <path>      a different Chromium / headless shell binary
//
// Style follows the owner's logo (static/img/logo.png): a white cat with simple black lines on a
// black rounded tile. The stage changes size and details, the mood changes eyes, ears, mouth and
// tail. Run by hand when the artwork changes; the bot only serves the committed PNGs.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAT_MOODS, CAT_STAGES } from '../src/services/community/catModel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG_DIR = path.join(ROOT, 'scripts/cat-art');
const PNG_DIR = path.join(ROOT, 'src/services/site/static/img/cat');

const INK = '#0b0b0c';
const FUR = '#f4f1ea';
const GOLD = '#f2b84b';
const CAPE = '#d9542b';

// Per stage: overall scale (feet stay on the floor), body size, head size, tail width, extras.
const STAGE_ART = {
    kitten: { scale: 0.66, bodyRx: 38, bodyRy: 40, head: 1.2, tail: 9, whiskers: false },
    young: { scale: 0.78, bodyRx: 40, bodyRy: 46, head: 1.04, tail: 11, whiskers: false },
    cat: { scale: 0.88, bodyRx: 50, bodyRy: 48, head: 1, tail: 14, whiskers: true },
    big: { scale: 0.98, bodyRx: 64, bodyRy: 52, head: 1.02, tail: 17, whiskers: true, chest: true },
    legend: { scale: 0.98, bodyRx: 64, bodyRy: 52, head: 1.02, tail: 17, whiskers: true, chest: true, crown: true, cape: true },
};

const FLOOR = 234;
const HEAD_CX = 128;
const HEAD_CY = 108;

const stroke = (width) => `stroke="${INK}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

/** A thick white line with a black outline (tail). */
function furLine(d, width) {
    return `<path d="${d}" fill="none" ${stroke(width + 9)}/><path d="${d}" fill="none" stroke="${FUR}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function tail(mood, width) {
    switch (mood) {
        case 'sleepy': // wrapped round the front paws
            return furLine('M170 206 Q206 226 176 232 Q140 238 100 230', width);
        case 'proud': // straight up with a curl
            return furLine('M172 196 Q204 176 200 130 Q198 108 216 104', width);
        case 'scared': // puffed up
            return `${furLine('M170 200 Q208 186 204 138', width + 12)}<path d="M196 150 l14 -6 M200 166 l14 -2 M194 136 l12 -10" ${stroke(4)}/>`;
        default: // happy: a relaxed question mark
            return furLine('M172 200 Q214 196 210 156 Q208 136 192 132', width);
    }
}

function ears(mood) {
    // Rounded ears like the logo, with an inner line. Scared: pressed flat to the sides.
    const ear = (side) => {
        const s = side === 'left' ? 1 : -1;
        const x = (v) => HEAD_CX + s * v;
        const outer = `M${x(-50)} 86 Q${x(-56)} 50 ${x(-40)} 42 Q${x(-28)} 40 ${x(-14)} 66 Z`;
        const inner = `M${x(-44)} 74 Q${x(-46)} 56 ${x(-38)} 52 Q${x(-30)} 54 ${x(-24)} 66`;
        const flat = mood === 'scared' ? ` transform="rotate(${-s * 62} ${x(-40)} 74)"` : '';
        return `<g${flat}><path d="${outer}" fill="${FUR}" ${stroke(5)}/><path d="${inner}" fill="none" ${stroke(3.5)}/></g>`;
    };
    return ear('left') + ear('right');
}

function headShape() {
    // The logo's face: wide, flat-topped, cheeks curling out at the bottom corners.
    return `<path d="M74 90 C74 64 96 58 128 58 C160 58 182 64 182 90 L185 118 C187 140 172 152 128 152 C84 152 69 140 71 118 Z" fill="${FUR}" ${stroke(5)}/>`;
}

function face(mood, whiskers) {
    const L = 106; const R = 150; const Y = 104;
    let eyes;
    let mouth;
    switch (mood) {
        case 'sleepy':
            eyes = [L, R].map((x) => `<path d="M${x - 11} ${Y + 2} Q${x} ${Y + 11} ${x + 11} ${Y + 2}" fill="none" ${stroke(4.5)}/>`).join('');
            mouth = `<path d="M122 132 Q128 135 134 132" fill="none" ${stroke(3.5)}/>`;
            break;
        case 'proud':
            eyes = [L, R].map((x) => `<path d="M${x - 11} ${Y + 6} Q${x} ${Y - 8} ${x + 11} ${Y + 6}" fill="none" ${stroke(4.5)}/>`).join('');
            mouth = `<path d="M116 128 Q122 136 128 129 Q134 136 140 128" fill="none" ${stroke(3.5)}/>`;
            break;
        case 'scared':
            eyes = [L, R].map((x) => `<circle cx="${x}" cy="${Y}" r="15" fill="${FUR}" ${stroke(4.5)}/><circle cx="${x}" cy="${Y + 1}" r="4.5" fill="${INK}"/>`).join('');
            mouth = `<ellipse cx="128" cy="136" rx="5" ry="6.5" fill="${INK}"/>`;
            break;
        default: // happy: the logo's eyes (black ovals, white slit) and a smile
            eyes = [L, R].map((x) => `<ellipse cx="${x}" cy="${Y}" rx="12" ry="15" fill="${INK}"/><ellipse cx="${x + 2}" cy="${Y - 1}" rx="2.6" ry="9" fill="${FUR}"/>`).join('');
            mouth = `<path d="M114 130 Q121 140 128 131 Q135 140 142 130" fill="none" ${stroke(3.5)}/>`;
    }
    const nose = `<path d="M122 121 L134 121 L128 128 Z" fill="${INK}" ${stroke(2)}/>`;
    const lines = whiskers
        ? `<path d="M92 124 L66 120 M92 131 L68 134 M164 124 L190 120 M164 131 L188 134" ${stroke(2.5)}/>`
        : '';
    return eyes + nose + mouth + lines;
}

function crown() {
    return `<path d="M104 62 L100 28 L116 44 L128 22 L140 44 L156 28 L152 62 Z" fill="${GOLD}" ${stroke(4.5)}/>`
        + `<circle cx="128" cy="50" r="4.5" fill="${CAPE}" ${stroke(2)}/>`;
}

function cape(art) {
    const w = art.bodyRx + 30;
    return `<path d="M${128 - 40} 140 Q${128 - w + 6} 176 ${128 - w} ${FLOOR + 2} L${128 + w} ${FLOOR + 2} Q${128 + w - 6} 176 ${128 + 40} 140 Z" fill="${CAPE}" ${stroke(5)}/>`
        + `<path d="M${128 - 40} 140 L${128 + 40} 140" ${stroke(9)}/><path d="M${128 - 40} 140 L${128 + 40} 140" stroke="${GOLD}" stroke-width="4" stroke-linecap="round"/>`;
}

function body(art, mood) {
    const ry = mood === 'scared' ? art.bodyRy - 4 : art.bodyRy; // crouched a little
    const cy = FLOOR - ry + 6;
    const paws = [-18, 18].map((dx) => `<ellipse cx="${128 + dx}" cy="${FLOOR - 2}" rx="15" ry="9" fill="${FUR}" ${stroke(5)}/>`).join('');
    const chest = art.chest ? `<path d="M114 ${cy - ry + 30} l7 8 l7 -8 l7 8 l7 -8" fill="none" ${stroke(3)}/>` : '';
    return `<ellipse cx="128" cy="${cy}" rx="${art.bodyRx}" ry="${ry}" fill="${FUR}" ${stroke(5)}/>${chest}${paws}`;
}

/** Where a point of the cat's own drawing lands on the tile (the cat is scaled about the floor). */
const onTile = (art, x, y) => [128 + (x - 128) * art.scale, FLOOR + (y - FLOOR) * art.scale];

function sparkle(x, y, r) {
    return `<path d="M${x} ${y - r} Q${x + r * 0.18} ${y - r * 0.18} ${x + r} ${y} Q${x + r * 0.18} ${y + r * 0.18} ${x} ${y + r} Q${x - r * 0.18} ${y + r * 0.18} ${x - r} ${y} Q${x - r * 0.18} ${y - r * 0.18} ${x} ${y - r} Z" fill="${GOLD}"/>`;
}

function moodExtras(art, mood) {
    const [hx, hy] = onTile(art, 186, 64); // just right of the head's top corner
    const [lx, ly] = onTile(art, 66, 88);
    switch (mood) {
        case 'sleepy':
            return `<g fill="${FUR}" font-family="Arial, Helvetica, sans-serif" font-weight="700">`
                + `<text x="${Math.min(hx + 10, 210)}" y="${hy - 2}" font-size="18">z</text><text x="${Math.min(hx + 24, 224)}" y="${hy - 20}" font-size="26">Z</text></g>`;
        case 'proud':
            return sparkle(Math.min(hx + 14, 226), hy - 16, 13) + sparkle(Math.max(lx - 14, 26), ly - 30, 9) + sparkle(Math.min(hx + 26, 232), hy + 22, 7);
        case 'scared': {
            const [ax, ay] = onTile(art, 46, 130);
            const [bx, by] = onTile(art, 210, 120);
            return `<path d="M${ax} ${ay - 12} q-8 6 0 12 q8 6 0 12 M${bx} ${by - 12} q8 6 0 12 q-8 6 0 12" fill="none" stroke="${FUR}" stroke-width="3.5" stroke-linecap="round"/>`;
        }
        default:
            return '';
    }
}

/** One cat as a standalone 256×256 SVG string. */
export function catSvg(stageKey, mood) {
    const art = STAGE_ART[stageKey];
    if (!art) throw new Error(`unknown stage ${stageKey}`);
    // Proud: chin up (head tilted back a little and raised).
    const headMove = mood === 'proud' ? `translate(0 -6) rotate(-7 ${HEAD_CX} ${HEAD_CY + 40})` : mood === 'sleepy' ? `translate(0 6) rotate(4 ${HEAD_CX} ${HEAD_CY + 40})` : '';
    const headScale = art.head !== 1 ? `translate(${HEAD_CX} ${HEAD_CY + 40}) scale(${art.head}) translate(${-HEAD_CX} ${-(HEAD_CY + 40)})` : '';
    const head = `<g transform="${headMove} ${headScale}">${ears(mood)}${headShape()}${face(mood, art.whiskers)}${art.crown ? crown() : ''}</g>`;
    const cat = `<g transform="translate(128 ${FLOOR}) scale(${art.scale}) translate(-128 ${-FLOOR})">`
        + `${art.cape ? cape(art) : ''}${tail(mood, art.tail)}${body(art, mood)}${head}</g>`;
    const ring = art.crown ? `<rect x="5" y="5" width="246" height="246" rx="44" fill="none" stroke="${GOLD}" stroke-width="4"/>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">`
        + `<rect width="256" height="256" rx="48" fill="${INK}"/>${ring}${cat}${moodExtras(art, mood)}</svg>\n`;
}

function chromeBinary() {
    const at = process.argv.indexOf('--chrome');
    if (at > -1 && process.argv[at + 1]) return process.argv[at + 1];
    const base = path.join(homedir(), '.cache/ms-playwright');
    const dir = readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
    if (!dir) throw new Error('No Playwright headless shell found; pass --chrome <path>');
    return path.join(base, dir, 'chrome-headless-shell-linux64/chrome-headless-shell');
}

function screenshot(chrome, htmlFile, outFile, width, height) {
    execFileSync(chrome, [
        '--no-sandbox', '--hide-scrollbars', '--default-background-color=00000000',
        `--screenshot=${outFile}`, `--window-size=${width},${height}`, `file://${htmlFile}`,
    ], { stdio: 'ignore' });
}

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg,img{display:block}</style></head><body>${body}</body></html>`;

async function main() {
    const chrome = chromeBinary();
    const work = path.join(tmpdir(), `mewvo-cats-${process.pid}`);
    mkdirSync(work, { recursive: true });
    mkdirSync(SVG_DIR, { recursive: true });
    mkdirSync(PNG_DIR, { recursive: true });
    let total = 0;
    try {
        for (const stage of CAT_STAGES) {
            for (const mood of CAT_MOODS) {
                const name = `${stage.key}-${mood}`;
                const svg = catSvg(stage.key, mood);
                writeFileSync(path.join(SVG_DIR, `${name}.svg`), svg);
                const htmlFile = path.join(work, `${name}.html`);
                writeFileSync(htmlFile, page(svg));
                const out = path.join(PNG_DIR, `${name}.png`);
                screenshot(chrome, htmlFile, out, 256, 256);
                total += statSync(out).size;
            }
        }
        console.log(`Wrote ${CAT_STAGES.length * CAT_MOODS.length} cats, ${(total / 1024).toFixed(1)} KB of PNG`);
        const at = process.argv.indexOf('--sheet');
        if (at > -1 && process.argv[at + 1]) {
            const out = path.resolve(process.argv[at + 1]);
            const cell = 200;
            const rows = CAT_STAGES.map((s) => `<tr><th>${s.name}</th>${CAT_MOODS.map((m) => `<td><img src="file://${path.join(PNG_DIR, `${s.key}-${m}.png`)}" width="${cell}" height="${cell}"></td>`).join('')}</tr>`).join('');
            const sheet = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f4efe6;font:600 16px Arial,sans-serif;color:#222}table{border-spacing:8px}th{text-align:right;padding-right:6px}thead th{text-align:center}</style></head><body><table><thead><tr><th></th>${CAT_MOODS.map((m) => `<th>${m}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
            const sheetFile = path.join(work, 'sheet.html');
            writeFileSync(sheetFile, sheet);
            screenshot(chrome, sheetFile, out, 110 + 4 * (cell + 8) + 16, 40 + 5 * (cell + 8) + 16);
            console.log(`Contact sheet: ${out}`);
        }
    } finally {
        if (existsSync(work)) rmSync(work, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
