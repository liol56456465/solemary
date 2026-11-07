// The obfuscation-resistant word matcher (services/automod/wordMatcher.js) behind the
// built-in word lists (filters.js) and the servers' custom word rules (customRules.js):
// the bypass suite is caught, ordinary words are not, hits point at the original text,
// and a long message stays fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

process.env.MAIN_GUILD_ID ??= '100000000000000001';

const { findBlockedWord, findInsult, findListWords, findSexualWord } = await import('../../src/services/automod/filters.js');
const { compileRules, matchCompiled } = await import('../../src/services/automod/customRules.js');
const { compileWords, matchWords } = await import('../../src/services/automod/wordMatcher.js');
const {
    CUSTOM_PHRASE_SUITE, CUSTOM_SUITE, SUITE, SUITE_PHRASES, obfuscationsOf, phraseObfuscationsOf,
} = await import('./fixtures/obfuscations.js');

const customRule = (words, id = 'abcd2345') => ({ id, name: 'Test', words, action: 'delete', muteDuration: null, enabled: true });
// Swearing has no built-in list: a server that wants it filtered adds the words as a custom rule.
const swearing = compileRules([customRule(SUITE.swearing, 'swear234')]);
const custom = compileRules([customRule([...CUSTOM_SUITE, ...CUSTOM_PHRASE_SUITE])]);

const FINDERS = {
    blocked: findBlockedWord,
    insult: findInsult,
    sexual: findSexualWord,
    swearing: (text) => matchCompiled(text, swearing)?.word ?? null,
    custom: (text) => matchCompiled(text, custom)?.word ?? null,
};

// Forms of the suite that are deliberately NOT caught, with why. A change that catches one
// of them must remove it here (and pass the false-positive corpus below).
const KNOWN_GAPS = new Map(Object.entries({
    // Split into two parts where a part is a common short word or 4+ letters: joining those
    // would turn ordinary pairs into hits ("sh it", "go ok", "worth less", "only fans").
    'blocked|coon|split in two': '"co on": "on" is a common word',
    'blocked|gook|split in two': '"go ok": both common words',
    'blocked|whore|split in two': '"who re": both common words',
    'insult|pathetic|split in two': 'fragment of 4+ letters',
    'insult|moron|split in two': '"mor on": "on" is a common word',
    'insult|braindead|split in two': '"brain dead": two ordinary words',
    'insult|bastard|split in two': 'fragment of 4+ letters',
    'insult|asshole|split in two': 'fragment of 4+ letters',
    'insult|worthless|split in two': '"worth less": two ordinary words',
    'sexual|onlyfans|split in two': '"only fans": two ordinary words',
    'swearing|shit|split in two': '"sh it": "it" is a common word',
    'swearing|asshole|split in two': 'fragment of 4+ letters',
    'swearing|bastard|split in two': 'fragment of 4+ letters',
    'swearing|twat|split in two': '"tw at": "at" is a common word',
    'swearing|bollocks|split in two': 'fragment of 4+ letters',
    'swearing|motherfucker|split in two': '"mother fucker": no "inside" match for a custom word',
    'custom|scam|split in two': '"sc am": "am" is a common word',
    'custom|shit|split in two': '"sh it": "it" is a common word',
    // Variants that are real words elsewhere (wordMatcher.js ALLOW list).
    'blocked|cunt|vowels dropped': '"cnt" (count)',
    'blocked|cunt|c/k swapped': 'Dutch "kunt"',
    'sexual|dick|c/k swapped': 'Dutch "dik"',
    'sexual|cock|c/k swapped': 'Turkish "çok" / Indonesian "kok"',
    'sexual|cock|ck as q': 'French "coq"',
    'sexual|boobs|vowels dropped': '"bbs" (bulletin boards)',
    'sexual|tits|vowels dropped': '"tts" (text to speech)',
    'swearing|crap|c/k swapped': 'Dutch "krap" (custom rules use the allow list too)',
    'swearing|piss|vowels dropped': '"pss" (psst)',
}));

