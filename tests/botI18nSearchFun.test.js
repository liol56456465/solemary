// /search and /fun in 8 languages: English output unchanged, public replies in the server's
// language, error answers in the user's, user text never read as a placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANG_CODES } from '../src/services/site/i18n.js';
import { botText } from '../src/utils/botText.js';
import { resetSettingsCacheForTests, setSettingsCacheForTests } from '../src/services/settings/guildSettings.js';
import { wiktionaryCredit } from '../src/commands/Search/modules/search_define.js';
import fight from '../src/commands/Fun/modules/fun_fight.js';
import flip from '../src/commands/Fun/modules/fun_flip.js';
import fun from '../src/commands/Fun/fun.js';

const GUILD = '300000000000000007';

function fakeInteraction({ locale = 'en-US', opponent = null } = {}) {
    const replies = [];
    const interaction = {
        id: '1', deferred: true, replied: false, createdTimestamp: Date.now(), locale, guildId: GUILD,
        user: { id: '10', username: 'Alice' },
        options: { getUser: () => opponent },
        isRepliable: () => true,
        async editReply(payload) { replies.push(payload); return {}; },
        async reply(payload) { replies.push(payload); return {}; },
    };
    return { interaction, replies };
}

async function withServerLanguage(lang, fn) {
    resetSettingsCacheForTests();
    setSettingsCacheForTests(GUILD, lang ? { botLanguage: lang } : {});
    try { return await fn(); } finally { resetSettingsCacheForTests(); }
}

test('English texts are the old ones byte for byte', () => {
    const en = botText('en');
    assert.equal(en.t('fun.flip.result', { result: en.t('fun.flip.heads') }), "It's **Heads**.");
    assert.equal(en.t('fun.fight.action.punch', { round: 2, attacker: 'A', target: 'B', damage: 7 }), '**Round 2:** A throws a wild punch on B for 7 damage.');
    assert.equal(en.t('fun.roll.rolls', { rolls: '1 + 2' }) + en.t('fun.roll.total', { total: '3+ (5)', final: 8 }), '**Rolls:** 1 + 2\n**Total:** 3+ (5) = **8**');
    assert.equal(en.t('fun.count.onText', { channel: '<#5>', system: 'Decimal' }), 'Counting is on in <#5> (**Decimal**). Start at **1**. Nobody can post two numbers in a row.');
    assert.equal(en.t('search.google.link', { query: 'cats', url: 'https://www.google.com/search?q=cats' }), '[Search for "cats"](https://www.google.com/search?q=cats)');
    assert.equal(en.t('search.define.footer', { credit: wiktionaryCredit({}).footer }), 'Definitions from Wiktionary (CC BY-SA) · via Free Dictionary API');
    assert.equal(en.t('search.define.cooldown', { seconds: 4 }), 'Wait 4 s before looking up another word.');
});

test('/define credit: English default unchanged, other languages keep the links', () => {
    const entry = { license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' }, sourceUrls: ['https://en.wiktionary.org/wiki/cat'] };
    assert.deepEqual(wiktionaryCredit(entry), wiktionaryCredit(entry, { lang: 'en' }));
    for (const lang of LANG_CODES) {
        const { line } = wiktionaryCredit(entry, { lang });
        assert.ok(line.includes('(https://en.wiktionary.org/wiki/cat)') && line.includes('[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0)'), `${lang}: ${line}`);
    }
    assert.match(wiktionaryCredit(entry, { lang: 'de' }).line, /^Definitionen aus /);
});

test('/fun fight is a public reply: the server\'s language, not the user\'s', async () => {
    const opponent = { id: '11', username: 'Bob{rounds}', bot: false };
    await withServerLanguage(null, async () => {
        const { interaction, replies } = fakeInteraction({ locale: 'de', opponent });
        await fight.execute(interaction);
        const embed = replies.at(-1).embeds[0].data;
        assert.ok(embed.title.includes('Fight over'), 'no server language: English even for a German user');
        assert.match(embed.description, /^\*\*Alice\*\* challenges \*\*Bob\{rounds\}\*\* to a fight\. \d rounds\./, 'user text is not a placeholder');
    });
    await withServerLanguage('de', async () => {
        const { interaction, replies } = fakeInteraction({ locale: 'en-US', opponent });
        await fight.execute(interaction);
        const embed = replies.at(-1).embeds[0].data;
        assert.ok(embed.title.includes('Kampf vorbei'), embed.title);
        assert.match(embed.description, /fordert \*\*Bob\{rounds\}\*\* zum Kampf heraus/);
        assert.ok(!/\{(round|attacker|target|damage|winner|loser)\}/.test(embed.description));
    });
    await withServerLanguage('ru', async () => {
        const { interaction, replies } = fakeInteraction({ opponent: { id: '12', username: 'Bot', bot: true } });
        await fight.execute(interaction);
        assert.ok(replies.at(-1).embeds[0].data.title.includes('С ботом драться нельзя'));
    });
});

test('/fun flip in every server language renders a full result', async () => {
    for (const lang of LANG_CODES) {
        await withServerLanguage(lang, async () => {
            const { interaction, replies } = fakeInteraction();
            interaction.deferred = false;
            await flip.execute(interaction);
            const embed = replies.at(-1).embeds[0].data;
            const tr = botText(lang);
            assert.ok([tr.t('fun.flip.heads'), tr.t('fun.flip.tails')].some((r) => embed.description === tr.t('fun.flip.result', { result: r })), `${lang}: ${embed.description}`);
        });
    }
});

test('/fun: the merged subcommands carry their translated descriptions', () => {
    const json = fun.data.toJSON();
    const flipSub = json.options.find((o) => o.name === 'flip');
    assert.equal(flipSub.description, 'Flip a coin');
    assert.equal(flipSub.description_localizations.de, 'Eine Münze werfen');
    const roll = json.options.find((o) => o.name === 'roll');
    assert.equal(roll.options[0].description_localizations['pt-BR'], botText('pt-BR').t('fun.slash.fun.sub.roll.options.notation'));
});
