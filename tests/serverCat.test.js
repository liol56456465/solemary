// The Mewvo server cat (services/community/catModel.js + catService.js, /cat, /profile line):
// stage thresholds and progress, mood priority, name cleaning, the growth announcement posted
// once, and the /cat view reply (embed + attached PNG, no pings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.MAIN_GUILD_ID ??= '100000000000000001';
process.env.SUPPORT_GUILD_ID ??= '100000000000000002';

const {
    CAT_MOODS, CAT_STAGES, catActivity, catImageFile, catMood, catProgressLine, checkGuildCatGrowth, getServerCat, growthAction,
    isCleanCatName, moodSentence, sanitizeCatName, shownStage, stageIndexFor, stageProgress,
} = await import('../src/services/community/catService.js');
const { setSettingsCacheForTests } = await import('../src/services/settings/guildSettings.js');
const { validateSetting } = await import('../src/services/settings/settingsRegistry.js');
const { EVERYONE_COMMANDS } = await import('../src/config/commands/commandAccess.js');
const { dashboardPageFor } = await import('../src/config/commands/retirement.js');
const { default: catCommand, catViewReply } = await import('../src/commands/Community/cat.js');
const { catLine } = await import('../src/commands/Leveling/profile.js');

const GUILD = '100000000000000777';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3_600_000;

/** A fake query answering the catActivity SUM with fixed numbers. */
const sums = (total, lastWeek = 0, previousWeek = 0) => async () => ({ rows: [{ total: String(total), last_week: String(lastWeek), previous_week: String(previousWeek) }] });
const deps = (over = {}) => ({
    query: sums(0), pending: () => [], lockdown: async () => false, getState: async () => null, now: NOW, ...over,
});

test('stages: five, thresholds in one constant, stage by total', () => {
    assert.deepEqual(CAT_STAGES.map((s) => s.name), ['Kitten', 'Young cat', 'Cat', 'Big cat', 'Legend']);
    assert.deepEqual(CAT_STAGES.map((s) => s.min), [0, 2_000, 15_000, 75_000, 300_000]);
    assert.equal(stageIndexFor(0), 0);
    assert.equal(stageIndexFor(-5), 0);
    assert.equal(stageIndexFor(1_999), 0);
    assert.equal(stageIndexFor(2_000), 1);
    assert.equal(stageIndexFor(14_999), 1);
    assert.equal(stageIndexFor(15_000), 2);
    assert.equal(stageIndexFor(75_000), 3);
    assert.equal(stageIndexFor(300_000), 4);
    assert.equal(stageIndexFor(9_999_999), 4);
    assert.equal(stageIndexFor('abc'), 0);
});

test('progress: fraction towards the next stage, messages left; the last stage is complete', () => {
    assert.deepEqual(stageProgress(0), { fraction: 0, toNext: 2_000, next: CAT_STAGES[1] });
    assert.equal(stageProgress(1_000).fraction, 0.5);
    const mid = stageProgress(45_000);
    assert.equal(mid.next.name, 'Big cat');
    assert.equal(mid.fraction, 0.5);
    assert.equal(mid.toNext, 30_000);
    assert.deepEqual(stageProgress(500_000), { fraction: 1, toNext: 0, next: null });
    // Shown above the counted stage (old days pruned): progress never goes below 0.
    assert.equal(stageProgress(100, 2).fraction, 0);
    assert.equal(catProgressLine(0.3), '▰▰▰▱▱▱▱▱▱▱ 30%');
    assert.equal(catProgressLine(5), '▰▰▰▰▰▰▰▰▰▰ 100%');
});

test('mood priority: scared beats proud beats happy beats sleepy', () => {
    const grownAt = new Date(NOW - HOUR).toISOString();
    const all = { lockdown: true, grownAt, grownStage: 2, stageIndex: 2, lastWeek: 10, previousWeek: 5, now: NOW };
    assert.equal(catMood(all), 'scared');
    assert.equal(catMood({ ...all, lockdown: false }), 'proud');
    assert.equal(catMood({ ...all, lockdown: false, grownAt: new Date(NOW - 25 * HOUR).toISOString() }), 'happy', 'proud lasts 24 h');
    assert.equal(catMood({ ...all, lockdown: false, grownStage: 1 }), 'happy', 'proud only for the stage it grew into');
    assert.equal(catMood({ ...all, lockdown: false, grownAt: null, lastWeek: 5, previousWeek: 5 }), 'happy', 'equal weeks are happy');
    assert.equal(catMood({ ...all, lockdown: false, grownAt: null, lastWeek: 4, previousWeek: 5 }), 'sleepy');
    assert.equal(catMood({}), 'sleepy', 'no data');
    assert.equal(catMood({ lastWeek: 0, previousWeek: 0 }), 'sleepy', 'two empty weeks');
    assert.deepEqual(CAT_MOODS, ['scared', 'proud', 'happy', 'sleepy']);
    assert.equal(moodSentence('Mochi', 'happy'), 'Mochi is happy: the server was busier this week.');
    for (const mood of CAT_MOODS) assert.ok(!/[—–]/.test(moodSentence('M', mood)), 'no dashes');
});