function suiteCases() {
    const cases = [];
    for (const [list, words] of Object.entries(SUITE)) {
        for (const word of words) for (const form of obfuscationsOf(word)) cases.push({ list, word, ...form });
    }
    for (const [list, phrases] of Object.entries(SUITE_PHRASES)) {
        for (const phrase of phrases) for (const form of phraseObfuscationsOf(phrase)) cases.push({ list, word: phrase, ...form });
    }
    for (const word of CUSTOM_SUITE) for (const form of obfuscationsOf(word)) cases.push({ list: 'custom', word, ...form });
    for (const phrase of CUSTOM_PHRASE_SUITE) for (const form of phraseObfuscationsOf(phrase)) cases.push({ list: 'custom', word: phrase, ...form });
    return cases;
}

test('bypass suite: every disguised form is caught, except the documented gaps', () => {
    const cases = suiteCases();
    assert.ok(cases.length > 1500, `suite has ${cases.length} forms`);
    const missed = [];
    const gapsCaught = [];
    for (const { list, word, kind, text } of cases) {
        const key = `${list}|${word}|${kind}`;
        const hit = FINDERS[list](text);
        if (KNOWN_GAPS.has(key)) {
            if (hit) gapsCaught.push(key);
        } else if (!hit) {
            missed.push(`${key}: ${JSON.stringify(text)}`);
        }
    }
    assert.deepEqual(missed, [], 'forms that slipped through');
    assert.deepEqual(gapsCaught, [], 'now caught: remove from KNOWN_GAPS');
});

test('bypass: hidden letters, stretched letters, separators, look-alikes', () => {
    for (const text of ['f*g', 'n*gger', 'kysssss', 'n1663r', 'ńįģģęŕ', 'nіggеr', 'n_i_g_g_e_r', 'n.i.g.g.e.r', 'ni gg er', 'n​igger', 'youniggers']) {
        assert.ok(findBlockedWord(text), `should catch ${JSON.stringify(text)}`);
    }
    for (const text of ['u r a l0s3r', 'stuuupid', 'b1tch3s', 'fuk off', 'phuck you', 'fuckyou', 'stfu']) {
        assert.ok(findInsult(text), `should catch ${JSON.stringify(text)}`);
    }
    for (const text of ['s3xy', 'p0rn0', 'send p1cs', 'b00bs', 'blow job', 'p u s s y']) {
        assert.ok(findSexualWord(text), `should catch ${JSON.stringify(text)}`);
    }
    // The finders keep returning the list word (callers and cards show it).
    assert.equal(findBlockedWord('just kill yourself'), 'killyourself');
    assert.equal(findBlockedWord('KILL URSELF'), 'killyourself');
    assert.equal(findInsult('dick head'), 'dickhead');
});

// Ordinary English (and a few names and loan words) that contains the listed letters, or
// that a generated variant would otherwise hit. None of it may match any list.
const ORDINARY_WORDS = `
class classic classy assassin assassination assistant assume assets embarrass bass grass pass passage compass
cocktail cockpit peacock cockatoo cockatiel cockroach cockney hancock hitchcock shuttlecock woodcock babcock
shitake shiitake cookbook cook cooking cookie book look nook hook took spoke spike Dickens Dickinson Dickson
analysis analyst therapist therapy rapeseed grape grapes grapefruit drape scrape parapet rapture rapid
button buttons spice spicy spicer epic spit niggle niggling snigger sniggering niggardly Niger Nigeria Nigerian
Scunthorpe Penistone Essex Sussex Middlesex sexton sextant sexist sexual bisexual cumulative cucumber cumin
document circumstance scum Cumbria arsenal arsenic parse sparse hearse coarse title titles titan titillate
petition competition constitution raccoon cocoon tycoon moon soon dike dikes Trani kiss keys yes psst count
counter encounter country cunning retardant regard granny transit chunk think chin chick coin bigger digger
trigger jigger ninja yoga tilt toilet tights boo bobs come cam gum sum rum ripe rope tape prone nudge dude baked
staff stuff scampi scamper scan sham nitrogen nitrous introduction horn hornet thorny dumbbell dumbo loose looser
lose fringe shuttle deck dock duck puck pick fork folk funk fun tuck truck stuck luck muck sock sick shirk shark
shirt sheet sweet shoot shout sight shot shut shell shift hello dam dame dang crab scrap scrapbook puss peace
pisces banker anchor twit tweet what bullocks blocks mother other bother bull bulls as arts like bike hike slot
salt slit slate fig fog flag fagin chinking spick
`.trim().split(/\s+/);

