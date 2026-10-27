import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    countMentions,
    detectCrossChannelSpam,
    detectNonEnglish,
    detectSpam,
    findBlockedWord,
    findImpersonation,
    findInsult,
    findInviteCodes,
    findNsfwDomain,
    findPersonalInfo,
    findScam,
    findSexualWord,
    hasLinkOrAttachment,
    isCapsFlood,
    nameKey,
} from '../../src/services/automod/filters.js';

test('blocked words match through look-alike characters, not inside other words', () => {
    assert.equal(findBlockedWord('you n1gg3r'), 'nigger');
    assert.equal(findBlockedWord('kys now'), 'kys');
    assert.equal(findBlockedWord('my class is great'), null);
    assert.equal(findBlockedWord('Scunthorpe united'), null);
});

test('insults and sexual words are found, ordinary chat is not', () => {
    assert.equal(findInsult('you are so stupid'), 'stupid');
    assert.equal(findInsult('this game is fun'), null);
    assert.equal(findSexualWord('send nudes'), 'nudes');
    assert.equal(findSexualWord('Essex is nice'), null);
});

test('invite codes', () => {
    assert.deepEqual(findInviteCodes('join discord.gg/abc123 and https://discord.com/invite/xyz'), ['abc123', 'xyz']);
    assert.deepEqual(findInviteCodes('no invites here'), []);
});

test('scam and look-alike links', () => {
    assert.match(findScam('free nitro https://dlscord-gift.com/claim'), /look-alike/);
    assert.match(findScam('steam gift http://steamcommunlty.ru/trade'), /look-alike/);
    assert.match(findScam('Free Nitro for everyone! https://example.com/x'), /lure/);
    assert.equal(findScam('see https://discord.com/channels/1/2'), null);
    assert.equal(findScam('I bought nitro yesterday'), null);
});

test('NSFW domains, including subdomains', () => {
    assert.equal(findNsfwDomain('look https://www.pornhub.com/x'), 'pornhub.com');
    assert.equal(findNsfwDomain('https://es.xvideos.com/v'), 'es.xvideos.com');
    assert.equal(findNsfwDomain('https://youtube.com/watch'), null);
});

test('personal info', () => {
    assert.equal(findPersonalInfo('mail me at cat.lover@gmail.com'), 'an e-mail address');
    assert.equal(findPersonalInfo('my number is +370 612 34567'), 'a phone number');
    assert.equal(findPersonalInfo('card 4111 1111 1111 1111'), 'a card number');
    assert.equal(findPersonalInfo('his ip is 84.15.22.190'), 'an IP address');
    assert.equal(findPersonalInfo('we won 3-2 in 2024'), null);
    assert.equal(findPersonalInfo('version 1.2.3 is out'), null);
});

test('caps flood needs enough letters', () => {
    assert.equal(isCapsFlood('WHY IS EVERYONE IGNORING ME'), true);
    assert.equal(isCapsFlood('OK LOL'), false);
    assert.equal(isCapsFlood('This is a Normal Sentence with NASA in it'), false);
});

test('non-English detection only judges clear, long enough text', () => {
    assert.equal(detectNonEnglish('Labas, kaip tau sekasi šiandien mieste draugai?'), 'lt');
    assert.equal(detectNonEnglish('hello how are you doing today my good friend'), null);
    assert.equal(detectNonEnglish('lol ok'), null);
    assert.equal(detectNonEnglish('https://example.com <@123456789012345678> :)'), null);
});

test('spam: flood and duplicates', () => {
    const now = 1_000_000;
    const flood = Array.from({ length: 6 }, (_, i) => ({ at: now - i * 500, text: `msg ${i}`, channelId: 'a' })).reverse();
    assert.equal(detectSpam(flood, now), 'flood');
    const dupes = [0, 5000, 10000].map((ms) => ({ at: now - ms, text: 'buy now', channelId: 'a' })).reverse();
    assert.equal(detectSpam(dupes, now), 'duplicate');
    assert.equal(detectSpam([{ at: now, text: 'hi', channelId: 'a' }], now), null);
});

test('the same message across several channels', () => {
    const now = 2_000_000;
    const spread = ['a', 'b', 'c'].map((channelId, i) => ({ at: now - i * 1000, text: 'join my server pls', channelId }));
    assert.equal(detectCrossChannelSpam(spread, now), true);
    assert.equal(detectCrossChannelSpam(spread.slice(0, 2), now), false);
});

test('mentions and attachments', () => {
    const message = {
        content: 'hey @everyone',
        mentions: { users: { size: 3 }, roles: { size: 2 } },
        attachments: { size: 1 },
    };
    assert.deepEqual(countMentions(message), { total: 5, everyone: true });
    assert.equal(hasLinkOrAttachment(message), true);
    assert.equal(hasLinkOrAttachment({ content: 'plain', attachments: { size: 0 } }), false);
});

test('impersonation of staff names and titles', () => {
    assert.equal(nameKey('R@m4z1nas'), 'ramazinas');
    assert.match(findImpersonation(['Ramaz1nas'], ['Ramazinas']), /imitates/);
    assert.match(findImpersonation(['Official Mod'], []), /staff title/);
    assert.equal(findImpersonation(['Modern Cat'], []), null);
    assert.equal(findImpersonation(['catlover'], ['Ramazinas']), null);
    assert.equal(findImpersonation(['Ana'], ['Ann']), null);
});
