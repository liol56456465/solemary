// Automod test run (services/automod/backtest.js) and the pure content checker it uses
// (automodService.contentHits): the same verdicts as the live path for content rules, no
// change to the live in-memory state, and the job (paging, day cutoff, the 2,000 cap,
// skipping bots and administrators, masking, the 20-example cap, refusals, failures).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAIN_GUILD_ID ??= '100000000000000001';

const { automodStateSizes, contentHits, evaluateMessage, resetAutomodState } = await import('../../src/services/automod/automodService.js');
const { findCustomRuleHit, resetCustomRulesCache } = await import('../../src/services/automod/customRules.js');
const { automodConfig } = await import('../../src/config/automod.js');
const { normalizeSettings } = await import('../../src/services/automod/automodSettings.js');
const { setGuildOwnerResolver, setPremiumCache } = await import('../../src/services/billing/premiumEffects.js');
const { logger } = await import('../../src/utils/logger.js');
const {
    BacktestError, MAX_EXAMPLES, MAX_MESSAGES, cleanDraftRule, createBacktestRunner, looksTooStrict, maskExcerpt, maskTerm, maskWord,
} = await import('../../src/services/automod/backtest.js');

const DAY = 24 * 3600 * 1000;
const GUILD = 'g-backtest';
const OWNER = '200000000000000009';
const FOREIGN = '900000000000000001';
const VIEW = 1n << 10n;
const HISTORY = 1n << 16n;

afterEach(() => {
    automodConfig.automodCustomRules = undefined;
    setPremiumCache([]);
    setGuildOwnerResolver(null);
    resetAutomodState();
    resetCustomRulesCache();
});

const client = {
    user: { id: 'bot' },
    fetchInvite: async (code) => (code === 'foreign' ? { guild: { id: FOREIGN } } : code === 'ours' ? { guild: { id: process.env.MAIN_GUILD_ID } } : null),
};

function message(content, { id = 'm1', authorId = 'u1', mentions = [], channelId = 'c1', repliedUser = null } = {}) {
    return {
        id, content, guildId: GUILD, channelId, url: `https://discord.com/channels/1/2/${id}`,
        guild: { id: GUILD }, client,
        author: { id: authorId, username: 'amy', createdTimestamp: Date.now() - 400 * DAY },
        mentions: { users: new Map(mentions.map((u) => [u, { id: u }])), roles: new Map(), repliedUser },
        reference: null, attachments: new Map(),
    };
}
const member = { id: 'u1', guild: { ownerId: OWNER }, joinedTimestamp: Date.now() - 100 * DAY, permissions: { has: () => false } };

const liveInvite = async (code) => (await client.fetchInvite(code))?.guild?.id === FOREIGN;

// ── the pure checker ──────────────────────────────────────────────────────

test('contentHits gives the same hits as evaluateMessage for every content rule', async () => {
    automodConfig.automodCustomRules = [{ id: 'adsr2345', name: 'Ads', words: ['buy followers'], action: 'warn', muteDuration: null, enabled: true }];
    setGuildOwnerResolver((guildId) => (guildId === GUILD ? OWNER : null));
    setPremiumCache([{ user_id: OWNER, plan_id: 'pro', started_at: new Date(), expires_at: new Date(Date.now() + 10 * DAY) }]);
    const cases = [
        message('hello there, how is everyone doing today'),
        message('claim free nitro at https://dlscord-gift.com/x'),
        message('see https://pornhub.com/view'),
        message('join discord.gg/foreign now'),
        message('join discord.gg/ours now'),
        message('mail me at someone@example.com'),
        message('you are a n1gg3r'),
        message('send nudes'),
        message('send nudes', { mentions: ['u2'] }),
        message('you are so stupid', { mentions: ['u2'] }),
        message('you are so stupid'),
        message('hi <@1> <@2> <@3> <@4> <@5>', { mentions: ['a1', 'a2', 'a3', 'a4', 'a5'] }),
        message('@everyone look'),
        message('THIS IS A VERY LOUD MESSAGE FOR EVERYONE'),
        message('𝓱𝓮𝓵𝓵𝓸 friends'),
        message('Bonjour tout le monde, comment allez-vous aujourd\'hui mes amis'),
        message('please buy followers here'),
    ];
    for (const msg of cases) {
        resetAutomodState();
        resetCustomRulesCache();
        const live = await evaluateMessage(msg, member);
        const pure = await contentHits(msg, member, { isForeignInvite: liveInvite, matchCustom: (text) => findCustomRuleHit(text, GUILD) });
        assert.deepEqual(pure, live, msg.content);
    }
    // The cases above cover every content rule.
    resetAutomodState();
    const rules = new Set();
    for (const msg of cases) {
        for (const hit of await contentHits(msg, member, { isForeignInvite: liveInvite, matchCustom: (text) => findCustomRuleHit(text, GUILD) })) rules.add(hit.rule);
    }
    for (const rule of ['scam', 'nsfw', 'advertising', 'privacy', 'language', 'sexual', 'disrespect', 'mentions', 'caps', 'characters', 'english', 'custom-adsr2345']) {
        assert.ok(rules.has(rule), `covered: ${rule}`);
    }
});