const ORDINARY_SENTENCES = [
    'my class is great', 'Scunthorpe united won', 'sh it happens to be raining', 'go ok then', 'who re did that?',
    'co on the doc please', 'is it ok if I join', 'gg ez', 'gg wp everyone', 'nice gg ez', 'lol gg', 'a b c d',
    'I like big dogs', 'the snake is long', 'fire retardant spray', 'Maine coon cats are big', 'she graduated magna cum laude',
    'spick and span', 'Niger is a country in Africa', 'a fagot of sticks', 'kunt je dat doen?', 'the hotel in Trani',
    'Charles Dickens wrote books', 'the therapist was nice', 'the analysis is done', 'make the knot looser',
    'press the button', 'add a pinch of spice', 'a small niggle', 'try not to snigger', 'the peacock spread its tail',
    'I made a cocktail', 'shitake mushrooms are tasty', 'my cookbook is old', 'I am at home', 'up to you',
    'it is what it is', 'we are so back', 'I hit a wall', 'he was at the shop', 'as is', 'pass the ball',
    'version 1.2.3 is out', 'call 555-123-4567', 'we won 3-2 in 2024', '<#123456789012345678> <@123456789012345678> <t:1730000000:R>',
    'see https://example.com/assets/cocktail.png', ':) :( :D xD <3', '¯\\_(ツ)_/¯', 'snake_case and kebab-case names',
];

test('false positives: ordinary words and sentences match no list', () => {
    const hitsOf = (text) => [
        findBlockedWord(text), findInsult(text), findSexualWord(text),
        matchCompiled(text, swearing)?.word, matchCompiled(text, custom)?.word,
    ].filter(Boolean);
    const wrong = [];
    for (const text of [...ORDINARY_WORDS, ...ORDINARY_SENTENCES]) {
        const hits = hitsOf(text);
        if (hits.length) wrong.push(`${JSON.stringify(text)} → ${hits.join(', ')}`);
    }
    assert.deepEqual(wrong, []);
});

