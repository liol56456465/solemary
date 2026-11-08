// Translated Core commands (catalog namespace core: config, premium, ping, stats, uptime, support):
// English output is the old text byte for byte; other languages are translated with Discord markup,
// codes and links kept; ephemeral replies follow the user's locale, the gift DM the server's language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botText } from '../src/utils/botText.js';
import { stepButtons } from '../src/commands/Core/configWizard.js';
import { legalLinks } from '../src/commands/Core/support.js';

const premium = await import('../src/commands/Core/premium.js');
const premiumCommand = premium.default;
const { giftDm, statusText } = premium;

const en = botText('en');
const LANGS = ['ru', 'de', 'fr', 'it', 'pl', 'es', 'pt-BR'];

test('/premium status text: English unchanged; German translated with the link and the command kept', () => {
    assert.equal(statusText(null, ''), 'You are on **Free**.\nHave a key? Use `/premium redeem`.');
    assert.equal(statusText(null, 'https://mewvo.example/'), 'You are on **Free**. Plans: https://mewvo.example/pricing\nHave a key? Use `/premium redeem`.');
    assert.equal(statusText(null, '', { lang: 'en' }), statusText(null, ''));
    const de = statusText(null, 'https://mewvo.example', { lang: 'de' });
    assert.equal(de, 'Du hast **Free**. Pläne: https://mewvo.example/pricing\nHast du einen Key? Nutze `/premium redeem`.');
    const sub = { plan_id: 'max', expires_at: new Date(Date.UTC(2027, 0, 1)) };
    const stamp = Date.UTC(2027, 0, 1) / 1000;
    assert.ok(statusText(sub).startsWith(`**Mewvo Max** until <t:${stamp}:F> (<t:${stamp}:R>).\nIn servers you own: `), statusText(sub));
    for (const lang of LANGS) {
        const text = statusText(sub, '', { lang });
        assert.ok(text.startsWith(`**Mewvo Max** `) && text.includes(`<t:${stamp}:F>`) && text.includes(`<t:${stamp}:R>`), `${lang}: ${text}`);
        assert.ok(!text.includes('In servers you own'), `${lang} translated`);
    }
});

test('gift DM: English unchanged; other languages keep the mention, the key and /premium redeem; plurals for the days', () => {
    const args = { fromId: '1', planId: 'pro', days: 30, code: 'MEWVO-AAAA-BBBB-CCCC', message: 'enjoy', redeemUrl: 'https://x/me/redeem?code=K' };
    assert.equal(giftDm(args), [
        '<@1> gave you **Mewvo Pro** for 30 days.',
        'Their note: enjoy',
        'Your key: `MEWVO-AAAA-BBBB-CCCC`',
        'Redeem it with `/premium redeem` or at https://x/me/redeem?code=K. It can be used once, within a year.',
    ].join('\n'));
    assert.equal(giftDm({ ...args, redeemUrl: null, message: '' }).split('\n').at(-1), 'Redeem it with `/premium redeem`. It can be used once, within a year.');
    assert.equal(giftDm({ ...args, message: 'see https://evil.example' }).split('\n')[1], 'Their note: see (link removed)');
    assert.equal(giftDm({ ...args, lang: 'ru', days: 5 }).split('\n')[0], '<@1> дарит вам **Mewvo Pro** на 5 дней.');
    assert.equal(giftDm({ ...args, lang: 'ru', days: 2 }).split('\n')[0], '<@1> дарит вам **Mewvo Pro** на 2 дня.');
    assert.equal(giftDm({ ...args, lang: 'de', message: 'see https://evil.example' }).split('\n')[1], 'Nachricht: see (Link entfernt)');
    for (const lang of LANGS) {
        const dm = giftDm({ ...args, lang });
        assert.ok(dm.includes('<@1>') && dm.includes('`MEWVO-AAAA-BBBB-CCCC`') && dm.includes('`/premium redeem`') && dm.includes('https://x/me/redeem?code=K'), `${lang}: ${dm}`);
        assert.ok(!dm.includes('gave you'), `${lang} translated`);
    }
});

function fakeInteraction(sub, { locale = 'en-US', userId = '200000000000000001' } = {}) {
    const replies = [];
    return {
        replies, locale, guildId: null,
        id: `i${Math.random()}`, createdTimestamp: Date.now(),
        user: { id: userId, username: 'member', globalName: 'Member' },
        options: { getSubcommand: () => sub, getString: () => null },
        reply: async (payload) => { replies.push(payload); },
    };
}
const embedOf = (i) => i.replies[0].embeds[0].data;