test('contentHits never touches the live state; timing rules (spam, harassment, ad-bot) stay live only', async () => {
    resetAutomodState();
    const before = automodStateSizes();
    for (let i = 0; i < 8; i += 1) {
        const hits = await contentHits(message('you are so stupid', { id: `m${i}`, mentions: ['u2'] }), member, { isForeignInvite: liveInvite });
        assert.deepEqual(hits.map((h) => h.rule), ['disrespect'], 'never harassment or spam');
    }
    const fresh = { ...member, joinedTimestamp: Date.now() - 1000 };
    assert.equal((await contentHits(message('join discord.gg/foreign now'), fresh, { isForeignInvite: liveInvite }))[0].forceLastStep, undefined, 'no ad-bot pattern');
    assert.deepEqual(automodStateSizes(), before, 'no live map changed');

    // The live path on the same messages: harassment after 3, spam after repeats.
    const live = [];
    for (let i = 0; i < 6; i += 1) live.push((await evaluateMessage(message('you are so stupid', { id: `m${i}`, mentions: ['u2'] }), member)).map((h) => h.rule));
    assert.deepEqual(live[0], ['disrespect']);
    assert.ok(live[2].includes('harassment'));
    assert.ok(live.some((rules) => rules.includes('spam')));
    assert.ok(automodStateSizes().history > 0, 'the live path does keep history');
    const adBot = await evaluateMessage(message('join discord.gg/foreign now', { authorId: 'u9' }), fresh);
    assert.equal(adBot[0].forceLastStep, true);
});

// ── masking ───────────────────────────────────────────────────────────────

test('maskWord and maskExcerpt: matched words partly masked, short excerpt, slurs always masked, unmaskable matches hidden', () => {
    assert.equal(maskWord('fuck'), 'f**k');
    assert.equal(maskWord('ab'), 'a*');
    assert.equal(maskWord('fag'), 'f**', 'three letters: only the first stays');
    assert.equal(maskWord('x'), '*');
    assert.equal(maskExcerpt('well you are so stupid today', ['stupid']), 'well you are so s****d today');
    assert.equal(maskExcerpt('please buy followers here', ['buy followers']), 'please b** f*******s here');
    assert.equal(maskExcerpt('call him a n1gg3r ok', []), 'call him a n****r ok', 'slurs are masked even without a term');
    assert.equal(maskExcerpt('you n i g g e r', ['nigger']), null, 'spelled out: nothing shown');
    assert.equal(maskExcerpt('you idiot n i g g e r', ['nigger', 'idiot']), null, 'one term found, another not: still nothing shown');
    assert.equal(maskExcerpt('you idiot nig ger', ['nigger', 'idiot']), null);
    const long = `${'word '.repeat(30)}stupid ${'tail '.repeat(30)}`;
    const cut = maskExcerpt(long, ['stupid']);
    assert.ok(cut.startsWith('… ') && cut.endsWith(' …'));
    assert.ok(cut.includes('s****d'));
    assert.ok(cut.split(' ').length <= 17);
    assert.equal(maskExcerpt('mail me at a.b@example.com or +44 20 7946 0958', [], { hidePersonal: true }), 'mail me at [e-mail] or +## ## #### ####');
    assert.equal(maskExcerpt('', ['x']), '');
});