test('false positives: the website\'s English text matches no built-in list', () => {
    const dir = new URL('../../src/content/site/en/', import.meta.url);
    const texts = [];
    const walk = (value) => {
        if (typeof value === 'string') texts.push(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) walk(JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
    assert.ok(texts.length > 100, `${texts.length} strings`);
    const wrong = texts.flatMap((text) => findListWords(text).map((hit) => `${hit.list}:${hit.word} in ${JSON.stringify(text.slice(0, 80))}`));
    assert.deepEqual(wrong, []);
});

test('hits point at the original text, so they can be masked there', () => {
    const text = 'hey 𝓷𝓲𝓰𝓰𝓮𝓻 and f.u.c.k off <@123> s t u p i d';
    const hits = findListWords(text);
    for (const hit of hits) assert.equal(text.slice(hit.start, hit.end), hit.match);
    assert.deepEqual(hits.map((hit) => [hit.list, hit.word, hit.match]), [
        ['blocked', 'nigger', '𝓷𝓲𝓰𝓰𝓮𝓻'],
        ['insult', 'fuck off', 'f.u.c.k off'],
        ['insult', 'stupid', 's t u p i d'],
    ]);
    // Custom emoji keep their name in place; mentions are not read as letters.
    const emoji = 'look <a:nigga:123456> ok';
    const [hit] = findListWords(emoji);
    assert.equal(hit.match, 'nigga');
    assert.equal(findListWords('<#1234> <@&99> <@!42>').length, 0);
});

test('custom rules: same word in two rules, each its own hit; no allow list for server words', () => {
    const compiled = compileWords([{ word: 'foo', rule: 1 }, { word: 'foo', rule: 2 }]);
    assert.deepEqual(matchWords('a foo b', compiled).map((hit) => hit.entry.rule), [1, 2]);
    // A server that lists "kunt" wants it caught, even though the built-in list allows it.
    assert.ok(matchCompiled('kunt', compileRules([customRule(['kunt'])])));
    assert.equal(findBlockedWord('kunt'), null);
    // Variants of a server's word still skip ordinary words in other languages.
    const cock = compileRules([customRule(['cock'])]);
    assert.ok(matchCompiled('c0ck', cock));
    assert.ok(matchCompiled('cocк', cock));
    assert.equal(matchCompiled('çok güzel', cock), null);
    assert.equal(matchCompiled('peacock cocktail', cock), null);
});

// ── Security review of 6b29416 ────────────────────────────────────────────

test('padding does not use up the work for a later spelled-out slur', () => {
    // Joinable fragments everywhere (the old shared budget of 400 windows ran out after ~40 of them).
    for (const pad of ['a b c d e f g h i j k l m '.repeat(20), 'zx qv '.repeat(150), 'q w '.repeat(400)]) {
        for (const slur of ['n i g g e r', 'ni gg er', 'k y s']) {
            const text = `${pad}${slur}`;
            assert.ok(text.length <= 4000);
            assert.ok(findBlockedWord(text), `missed ${slur} after ${pad.length} characters of padding`);
        }
    }
    assert.ok(matchCompiled(`${'s c '.repeat(300)} s c a m`, custom));
});

test('slash-command mentions keep their name; other mentions and timestamps are blanked', () => {
    const [hit] = findListWords('use </nigger:123456789012345678> now');
    assert.equal(hit?.match, 'nigger');
    assert.equal(findInsult('</fuck you:1234>'), 'fuck you');
    assert.equal(matchCompiled('try </scam:42>', custom)?.word, 'scam');
    assert.equal(findListWords('</help:1> </ban user:2> <@1> <@!2> <@&3> <#4> <t:1730000000:R> <t:1730000000>').length, 0);
});

test('allow list: whole words only, no "starts with" escape', () => {
    for (const text of ['snigger', 'sniggers', 'sniggering', 'sniggered', 'niggard', 'niggardly', 'niggardliness']) {
        assert.equal(findBlockedWord(text), null, text);
    }
    for (const text of ['sniggernigger', 'SNIGGERNIGGERS', 'sniggerniggas', 'niggardlynigga', 'sniggerx', 'niggardnigga']) {
        assert.ok(findBlockedWord(text), `should catch ${text}`);
    }
});

test('distinctive words split across words (the old compact pass), without its false positives', () => {
    // Inputs the old filters.js caught by stripping every non-letter (git show c8fca54).
    for (const [text, word] of [
        ['nigg er', 'nigger'], ['ni gger', 'nigger'], ['nigge r', 'nigger'], ['n1gg 3r', 'nigger'], ['nigg a', 'nigga'],
        ['fa ggot', 'faggot'], ['kill your self', 'killyourself'], ['kil lyourself', 'killyourself'], ['killyour self', 'killyourself'],
        ['go killyourselfnow', 'killyourself'], ['tran ny', 'tranny'], ['wetb ack', 'wetback'], ['nigg ers', 'nigger'],
        ['k i l l y o u rself', 'killyourself'],
    ]) {
        assert.equal(findBlockedWord(text), word, text);
    }
    assert.ok(findBlockedWord('fagg ot'));
    // Deliberate gap: a hit must start where a word starts ("younigg er" is missed; the old
    // pass caught it, together with "skill yourself" and "snigger").
    assert.equal(findBlockedWord('younigg er'), null);
    // The old pass also flagged these.
    for (const text of [
        'skill yourself up', 'snigger', 'my wet back hurts', 'a wet backpack', 'Lightning gas', 'big ger', 'tran sit',
        "Niger's capital is Niamey", 'Niger’s border', "my wet back's sore", 'Mr Tran I think so',
    ]) {
        assert.equal(findBlockedWord(text), null, text);
    }
});

test('performance: many hidden-letter tokens against a large custom list', () => {
    // Worst case for a length bucket: 100 rules x 50 words, all 6 letters (5000 words), and a
    // message of ~300 distinct wildcard tokens of that length ("abc*ef"). Scanning the whole
    // length bucket per token took ~80 ms per message when idle; indexed it is about 2 ms
    // (bound 40 ms for the loaded full test run).
    // 32-bit generator (Math.imul: a plain multiply loses precision and falls into a short
    // cycle), high bits: repeated tokens would be served from the matcher's memo, not measured.
    let x = 7;
    const rand = (n) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 16) % n; };
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const word = () => Array.from({ length: 6 }, () => letters[rand(26)]).join('');
    const rules = Array.from({ length: 100 }, (_, i) => customRule(Array.from({ length: 50 }, word), `w${String(i).padStart(7, '0')}`));
    const compiled = compileRules(rules);
    const message = () => Array.from({ length: 300 }, () => { const w = word(); return `${w.slice(0, 3)}*${w.slice(4)}`; }).join(' ');
    const rounds = [];
    for (let r = 0; r < 3; r += 1) {
        const start = performance.now();
        for (let i = 0; i < 10; i += 1) matchCompiled(message(), compiled);
        rounds.push((performance.now() - start) / 10);
    }
    assert.ok(Math.min(...rounds) < 40, `per message: ${rounds.map((ms) => ms.toFixed(2)).join(' / ')} ms`);
    // Still found: a hidden-letter form of a listed word.
    const listed = rules[42].words[7];
    const hits = matchWords(`hey ${listed.slice(0, 2)}*${listed.slice(3)}`, compiled.words);
    assert.ok(hits.some((hit) => hit.entry.index === 42), 'the hidden-letter form of a listed word');
});

