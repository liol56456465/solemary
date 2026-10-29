// export-site.js — writes the public website as plain static files (HTML, CSS, images) into a
// folder that can be pushed to its own GitHub repository and served by GitHub Pages (or any
// static host) on the site's own domain.
//
//   npm run export:site                       → ./Mewvo
//   node scripts/export-site.js --out <dir> --site-url https://mewvo.com --app-url https://app.mewvo.com
//
// The pages are rendered by the real site router (src/services/site/site.js) on 127.0.0.1 with
// the loaded command list, then saved as <route>/index.html so clean URLs keep working on a
// static host. Pages that need the running bot (dashboard, leaderboard, status, rules,
// transparency, My record) are not copied: their links point to --app-url, where the bot's own
// web server answers them. Nothing here talks to Discord or a database.

import { mkdir, rm, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
    const at = process.argv.indexOf(`--${name}`);
    return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const OUT = path.resolve(ROOT, arg('out', 'Mewvo'));
const SITE_URL = arg('site-url', 'https://mewvo.com').replace(/\/+$/, '');
const APP_URL = arg('app-url', 'https://app.mewvo.com').replace(/\/+$/, '');
const SUPPORT_INVITE = arg('support-invite', 'https://discord.gg/7Ckv9Bt577');

/** Paths served by the bot (need live data or a login): links to them go to APP_URL. */
export const APP_PATHS = ['dashboard', 'leaderboard', 'status', 'rules', 'transparency', 'me', 'oauth'];

/** Rewrites root-relative links to the bot's pages so they point at the app's own address. */
export function pointAppLinksAt(htmlText, appUrl) {
    const pattern = new RegExp(`(href|action)="/(${APP_PATHS.join('|')})(?=[/"?#])`, 'g');
    return htmlText.replace(pattern, (match, attr, first) => `${attr}="${appUrl}/${first}`);
}

/** The static copy may be indexed: drop the "not public yet" robots meta the bot adds. */
export function allowIndexing(htmlText) {
    return htmlText.replace(/<meta name="robots" content="noindex, nofollow">/g, '');
}

async function main() {
    // Quiet logs, no bot features: only the site router and the command files are loaded.
    process.env.LOG_LEVEL ??= 'warn';
    process.env.PUBLIC_URL = SITE_URL;
    const { default: express } = await import('express');
    const { createSite, GUIDES } = await import('../src/services/site/site.js');
    const { loadCommands } = await import('../src/handlers/loaders/commandLoader.js');

    const client = {};
    await loadCommands(client);

    const app = express();
    app.use(createSite({
        client,
        env: { ...process.env, PUBLIC_URL: SITE_URL, PUBLIC_SITE_ENABLED: 'false' },
        dashboardEnabled: true,
        memberPortalEnabled: false,
        supportInvite: () => SUPPORT_INVITE,
        // Never used for the copied pages; set so nothing reaches for the bot or the database.
        leaderboard: async () => ({ enabled: false, rows: [] }),
        status: () => ({ state: 'online', uptimeMs: 0 }),
        rules: async () => null,
        transparency: { enabled: () => false, read: async () => null },
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (route) => {
        const res = await fetch(base + route);
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    };

    const pages = ['/', '/features', '/pricing', '/docs', ...GUIDES.map((g) => `/docs/${g.slug}`), '/faq', '/commands', '/about', '/privacy', '/terms'];
    try {
        await rm(OUT, { recursive: true, force: true });
        await mkdir(OUT, { recursive: true });
        const html = (buffer) => pointAppLinksAt(allowIndexing(buffer.toString('utf8')), APP_URL);

        for (const route of pages) {
            const page = await get(route);
            if (page.status !== 200) throw new Error(`${route} answered ${page.status}`);
            const dir = path.join(OUT, route === '/' ? '' : route);
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, 'index.html'), html(page.body));
        }
        // GitHub Pages serves 404.html for unknown paths.
        await writeFile(path.join(OUT, '404.html'), html((await get('/__not_a_page__')).body));

        const css = await get('/site.css');
        await writeFile(path.join(OUT, 'site.css'), css.body);
        const imgSource = path.join(ROOT, 'src/services/site/static/img');
        await mkdir(path.join(OUT, 'img'), { recursive: true });
        for (const file of await readdir(imgSource)) await copyFile(path.join(imgSource, file), path.join(OUT, 'img', file));
        await copyFile(path.join(imgSource, 'logo.png'), path.join(OUT, 'favicon.png'));
        await copyFile(path.join(imgSource, 'logo.png'), path.join(OUT, 'favicon.ico'));

        const host = new URL(SITE_URL).host;
        await writeFile(path.join(OUT, 'CNAME'), `${host}\n`);
        await writeFile(path.join(OUT, '.nojekyll'), '');
        await writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
        const urls = pages.map((route) => `  <url><loc>${SITE_URL}${route === '/' ? '/' : route}</loc></url>`).join('\n');
        await writeFile(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
        await writeFile(path.join(OUT, 'README.md'), readme({ host, pages }));
        console.log(`Exported ${pages.length} pages + 404 to ${OUT} (site ${SITE_URL}, app ${APP_URL})`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function readme({ host, pages }) {
    return `# Mewvo website

The public website of Mewvo, a Discord bot for moderation, appeals and community tools.
Plain static files: no build step, no scripts. Generated from the bot's repository with
\`npm run export:site\`; regenerate there instead of editing these files by hand.

## Pages

${pages.map((route) => `- \`${route}\``).join('\n')}

The dashboard, leaderboard, status, server rules, transparency report and "My record" need
the running bot, so their links go to **${APP_URL}**.

## Publish on GitHub Pages with ${host}

1. Create a new GitHub repository (for example \`mewvo-site\`) and push the contents of this folder
   to its \`main\` branch.
2. Repository → Settings → Pages → Source: "Deploy from a branch", branch \`main\`, folder \`/ (root)\`.
3. The \`CNAME\` file already says \`${host}\`. At your domain registrar add these DNS records:
   - \`A\` records for \`${host}\`: \`185.199.108.153\`, \`185.199.109.153\`, \`185.199.110.153\`, \`185.199.111.153\`
   - \`CNAME\` record \`www\` → \`<your-github-username>.github.io\`
4. When GitHub shows the domain as verified, tick "Enforce HTTPS".

## Connect the bot's address (${new URL(APP_URL).host})

1. In the Replit deployment, add the custom domain \`${new URL(APP_URL).host}\` and create the DNS record Replit shows.
2. Set the deployment secret \`PUBLIC_URL\` to \`${APP_URL}\`, then republish.
3. Discord Developer Portal → OAuth2 → Redirects: add \`${APP_URL}/oauth/callback\`,
   \`${APP_URL}/dashboard/oauth/callback\` and \`${APP_URL}/me/callback\`.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(() => process.exit(0), (error) => {
        console.error(`Site export failed: ${error.message}`);
        process.exit(1);
    });
}