test('cleanDraftRule cleans like a stored custom rule; empty draft → null; bad words → BacktestError', () => {
    assert.equal(cleanDraftRule(null), null);
    assert.equal(cleanDraftRule({ name: '', words: '  ' }), null);
    const rule = cleanDraftRule({ name: ' Promo ', words: 'Promo Code\npromo code\nbuy now' });
    assert.deepEqual({ name: rule.name, words: rule.words, action: rule.action }, { name: 'Promo', words: ['promo code', 'buy now'], action: 'delete' });
    assert.equal(cleanDraftRule({ words: 'spoiler' }).name, 'Draft rule');
    assert.throws(() => cleanDraftRule({ name: 'X', words: 'a' }), (error) => error instanceof BacktestError && /^Draft rule: .*at least 2/.test(error.userMessage));
});

// ── the job ───────────────────────────────────────────────────────────────

/** A fake channel: `messages` newest first; fetch honours limit and before, and records calls. */
function fakeChannel(id, name, messages, { failWith = null } = {}) {
    const channel = { id, name, calls: [], parentId: null };
    channel.messages = {
        fetch: async ({ limit, before, cache }) => {
            channel.calls.push({ limit, before: before ?? null, cache });
            if (failWith) throw failWith;
            const sorted = [...messages].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
            const start = before ? sorted.findIndex((m) => m.id === before) + 1 : 0;
            return new Map(sorted.slice(start, start + limit).map((m) => [m.id, m]));
        },
    };
    return channel;
}

let seq = 0;
function histMsg(channelId, ageMs, content, { bot = false, authorId = 'u1', now }) {
    seq += 1;
    const id = String(1000000 + seq);
    return {
        id, content, guildId: GUILD, channelId, createdTimestamp: now - ageMs, url: `https://discord.com/channels/${GUILD}/${channelId}/${id}`,
        author: { id: authorId, bot, tag: `user${authorId}`, username: `user${authorId}`, createdTimestamp: now - 400 * DAY },
        mentions: { users: new Map(), roles: new Map(), repliedUser: null }, reference: null, attachments: new Map(), client,
    };
}

function fakeGuild(channels, { members = {}, perms = () => VIEW | HISTORY } = {}) {
    const guild = { id: GUILD, ownerId: OWNER, client, fetched: [] };
    guild.channels = { cache: new Map(channels.map((c) => [c.id, c])) };
    guild.members = {
        me: { permissionsIn: (channel) => ({ has: (flag) => (perms(channel) & flag) === flag }) },
        cache: new Map(),
        fetch: async (id) => {
            guild.fetched.push(id);
            if (members[id] === undefined) throw new Error('Unknown Member');
            return members[id];
        },
    };
    return guild;
}

const plainMember = { id: 'u1', permissions: { has: () => false } };
const admin = { id: 'a1', permissions: { has: (flag) => flag === (1n << 3n) } };
const SETTINGS = normalizeSettings({ enabled: true, mode: 'enforce' });