test('/premium replies: the user\'s Discord language (ephemeral); English as before', async () => {
    const off = fakeInteraction('status');
    await premiumCommand.execute(off, null, null, { env: {} });
    assert.equal(embedOf(off).title, 'Mewvo plan');
    assert.equal(embedOf(off).description, 'Plans are not available yet.');
    const offDe = fakeInteraction('status', { locale: 'de' });
    await premiumCommand.execute(offDe, null, null, { env: {} });
    assert.equal(embedOf(offDe).title, 'Mewvo-Plan');
    assert.equal(embedOf(offDe).description, 'Pläne sind noch nicht verfügbar.');
    const free = fakeInteraction('status', { locale: 'pt-BR' });
    await premiumCommand.execute(free, null, null, { env: { PREMIUM_TEST_CHECKOUT: 'true' }, store: { accountOf: async () => ({ subscription: null }) } });
    assert.equal(embedOf(free).description, 'Você está no **Free**.\nTem uma chave? Use `/premium redeem`.');
    assert.equal(free.replies[0].flags, 64, 'ephemeral');
});

test('config wizard buttons: English labels unchanged, translated per language', () => {
    const labels = (lang) => stepButtons('n', lang ? { lang } : {}).toJSON().components.map((b) => b.label);
    assert.deepEqual(labels(), ['Skip (keep current)', 'Stop setup']);
    assert.deepEqual(labels('de'), ['Überspringen (beibehalten)', 'Einrichtung beenden']);
    for (const lang of LANGS) {
        const [skip, stop] = labels(lang);
        assert.notEqual(skip, 'Skip (keep current)', lang);
        // The questions name the buttons: the same words as the labels.
        assert.ok(botText(lang).t('core.config.intro').includes(`**${skip.split(' (')[0]}**`), `${lang}: intro names the Skip button`);
        assert.ok(botText(lang).t('core.config.running').includes(`**${stop}**`), `${lang}: running names the Stop button`);
    }
});

test('config wizard texts: English is the old wording (DM help, refusals, summaries)', () => {
    assert.equal(en.t('core.config.dmBlocked', { help: en.t('core.config.dmHelp') }), [
        'I couldn\'t send you a DM. Enable DMs from this server, then try again.',
        '',
        '1. Right-click this server\'s name (mobile: tap the server name at the top).',
        '2. Open **Privacy Settings**.',
        '3. Turn on **Allow direct messages from server members**.',
        '4. Click **Start setup** again.',
    ].join('\n'));
    assert.equal(en.tp('core.config.summary.updated', 2), 'Updated **2** setting(s).');
    assert.equal(en.tp('core.config.summary.stoppedSaved', 1), 'Setup stopped early. Saved **1** setting(s) before stopping.');
    assert.equal(en.t('core.config.prompt.prefixQuestion', { prefix: '!' }), 'What command prefix should this server use?\nCurrent: `!`\nType the new prefix, or press **Skip** to keep it.');
    assert.equal(en.t('core.config.saved.log', { channel: '<#5>' }), 'Log channel saved as <#5>.');
    assert.equal(botText('pl').tp('core.config.summary.updated', 5), 'Zaktualizowano **5** ustawień.');
    for (const lang of LANGS) {
        const tr = botText(lang);
        // Typed keywords stay English (the code checks `none` / skip / cancel).
        assert.ok(tr.t('core.config.prompt.logQuestion').includes('`none`'), `${lang}: keeps \`none\``);
        assert.ok(tr.t('core.config.panel.accessText').includes('`/commands dashboard`'), `${lang}: keeps the command`);
        assert.ok(tr.t('core.config.modal.prefixLabel').length <= 45, `${lang}: modal label at most 45`);
    }
});

test('ping, stats, uptime, support: English unchanged; uptime format; legal links translated', () => {
    assert.equal(en.t('core.ping.ms', { value: 42 }), '42ms');
    assert.equal(en.t('core.uptime.value', { days: 1, hours: 2, minutes: 3, seconds: 4 }), '1d 2h 3m 4s');
    assert.equal(en.t('core.support.text'), 'Join the Mewvo support server to ask questions, appeal, report bugs or suggest features.');
    assert.equal(en.t('core.stats.error'), 'Couldn\'t get the stats.');
    assert.deepEqual(legalLinks({ PUBLIC_URL: 'https://m.example' }), [['Privacy Policy', 'https://m.example/privacy'], ['Terms', 'https://m.example/terms']]);
    assert.deepEqual(legalLinks({ PUBLIC_URL: 'https://m.example' }, { lang: 'de' }), [['Datenschutzerklärung', 'https://m.example/privacy'], ['AGB', 'https://m.example/terms']]);
    for (const lang of LANGS) {
        assert.notEqual(botText(lang).t('core.support.title'), 'Need help?', lang);
        assert.ok(botText(lang).t('core.uptime.value', { days: 1, hours: 2, minutes: 3, seconds: 4 }).startsWith('1'), lang);
    }
});
