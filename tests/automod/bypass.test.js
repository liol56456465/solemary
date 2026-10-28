import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    findBlockedWord,
    findForbiddenCharacters,
    findImpersonation,
    findInviteCodes,
    findScam,
    foldText,
    isCapsFlood,
    plainName,
} from '../../src/services/automod/filters.js';

test('folding turns styled and disguised text back into plain letters', () => {
    assert.equal(foldText('𝓱𝓮𝓵𝓵𝓸'), 'hello');
    assert.equal(foldText('ｈｅｌｌｏ'), 'hello');
    assert.equal(foldText('ⓗⓔⓛⓛⓞ'), 'hello');
    assert.equal(foldText('🄷🅔🅷'), 'heh');
    assert.equal(foldText('ʜᴇʟʟᴏ'), 'hello');
    assert.equal(foldText('hеllо'), 'hello'); // Cyrillic е and о
    assert.equal(foldText('h̵̢̛e̷͠l̴l̸o'), 'hello');
    assert.equal(foldText('he​l⁠lo'), 'hello');
});

test('blocked words are caught through fonts, look-alikes and spelling out', () => {
    for (const text of ['𝓷𝓲𝓰𝓰𝓮𝓻', 'nіgger', 'n i g g e r', 'n.i.g.g.e.r', 'n-i-g-g-e-r', 'ni gg er', 'k y s', '🅝🅘🅖🅖🅔🅡']) {
        assert.ok(findBlockedWord(text), `should catch ${text}`);
    }
    for (const text of ['I like big dogs', 'a b c d', 'the snake is long', 'fire retardant spray']) {
        assert.equal(findBlockedWord(text), null, `should allow ${text}`);
    }
});

test('broken-up invites and look-alike links', () => {
    assert.deepEqual(findInviteCodes('discord . gg / abc'), ['abc']);
    assert.deepEqual(findInviteCodes('discord(.)gg/xyz'), ['xyz']);
    assert.deepEqual(findInviteCodes('discord dot gg/zz'), ['zz']);
    assert.deepEqual(findInviteCodes('ｄｉｓｃｏｒｄ．ｇｇ/qq'), ['qq']);
    assert.match(findScam('free nitro https://dіscord-gift.com'), /look-alike|lure/);
    assert.equal(isCapsFlood('𝐖𝐇𝐘 𝐈𝐒 𝐄𝐕𝐄𝐑𝐘𝐎𝐍𝐄 𝐈𝐆𝐍𝐎𝐑𝐈𝐍𝐆 𝐌𝐄'), true);
});

test('English letters only: fonts, other alphabets, zalgo and invisible characters are refused', () => {
    assert.match(findForbiddenCharacters('𝓱𝓮𝓵𝓵𝓸 there'), /fancy font/);
    assert.match(findForbiddenCharacters('ⓗⓔⓛⓛⓞ'), /fancy font/);
    assert.match(findForbiddenCharacters('hеllo'), /look-alike/);
    assert.match(findForbiddenCharacters('Привет всем'), /outside the English alphabet/);
    assert.match(findForbiddenCharacters('café'), /outside the English alphabet/);
    assert.match(findForbiddenCharacters('h̵̢̛e̷͠l̴l̸o'), /zalgo/);
    assert.match(findForbiddenCharacters('he​llo'), /invisible/);
});

test('English letters only: emoji, emoticons, symbols, links and code are fine', () => {
    for (const text of [
        'hello there', 'I ❤️ cats 123!', '👨‍👩‍👧 family 1️⃣', '🇱🇹 flag', '¯\\_(ツ)_/¯', '( ͡° ͜ʖ ͡°)',
        '£10 or €10, 5°C, № 5, ™ ©', 'see https://example.com/café', 'run `print("héllo")`', '<:pog:123456789012345678>',
    ]) {
        assert.equal(findForbiddenCharacters(text), null, `should allow ${text}`);
    }
});

test('names: plain versions and impersonation through fonts', () => {
    assert.equal(plainName('𝓒𝓪𝓽 𝓛𝓸𝓿𝓮𝓻'), 'Cat Lover');
    assert.equal(plainName('Normal Name'), 'Normal Name');
    assert.equal(plainName('★彡'), null);
    assert.match(findImpersonation(['𝓡𝓪𝓶𝓪𝔃𝓲𝓷𝓪𝓼'], ['Ramazinas']), /imitates/);
});