test('job: pages with before, stops at the day cutoff, skips bots and administrators, counts per rule, masks examples', async () => {
    const now = Date.now();
    const msgs = [];
    for (let i = 0; i < 150; i += 1) msgs.push(histMsg('c1', i * 60 * 1000, i % 10 === 0 ? 'you are a stupid idiot' : 'hello', { now }));
    msgs.push(histMsg('c1', 1000 * 30, 'beep', { bot: true, now }));
    msgs.push(histMsg('c1', 1000 * 40, 'n1gg3r', { authorId: 'a1', now }));
    msgs.push(histMsg('c1', 2 * DAY, 'old n1gg3r', { now })); // older than 1 day: never read
    const channel = fakeChannel('c1', 'general', msgs);
    const guild = fakeGuild([channel], { members: { u1: plainMember, a1: admin } });
    const runner = createBacktestRunner({ now: () => now });
    const started = runner.start({ guild, channelIds: ['c1'], days: 1, settings: SETTINGS, customRules: [], draft: { name: 'Hello', words: 'hello' } });
    assert.equal(started.status, 'running');
    await runner.done(GUILD);
    const job = runner.get(GUILD);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(channel.calls.map((c) => c.limit), [100, 100]);
    assert.ok(channel.calls.every((c) => c.cache === false), 'never fills the live message cache');
    assert.equal(channel.calls[0].before, null);
    assert.ok(channel.calls[1].before, 'second page uses before');
    const r = job.result;
    assert.equal(r.read, 152, '150 + bot + admin; the 2-day-old one is past the cutoff');
    assert.equal(r.skippedBots, 1);
    assert.equal(r.skippedAdmins, 1);
    assert.equal(r.checked, 150);
    assert.equal(r.capped, false);
    assert.equal(r.byRule.draft.count, 135);
    assert.equal(r.byRule.draft.label, 'Draft: Hello');
    assert.equal(r.examples.length, MAX_EXAMPLES, 'examples capped at 20');
    // "stupid idiot" without a target is no rule hit; the draft "hello" is.
    assert.equal(r.byRule.disrespect, undefined);
    const ex = r.examples[0];
    assert.equal(ex.excerpt, 'h***o');
    assert.equal(ex.author, 'useru1');
    assert.equal(ex.channelName, 'general');
    assert.match(ex.url, /^https:\/\/discord\.com\/channels\//);
    assert.deepEqual(guild.fetched, ['u1', 'a1'], 'each author fetched once');
});

test('job: built-in rules with the current rule modes; examples mask the matched word; rules that are off are not counted', async () => {
    const now = Date.now();
    const msgs = [
        histMsg('c1', 1000, 'what a n1gg3r move', { now }),
        histMsg('c1', 2000, 'THIS IS A VERY LOUD MESSAGE FOR EVERYONE', { now }),
        histMsg('c1', 3000, 'mail me at a@example.com', { now }),
        histMsg('c1', 4000, 'CALL ME ON +44 20 7946 0958 RIGHT NOW PLEASE', { now }),
    ];
    const guild = fakeGuild([fakeChannel('c1', 'general', msgs)], { members: { u1: plainMember } });
    const runner = createBacktestRunner({ now: () => now });
    const settings = normalizeSettings({ enabled: false, mode: 'enforce', ruleModes: { privacy: 'monitor' }, channelRules: {} });
    runner.start({ guild, channelIds: ['c1'], days: 1, settings });
    await runner.done(GUILD);
    const job = runner.get(GUILD);
    assert.equal(job.params.automodEnabled, false);
    assert.deepEqual(Object.keys(job.result.byRule).sort(), ['caps', 'language', 'privacy']);
    assert.deepEqual(job.result.byRule.privacy, { label: 'Sharing personal info', count: 2, on: 0, monitor: 2, members: 1, mayBeTooStrict: false });
    assert.equal(job.result.examples[0].excerpt, 'what a n****r move');
    assert.equal(job.result.examples[2].excerpt, 'mail me at [e-mail]');
    assert.ok(!job.result.examples[3].excerpt.includes('7946'), 'digits hidden');

    // Privacy off: the phone number still never shows in an example (caps hit only).
    const off = createBacktestRunner({ now: () => now });
    off.start({ guild, channelIds: ['c1'], days: 1, settings: normalizeSettings({ enabled: true, ruleModes: { privacy: 'off' } }) });
    await off.done(GUILD);
    const phone = off.get(GUILD).result.examples.find((ex) => ex.rules.includes('Excessive caps') && ex.excerpt.startsWith('CALL'));
    assert.ok(phone, 'caps example present');
    assert.ok(!phone.excerpt.includes('7946'));
    assert.ok(!JSON.stringify(job).includes('n1gg3r'), 'the slur appears nowhere in the result');
});

test('job: at most 2,000 messages in total, newest first across channels', async () => {
    const now = Date.now();
    // c1 has a message every minute, c2 every 2 minutes: the newest 2,000 overall.
    const a = Array.from({ length: 1500 }, (_, i) => histMsg('c1', i * 60 * 1000, 'hi', { now }));
    const b = Array.from({ length: 1500 }, (_, i) => histMsg('c2', i * 120 * 1000 + 30 * 1000, 'hi', { now }));
    const guild = fakeGuild([fakeChannel('c1', 'one', a), fakeChannel('c2', 'two', b)], { members: { u1: plainMember } });
    const runner = createBacktestRunner({ now: () => now });
    runner.start({ guild, channelIds: ['c1', 'c2'], days: 7, settings: SETTINGS });
    await runner.done(GUILD);
    const r = runner.get(GUILD).result;
    assert.equal(r.read, MAX_MESSAGES);
    assert.equal(r.capped, true);
    // Newest first: c1 ~2/3 of the messages, c2 ~1/3.
    const [one, two] = r.channels.map((c) => c.read);
    assert.equal(one + two, MAX_MESSAGES);
    assert.ok(Math.abs(one - 1334) <= 2 && Math.abs(two - 666) <= 2, `${one}/${two}`);
});

test('job refusals: missing permissions name the channel; non-text channel; channel count and days; one run per guild', async () => {
    const now = Date.now();
    const c1 = fakeChannel('c1', 'general', []);
    const c2 = fakeChannel('c2', 'secret', []);
    const guild = fakeGuild([c1, c2, { id: 'v1', name: 'voice' }], { perms: (ch) => (ch.id === 'c2' ? VIEW : VIEW | HISTORY) });
    const runner = createBacktestRunner({ now: () => now });
    const refuse = (params, pattern) => assert.throws(() => runner.start({ guild, settings: SETTINGS, days: 1, ...params }), (e) => e instanceof BacktestError && pattern.test(e.userMessage));
    refuse({ channelIds: ['c1', 'c2'] }, /I am missing Read Message History in #secret/);
    refuse({ channelIds: ['v1'] }, /#voice is not a text channel/);
    refuse({ channelIds: [] }, /at least one channel/);
    refuse({ channelIds: Array.from({ length: 21 }, (_, i) => `x${i}`) }, /at most 20 channels/);
    refuse({ channelIds: ['c1'], days: 30 }, /1, 3 or 7 days/);
    refuse({ channelIds: ['zz'] }, /not in the server/);
    refuse({ channelIds: ['c1'], draft: { name: 'x', words: 'é' } }, /^Draft rule:/);
    assert.equal(runner.get(GUILD), null, 'nothing started');

    // A slow channel keeps the job running; a second start is refused.
    let release;
    const realFetch = c1.messages.fetch;
    c1.messages.fetch = () => new Promise((resolve) => { release = () => { c1.messages.fetch = realFetch; resolve(new Map()); }; });
    runner.start({ guild, channelIds: ['c1'], days: 1, settings: SETTINGS });
    assert.equal(runner.get(GUILD).status, 'running');
    refuse({ channelIds: ['c1'] }, /already running/);
    release();
    await runner.done(GUILD);
    assert.equal(runner.get(GUILD).status, 'done');
    // Done: a new run may start.
    runner.start({ guild, channelIds: ['c1'], days: 1, settings: SETTINGS });
    await runner.done(GUILD);
});

test('job failures: a missing-permission error names the channel; other errors are generic and log no content; results expire after 30 minutes', async () => {
    let now = Date.now();
    const denied = Object.assign(new Error('Missing Access'), { code: 50001 });
    const guild = fakeGuild([fakeChannel('c1', 'general', [], { failWith: denied })]);
    const runner = createBacktestRunner({ now: () => now });
    runner.start({ guild, channelIds: ['c1'], days: 3, settings: SETTINGS });
    await runner.done(GUILD);
    const job = runner.get(GUILD);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'I could not read #general: I am missing View Channel or Read Message History there.');

    const warnings = [];
    const realWarn = logger.warn;
    logger.warn = (line) => { warnings.push(String(line)); };
    try {
        const secret = histMsg('c2', 1000, 'top secret words', { now });
        const broken = fakeChannel('c2', 'two', [secret]);
        const g2 = fakeGuild([broken], { members: { u1: plainMember } });
        g2.id = 'g-two';
        // contentHits reads message.mentions: make it throw an unexpected error.
        Object.defineProperty(secret, 'mentions', { get() { throw new Error('boom'); } });
        runner.start({ guild: g2, channelIds: ['c2'], days: 1, settings: SETTINGS });
        await runner.done('g-two');
        const failed = runner.get('g-two');
        assert.equal(failed.status, 'failed');
        assert.match(failed.error, /unexpected error/);
        assert.ok(warnings.some((w) => w.includes('boom')));
        assert.ok(!warnings.some((w) => w.includes('top secret')), 'message content never logged');
    } finally {
        logger.warn = realWarn;
    }

    now += 31 * 60 * 1000;
    assert.equal(runner.get(GUILD), null, 'expired after 30 minutes');
});

// ── noise signal, word breakdown, rules that are off ─────────────────────

test('looksTooStrict: only at 10+ messages AND 3+ members AND 2%+ of the checked messages', () => {
    assert.equal(looksTooStrict({ count: 10, members: 3 }, 500), true, '2% exactly');
    assert.equal(looksTooStrict({ count: 9, members: 9 }, 10), false, 'too few messages, however large the share');
    assert.equal(looksTooStrict({ count: 300, members: 2 }, 400), false, 'one or two members tripping it again and again');
    assert.equal(looksTooStrict({ count: 10, members: 3 }, 501), false, 'under 2%');
    assert.equal(looksTooStrict({ count: 10, members: 3 }, 0), false, 'nothing checked');
    assert.equal(looksTooStrict(null, 100), false);
});

test('maskTerm masks every part of a word or phrase like maskWord', () => {
    assert.equal(maskTerm('nigger'), 'n****r');
    assert.equal(maskTerm('buy followers'), 'b** f*******s');
    assert.equal(maskTerm('  free   nitro '), 'f**e n***o');
    assert.equal(maskTerm(''), '*');
});

test('job: members, one count per rule per message, masked word breakdown, off rules counted apart, the strict hint, the draft words kept for "Add this rule"', async () => {
    const now = Date.now();
    const msgs = [];
    let age = 1000;
    const add = (content, authorId) => { msgs.push(histMsg('c1', age, content, { authorId, now })); age += 1000; };
    const people = ['u1', 'u2', 'u3'];
    for (let i = 0; i < 8; i += 1) add('send nudes', people[i % 3]); // language (sexual word, nobody aimed at)
    add('n1gg3r', 'u2');
    add('n1gg3r', 'u2');
    add('send nudes n1gg3r', 'u3'); // two language hits, one message
    for (const id of people) add('THIS IS A VERY LOUD MESSAGE FOR EVERYONE', id); // caps is off
    for (let i = 0; i < 36; i += 1) add('hello', 'u1'); // the draft, one member only
    const members = Object.fromEntries(people.map((id) => [id, { id, permissions: { has: () => false } }]));
    const guild = fakeGuild([fakeChannel('c1', 'general', msgs)], { members });
    const runner = createBacktestRunner({ now: () => now });
    const settings = normalizeSettings({ enabled: true, mode: 'enforce', ruleModes: { caps: 'off' } });
    runner.start({ guild, channelIds: ['c1'], days: 1, settings, draft: { name: 'Hello', words: 'hello\nhi there' } });
    await runner.done(GUILD);
    const job = runner.get(GUILD);
    assert.equal(job.status, 'done', job.error);
    const r = job.result;
    assert.equal(r.checked, 50);
    const language = r.byRule.language;
    assert.equal(language.count, 11, 'the message with two language hits counts once');
    assert.equal(language.members, 3);
    assert.deepEqual(language.words, [{ word: 'n***s', count: 9 }, { word: 'n****r', count: 3 }]);
    assert.equal(language.moreWords, 0);
    assert.equal(language.mayBeTooStrict, true, '11 messages, 3 members, 22%');
    // caps is off: not a broken rule, but listed apart for "Turn on".
    assert.equal(r.byRule.caps, undefined);
    assert.deepEqual(r.offRules.caps, { label: 'Excessive caps', count: 3, members: 3, mayBeTooStrict: false });
    assert.equal(r.hitMessages, 11 + 36, 'off rules do not count as broken');
    const draft = r.byRule.draft;
    assert.equal(draft.count, 36);
    assert.equal(draft.members, 1);
    assert.equal(draft.mayBeTooStrict, false, 'one member only: never "too strict"');
    assert.deepEqual(draft.words, [{ word: 'h***o', count: 36 }]);
    assert.deepEqual(job.params.draft, { name: 'Hello', words: 2, list: ['hello', 'hi there'] });
    // No raw matched word and no member id list anywhere in the result.
    const json = JSON.stringify(r);
    for (const word of ['nudes', 'nigger', 'n1gg3r', 'hello']) assert.ok(!json.includes(word), word);
});

test('job: a failed run still turns its word counts into masked words', async () => {
    const now = Date.now();
    const first = histMsg('c1', 1000, 'you n1gg3r', { now });
    const second = histMsg('c1', 2000, 'later', { now });
    Object.defineProperty(second, 'mentions', { get() { throw new Error('boom'); } });
    const guild = fakeGuild([fakeChannel('c1', 'general', [first, second])], { members: { u1: plainMember } });
    const realWarn = logger.warn;
    logger.warn = () => {};
    try {
        const runner = createBacktestRunner({ now: () => now });
        runner.start({ guild, channelIds: ['c1'], days: 1, settings: SETTINGS });
        await runner.done(GUILD);
        const job = runner.get(GUILD);
        assert.equal(job.status, 'failed');
        assert.deepEqual(job.result.byRule.language.words, [{ word: 'n****r', count: 1 }]);
        assert.ok(!JSON.stringify(job).includes('nigger'));
    } finally {
        logger.warn = realWarn;
    }
});