test('name: plain text only, no mentions or markdown, single spaces, at most 32 characters', () => {
    assert.equal(sanitizeCatName('  Mochi  '), 'Mochi');
    assert.equal(sanitizeCatName('@everyone'), 'everyone');
    assert.equal(sanitizeCatName('<@123456789012345678>'), '123456789012345678');
    assert.equal(sanitizeCatName('**Bold** `code` ~~x~~ ||spoiler||'), 'Bold code x spoiler');
    assert.equal(sanitizeCatName('Mi​so\u0000 the   cat'), 'Miso the cat');
    assert.equal(sanitizeCatName("Sir O'Malley-Jr. !?"), "Sir O'Malley-Jr. !?");
    assert.equal(sanitizeCatName('Žemaitė Ąžuolas'), 'Žemaitė Ąžuolas');
    assert.equal(sanitizeCatName('https://evil.example'), 'httpsevil.example');
    assert.equal(sanitizeCatName('@@ <>'), null);
    assert.equal(sanitizeCatName(''), null);
    assert.equal(sanitizeCatName(null), null);
    assert.equal([...sanitizeCatName('a'.repeat(50))].length, 32);
    assert.equal(isCleanCatName('Mochi'), true);
    assert.equal(isCleanCatName('Mochi @here'), false);
    assert.equal(validateSetting('catName', 'Mochi').ok, true);
    assert.equal(validateSetting('catName', '<@&1>').ok, false);
    assert.equal(validateSetting('catName', 'x'.repeat(33)).ok, false);
    assert.equal(validateSetting('catAnnounce', false).ok, true);
});

test('activity: stored sums plus buffered counts, split into this week and the week before', async () => {
    let seen;
    const query = async (sql, params) => { seen = params; return sums(1000, 300, 200)(); };
    const pending = () => [{ day: '2026-11-01', count: 5 }, { day: '2026-10-22', count: 7 }, { day: '2026-09-01', count: 11 }];
    const a = await catActivity(GUILD, { query, pending, now: NOW });
    assert.deepEqual(a, { total: 1023, lastWeek: 305, previousWeek: 207 });
    assert.deepEqual(seen, [GUILD, '2026-10-26', '2026-10-19']);
    await assert.rejects(() => catActivity(GUILD, { query: async () => { throw new Error('db down'); }, pending: () => [] }), /db down/, 'a database error is not a sleepy kitten');
});

test('getServerCat: stage, mood, sentence, image; the stored name; never shrinks below the recorded stage', async () => {
    setSettingsCacheForTests(GUILD, { catName: 'Mochi' });
    try {
        const cat = await getServerCat(GUILD, deps({ query: sums(16_000, 50, 40) }));
        assert.equal(cat.name, 'Mochi');
        assert.equal(cat.stage.name, 'Cat');
        assert.equal(cat.mood, 'happy');
        assert.equal(cat.image, 'cat-happy.png');
        assert.equal(cat.sentence, 'Mochi is happy: the server was busier this week.');
        assert.equal(cat.total, 16_000);

        const scared = await getServerCat(GUILD, deps({ query: sums(16_000, 50, 40), lockdown: async () => true, getState: async () => ({ stage: 2, grownAt: new Date(NOW - HOUR).toISOString() }) }));
        assert.equal(scared.mood, 'scared');
        const proud = await getServerCat(GUILD, deps({ query: sums(16_000, 0, 40), getState: async () => ({ stage: 2, grownAt: new Date(NOW - HOUR).toISOString() }) }));
        assert.equal(proud.mood, 'proud');
        const kept = await getServerCat(GUILD, deps({ query: sums(100), getState: async () => ({ stage: 3, grownAt: null }) }));
        assert.equal(kept.stage.name, 'Big cat', 'pruned old days do not shrink the cat');
        assert.equal(kept.mood, 'sleepy');

        await assert.rejects(() => getServerCat(GUILD, deps({ lockdown: async () => { throw new Error('db down'); } })), /db down/);
    } finally {
        setSettingsCacheForTests(GUILD, null);
    }
    const fresh = await getServerCat(GUILD, deps());
    assert.equal(fresh.name, 'Mewvo', 'default name');
    assert.equal(fresh.image, 'kitten-sleepy.png');
});