// Idle: about 1-11 ms per 2000-character message for all five lists (typical chat is far
// shorter); the slowest shapes are single letters and random symbols, where every window of
// spaced-out letters is checked (no shared budget to run out, see the padding test). The
// full test run loads the machine about 4x (single letters measured 47 ms there), so the bound
// is 100 ms: it still catches anything super-linear, which takes seconds.
test('performance: a 2000-character message against every list stays in the low milliseconds', () => {
    const swearingAndCustom = (text) => { matchCompiled(text, swearing); matchCompiled(text, custom); };
    const shapes = {
        chat: (i) => Array.from({ length: 400 }, (_, k) => ['hello', 'there', 'class', 'assassin', 'the', 'game', 'was', 'fun', String(i + k)][k % 9]).join(' '),
        'single letters': (i) => `${i} ${'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(40)}`,
        leetspeak: (i) => `${i} ${'5h1t n1gg3r 4$$ |-|3ll0 @#$%^&*() '.repeat(60)}`,
        wildcards: (i) => `${i} ${'f*ck s**t f*g ** ## %% __ '.repeat(80)}`,
        zalgo: (i) => `${i} ${'h̵̢̛e̷͠l̴l̸o '.repeat(200)}`,
        'one long word': (i) => `${i}${'x'.repeat(2000)}`,
        dots: (i) => `${i}${'a.'.repeat(1000)}`,
        random: (i) => {
            let out = '';
            let x = i * 7919 + 1;
            while (out.length < 2000) {
                x = (Math.imul(x, 1103515245) + 12345) >>> 0;
                out += 'abcdefghijklmnopqrstuvwxyz0123456789 .,!*_@$'[(x >>> 16) % 44];
            }
            return out;
        },
    };
    const N = 40;
    const results = [];
    for (const [name, make] of Object.entries(shapes)) {
        // Best of 3 rounds: a busy machine during the full test run slows single rounds, but
        // anything super-linear would blow past every round. Distinct texts: no cache hits.
        const rounds = [];
        for (let r = 0; r < 3; r += 1) {
            const start = performance.now();
            for (let i = 0; i < N; i += 1) {
                const text = make(r * N + i).slice(0, 2000);
                findBlockedWord(text);
                findInsult(text);
                findSexualWord(text);
                swearingAndCustom(text);
            }
            rounds.push((performance.now() - start) / N);
        }
        results.push([name, Math.min(...rounds)]);
    }
    const slow = results.filter(([, ms]) => ms > 100).map(([name, ms]) => `${name}: ${ms.toFixed(2)} ms`);
    assert.deepEqual(slow, [], `average per message: ${results.map(([name, ms]) => `${name} ${ms.toFixed(2)}`).join(', ')}`);
});