test('every stage × mood has a committed PNG, small', () => {
    let total = 0;
    for (let i = 0; i < CAT_STAGES.length; i += 1) {
        for (const mood of CAT_MOODS) {
            const file = fileURLToPath(new URL(`../src/services/site/static/img/cat/${catImageFile(i, mood)}`, import.meta.url));
            assert.ok(existsSync(file), file);
            total += statSync(file).size;
        }
    }
    assert.ok(total < 400 * 1024, `all cats under 400 KB (${total})`);
    assert.equal(catImageFile(9, 'nope'), 'kitten-sleepy.png');
});

// ── growth announcement ─────────────────────────────────────────────────────

function fakeGuild({ channelId = '500000000000000001', canSend = true, sendFails = false } = {}) {
    const sent = [];
    const channel = {
        id: channelId,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => canSend }),
        send: async (payload) => { if (sendFails) throw new Error('Missing Access'); sent.push(payload); return { id: '1' }; },
    };
    const guild = { id: GUILD, channels: { cache: new Map([[channelId, channel]]) }, members: { me: { id: 'bot' } } };
    return { guild, sent };
}

function store(initial = null) {
    const box = { value: initial, writes: 0 };
    return { box, getState: async () => box.value, setState: async (id, value) => { box.writes += 1; box.value = value; } };
}

test('growth decision: first look records, higher stage grows, same or lower does nothing', () => {
    assert.equal(growthAction(null, 3), 'init');
    assert.equal(growthAction({ stage: 1 }, 2), 'grew');
    assert.equal(growthAction({ stage: 2 }, 2), 'none');
    assert.equal(growthAction({ stage: 3 }, 1), 'none');
    assert.equal(shownStage(1, { stage: 3 }), 3);
    assert.equal(shownStage(4, null), 4);
});

test('growth check: announces once in the level-up channel, then records; the first look never posts', async () => {
    const { guild, sent } = fakeGuild();
    const s = store();
    const leveling = async () => ({ levelUpChannel: '500000000000000001' });
    const run = (total, now = NOW) => checkGuildCatGrowth(guild, { client: {}, getLevelingConfig: leveling, ...deps({ query: sums(total), now }), ...s });

    assert.equal(await run(20_000), 'init');
    assert.deepEqual(s.box.value, { stage: 2, grownAt: null });
    assert.equal(sent.length, 0, 'an old server does not get an announcement on the first run');

    assert.equal(await run(20_500), 'none');
    assert.equal(await run(80_000), 'announced');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    const embed = sent[0].embeds[0].toJSON();
    assert.equal(embed.title, 'Mewvo grew into a Big cat');
    assert.equal(embed.image.url, 'attachment://big-proud.png');
    assert.equal(sent[0].files[0].name, 'big-proud.png');
    assert.deepEqual(s.box.value, { stage: 3, grownAt: new Date(NOW).toISOString() });

    assert.equal(await run(80_100, NOW + 5 * 60_000), 'none', 'announced once');
    assert.equal(sent.length, 1);
    // Right after growing, the cat is proud (getServerCat reads the recorded grownAt).
    const cat = await getServerCat(GUILD, deps({ query: sums(80_100), getState: s.getState, now: NOW + HOUR }));
    assert.equal(cat.mood, 'proud');
});

test('growth check: a failed post is not recorded (retried next run); announce off or no usable channel just records', async () => {
    const failing = fakeGuild({ sendFails: true });
    const s1 = store({ stage: 0, grownAt: null });
    const leveling = async () => ({ levelUpChannel: '500000000000000001' });
    assert.equal(await checkGuildCatGrowth(failing.guild, { client: {}, getLevelingConfig: leveling, ...deps({ query: sums(3_000), ...s1 }) }), 'failed');
    assert.equal(s1.box.writes, 0, 'not recorded, so it is tried again');

    const noChannel = fakeGuild();
    const s2 = store({ stage: 0, grownAt: null });
    assert.equal(await checkGuildCatGrowth(noChannel.guild, { client: {}, getLevelingConfig: async () => ({ levelUpChannel: null }), ...deps({ query: sums(3_000), ...s2 }) }), 'recorded');
    assert.equal(s2.box.value.stage, 1);
    assert.equal(noChannel.sent.length, 0);

    const noPerms = fakeGuild({ canSend: false });
    const s3 = store({ stage: 0, grownAt: null });
    assert.equal(await checkGuildCatGrowth(noPerms.guild, { client: {}, getLevelingConfig: leveling, ...deps({ query: sums(3_000), ...s3 }) }), 'recorded');
    assert.equal(noPerms.sent.length, 0);

    setSettingsCacheForTests(GUILD, { catAnnounce: false });
    try {
        const off = fakeGuild();
        const s4 = store({ stage: 0, grownAt: null });
        let asked = false;
        assert.equal(await checkGuildCatGrowth(off.guild, { client: {}, getLevelingConfig: async () => { asked = true; return {}; }, ...deps({ query: sums(3_000), ...s4 }) }), 'recorded');
        assert.equal(off.sent.length, 0);
        assert.equal(asked, false);
        assert.equal(s4.box.value.stage, 1);
    } finally {
        setSettingsCacheForTests(GUILD, null);
    }
});

// ── /cat ───────────────────────────────────────────────────────────────────

test('/cat: view is open to everyone, name is admin-only (gate); the admin page is Leveling', () => {
    const json = catCommand.data.toJSON();
    assert.equal(json.name, 'cat');
    assert.deepEqual(json.options.map((o) => o.name), ['view', 'name']);
    assert.equal(json.options[1].options[0].max_length, 32);
    assert.ok(EVERYONE_COMMANDS.has('cat view'));
    assert.ok(!EVERYONE_COMMANDS.has('cat name'));
    assert.equal(dashboardPageFor('cat name'), 'leveling');
});

test('/cat view: embed with name, stage, mood sentence, progress and total; the PNG attached; no pings', async () => {
    setSettingsCacheForTests(GUILD, { catName: 'Mochi' });
    try {
        const reply = await catViewReply(GUILD, deps({ query: sums(45_000, 20, 10) }));
        assert.deepEqual(reply.allowedMentions, { parse: [] });
        const embed = reply.embeds[0].toJSON();
        assert.equal(embed.title, 'Mochi');
        assert.equal(embed.description, 'Mochi is happy: the server was busier this week.');
        const field = (name) => embed.fields.find((f) => f.name === name)?.value;
        assert.equal(field('Stage'), 'Cat');
        assert.equal(field('Mood'), 'happy');
        assert.equal(field('Messages counted'), '45,000');
        assert.equal(field('Next stage'), '▰▰▰▰▰▱▱▱▱▱ 50%\n30,000 more messages to Big cat.');
        assert.equal(embed.image.url, 'attachment://cat-happy.png');
        assert.equal(reply.files[0].name, 'cat-happy.png');
        assert.ok(!JSON.stringify(embed).match(/[—]/), 'no em dashes');

        const legend = (await catViewReply(GUILD, deps({ query: sums(400_000) }))).embeds[0].toJSON();
        assert.equal(legend.fields.find((f) => f.name === 'Next stage').value, 'Fully grown. This is the last stage.');
    } finally {
        setSettingsCacheForTests(GUILD, null);
    }
    await assert.rejects(() => catViewReply(GUILD, deps({ query: async () => { throw new Error('db down'); } })),
        (error) => /database is not responding/.test(error.userMessage || error.context?.userMessage || error.message));
});

test('/cat view and /cat name through execute with a fake interaction', async () => {
    const replies = [];
    const interaction = (sub, name) => ({
        id: '1', guildId: GUILD, user: { id: '200000000000000002', username: 'admin' }, deferred: false, replied: false,
        createdTimestamp: Date.now(), isRepliable: () => true,
        options: { getSubcommand: () => sub, getString: () => name },
        deferReply: async function () { this.deferred = true; },
        editReply: async (payload) => { replies.push(payload); return payload; },
    });
    await catCommand.execute(interaction('view'), {}, {}, deps({ query: sums(10) }));
    assert.equal(replies.at(-1).files[0].name, 'kitten-sleepy.png');

    const saved = [];
    await catCommand.execute(interaction('name', '  Miso @here '), {}, {}, { updateSettings: async (...args) => { saved.push(args); return { changes: [] }; } });
    assert.deepEqual(saved[0].slice(0, 2), [GUILD, { catName: 'Miso here' }]);
    assert.equal(saved[0][2].module, 'leveling');
    assert.match(replies.at(-1).embeds[0].toJSON().description, /now called Miso here\./);
    await assert.rejects(() => catCommand.execute(interaction('name', '@@'), {}, {}, { updateSettings: async () => { throw new Error('must not save'); } }));
});

test('/profile: one line for the server cat, left out when it could not be read', () => {
    assert.equal(catLine({ name: 'Mochi', stage: { name: 'Young cat' }, mood: 'happy' }), 'Server cat: Mochi, Young cat, happy');
    assert.equal(catLine(null), null);
});
