// Bot audit fixes (2026-11-08): access, tickets, leavers, giveaways, JTC privacy, counting race,
// birthdays, per-server member tools, cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Collection, PermissionFlagsBits } from 'discord.js';

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

// H1 ------------------------------------------------------------------------------------------
test('H1: everyone-commands carry no default member permissions', async () => {
  for (const p of ['commands/Fun/count.js', 'commands/Utility/todo.js', 'commands/Utility/firstmsg.js']) {
    const { default: cmd } = await import(`../src/${p}`);
    assert.equal(cmd.data.toJSON().default_member_permissions ?? null, null, p);
  }
  assert.doesNotMatch(src('commands/Fun/count.js'), /Manage Server/);
});

test('H1: the slash path does not re-enforce default member permissions', () => {
  assert.doesNotMatch(src('events/interactionCreate.js'), /enforceDefaultCommandPermissions/);
});

// H2 ------------------------------------------------------------------------------------------
test('H2: ticket channels give the bot its own overwrite', async () => {
  const { buildTicketPermissionOverwrites } = await import('../src/services/ticket.js');
  const ow = buildTicketPermissionOverwrites({ guildId: 'g', memberId: 'm', botId: 'b', staffRoleId: 'r' });
  const bot = ow.find((o) => o.id === 'b');
  for (const bit of ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'ManageChannels']) {
    assert.ok(bot.allow.includes(PermissionFlagsBits[bit]), bit);
  }
  assert.deepEqual(ow.find((o) => o.id === 'g').deny, [PermissionFlagsBits.ViewChannel]);
  assert.ok(ow.find((o) => o.id === 'r'));
  assert.equal(buildTicketPermissionOverwrites({ guildId: 'g', memberId: 'm' }).length, 2);
});

test('H2: a failed opening message deletes the channel and the ticket row', async () => {
  const { saveAndPostTicketOpening } = await import('../src/services/ticket.js');
  const calls = [];
  const channel = { id: 'c', send: async () => { throw new Error('Missing Access'); }, delete: async () => { calls.push('delete'); } };
  await assert.rejects(
    saveAndPostTicketOpening({ channel, save: async () => calls.push('save'), removeRow: async () => calls.push('removeRow'), payload: {} }),
    /Missing Access/,
  );
  assert.deepEqual(calls, ['save', 'removeRow', 'delete']);

  const ok = { id: 'c', send: async (p) => ({ sent: p }), delete: async () => { throw new Error('no'); } };
  const msg = await saveAndPostTicketOpening({ channel: ok, save: async () => {}, removeRow: async () => { throw new Error('no'); }, payload: { a: 1 } });
  assert.deepEqual(msg, { sent: { a: 1 } });
});

// H3 ------------------------------------------------------------------------------------------
test('H3: the client receives uncached leavers (GuildMember + User partials)', () => {
  assert.match(src('app.js'), /partials: \[Partials\.Channel, Partials\.Message, Partials\.Reaction, Partials\.GuildMember, Partials\.User\]/);
});

test('H3: a partial leaver (user, guild only) is described without crashing', async () => {
  const { describeLeaver } = await import('../src/events/guildMemberRemove.js');
  const partialUser = { id: '400000000000000001', tag: null, username: undefined, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png' };
  const partial = describeLeaver({ partial: true, joinedTimestamp: null, user: partialUser });
  assert.deepEqual(partial, { id: '400000000000000001', label: '400000000000000001', joined: 'unknown', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png' });
  const full = describeLeaver({ joinedTimestamp: 1_700_000_000_000, user: { id: '1', tag: 'mochi', displayAvatarURL: () => 'a' } });
  assert.equal(full.label, 'mochi');
  assert.equal(full.joined, '<t:1700000000:R>');
  assert.equal(describeLeaver({ user: { id: '2' } }).avatarUrl, null);
  // The old code fell back to "joined just now" for an unknown join time.
  assert.doesNotMatch(src('events/guildMemberRemove.js'), /joinedTimestamp \|\| Date\.now\(\)/);
});

test('H3: an old partial member logs no fake nickname change; a partial old user is skipped', () => {
  assert.match(src('events/guildMemberUpdate.js'), /!oldMember\.partial && oldMember\.nickname !== newMember\.nickname/);
  assert.match(src('events/userUpdate.js'), /if \(oldUser\.partial \|\| oldUser\.bot\) return;/);
});

// M1 ------------------------------------------------------------------------------------------
test('M1: the End / Reroll buttons go through the service (lock + announcement)', () => {
  const s = src('handlers/giveawayButtons.js');
  assert.match(s, /await endGiveawayNow\(client, interaction\.guildId, interaction\.message\.id, interaction\.user\.id\)/);
  assert.match(s, /await rerollGiveaway\(client, interaction\.guildId, interaction\.message\.id, interaction\.user\.id\)/);
  assert.doesNotMatch(s, /selectWinners/);
  // After the defer, a plain reply would throw (already acknowledged).
  assert.doesNotMatch(s, /await interaction\.reply\(\{\s*embeds: \[\s*successEmbed\(\s*'Giveaway (ended|rerolled)'/);
});

// M2 ------------------------------------------------------------------------------------------
function overwriteSource(entries) {
  const cache = new Map(entries.map(([id, type, allow, deny]) => [id, { id, type, allow: { bitfield: allow }, deny: { bitfield: deny } }]));
  return { permissionOverwrites: { cache } };
}

test('M2: temporary rooms copy the category overwrites, drop @everyone allows and add owner + bot', async () => {
  const { buildJoinToCreateOverwrites } = await import('../src/services/joinToCreateService.js');
  const F = PermissionFlagsBits;
  const category = overwriteSource([
    ['g', 0, F.ViewChannel | F.Connect, F.SendMessages], // an old trigger's "@everyone: View + Connect" + a deny
    ['staff', 0, F.ViewChannel | F.Connect, 0n],
    ['owner', 1, 0n, F.Connect],
  ]);
  const ow = buildJoinToCreateOverwrites(category, { guildId: 'g', ownerId: 'owner', botId: 'bot' });
  const by = Object.fromEntries(ow.map((o) => [o.id, o]));
  assert.equal(by.g.allow, 0n, 'no @everyone allows');
  assert.equal(by.g.deny, F.SendMessages, '@everyone denies kept');
  assert.equal(by.staff.allow, F.ViewChannel | F.Connect);
  assert.ok((by.owner.allow & F.Connect) && !(by.owner.deny & F.Connect), 'owner on top of a copied deny');
  for (const bit of [F.ViewChannel, F.Connect, F.MoveMembers, F.ManageChannels]) assert.ok(by.bot.allow & bit);
  // Bits the bot lacks are not copied (Discord would refuse the whole channel).
  const masked = buildJoinToCreateOverwrites(category, { guildId: 'g', botPermissions: F.ViewChannel | F.SendMessages });
  assert.equal(masked.find((o) => o.id === 'staff').allow, F.ViewChannel);
  assert.equal(masked.find((o) => o.id === 'owner'), undefined, 'an entry left with nothing is dropped');
  const admin = buildJoinToCreateOverwrites(category, { guildId: 'g', botPermissions: F.Administrator });
  assert.equal(admin.find((o) => o.id === 'staff').allow, F.ViewChannel | F.Connect);
  // No source (no category): only the bot (and owner).
  assert.deepEqual(buildJoinToCreateOverwrites(null, { guildId: 'g', botId: 'bot' }).map((o) => o.id), ['bot']);
  // Neither the trigger setup nor the room hands out an @everyone allow any more.
  assert.doesNotMatch(src('services/joinToCreateService.js'), /id: guild\.id, allow:/);
  assert.doesNotMatch(src('events/voiceStateUpdate.js'), /id: guild\.id,\s*allow:/);
});

// M3 ------------------------------------------------------------------------------------------
function kvStore() {
  const data = new Map();
  let chain = Promise.resolve();
  return {
    data,
    async get(key, fallback = null) { return data.has(key) ? structuredClone(data.get(key)) : fallback; },
    async set(key, value) { data.set(key, structuredClone(value)); return true; },
    async delete(key) { return data.delete(key); },
    // Serialized like the row lock of the real store.
    update(key, mutator, defaultValue = null) {
      const run = chain.then(async () => {
        const current = data.has(key) ? structuredClone(data.get(key)) : structuredClone(defaultValue);
        const next = await mutator(current);
        data.set(key, structuredClone(next));
        return next;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

test('M3: two quick messages are judged on the locked state, so only one counts', async () => {
  const { activateCountingGame, processCountingMessage, getCountingGameConfig } = await import('../src/services/countingGameService.js');
  const client = { db: kvStore() };
  const guildId = '920000000000000001';
  await activateCountingGame(client, guildId, 'chan', 'decimal');
  await getCountingGameConfig(client, guildId); // warm the cache with nextNumber 1

  const [a, b] = await Promise.all([
    processCountingMessage(client, guildId, { channelId: 'chan', userId: 'u1', content: '1' }),
    processCountingMessage(client, guildId, { channelId: 'chan', userId: 'u2', content: '1' }),
  ]);
  assert.deepEqual([a, b], ['counted', 'broken'], 'the second "1" breaks the count instead of being kept');
  const after = await getCountingGameConfig(client, guildId);
  assert.equal(after.nextNumber, 1, 'reset by the break; the cache shows the saved state');
  assert.equal(after.leaderboard.u1, 1);

  assert.equal(await processCountingMessage(client, guildId, { channelId: 'other', userId: 'u1', content: '1' }), 'ignored');
  assert.equal(await processCountingMessage(client, guildId, { channelId: 'chan', userId: 'u1', content: '1' }), 'counted');
  assert.equal(await processCountingMessage(client, guildId, { channelId: 'chan', userId: 'u1', content: '2' }), 'broken', 'same person twice');
  assert.match(src('events/messageCreate.js'), /processCountingMessage\(client, message\.guild\.id/);
  assert.doesNotMatch(src('events/messageCreate.js'), /resetCountingGame|recordCorrectCount/);
});

// M4 ------------------------------------------------------------------------------------------
test('M4: birthday read commands never delete, fetch members in batches of 100 and fit the embed', async () => {
  const { filterPresentBirthdays, fitLines } = await import('../src/services/birthdayService.js');
  for (const p of ['commands/Birthday/modules/next_birthdays.js', 'commands/Birthday/modules/birthday_list.js']) {
    assert.doesNotMatch(src(p), /deleteBirthday/, p);
  }
  const birthdays = Array.from({ length: 250 }, (_, i) => ({ userId: String(1000 + i) }));
  const calls = [];
  const guild = {
    members: {
      fetch: async ({ user }) => {
        calls.push(user.length);
        if (calls.length === 2) throw new Error('timeout'); // the second batch can't be checked
        return new Map(user.filter((id) => Number(id) % 2 === 0).map((id) => [id, { id }]));
      },
    },
  };
  const { present, members } = await filterPresentBirthdays(guild, birthdays);
  assert.deepEqual(calls, [100, 100, 50]);
  // Batch 1 and 3: even ids only; batch 2 (unknown) kept whole.
  assert.equal(present.length, 50 + 100 + 25);
  assert.equal(members.size, 75);

  const lines = Array.from({ length: 500 }, (_, i) => `${i + 1}. <@${'1'.repeat(18)}> - January 1`);
  const { text, shown } = fitLines(lines, { maxLength: 3800 });
  assert.ok(text.length <= 4096, `fits: ${text.length}`);
  assert.ok(shown < 500);
  assert.match(text, new RegExp(`…and ${500 - shown} more$`));
  assert.deepEqual(fitLines(['a', 'b']), { text: 'a\nb', shown: 2 });
});

// M5 ------------------------------------------------------------------------------------------
test('M5: temp roles, role rules and join/leave insights run in every server; premium stays main-only', () => {
  const add = src('events/guildMemberAdd.js');
  const mainBlocks = [...add.matchAll(/if \(guild\.id === enforcementConfig\.mainGuildId\) \{([\s\S]*?)\n            \}/g)].map((m) => m[1]);
  assert.equal(mainBlocks.length, 1);
  assert.match(mainBlocks[0], /syncPremiumRole/);
  assert.doesNotMatch(mainBlocks[0], /recordMemberEvent|reapplyTempRolesOnJoin|applyRoleRulesToMember/);
  for (const call of ['recordMemberEvent(guild.id, member.id, \'join\')', 'reapplyTempRolesOnJoin(member)', 'applyRoleRulesToMember(member)']) {
    assert.ok(add.includes(call), call);
  }
  const remove = src('events/guildMemberRemove.js');
  assert.doesNotMatch(remove, /mainGuildId/);
  assert.ok(remove.includes("recordMemberEvent(guild.id, user.id, 'leave')"));
});

// M6 ------------------------------------------------------------------------------------------
test('M6: no starboard repost from a channel @everyone cannot see into one it can', async () => {
  const { exposesPrivateChannel } = await import('../src/services/community/starboardService.js');
  const channel = (everyoneViews) => ({ permissionsFor: () => ({ has: (bit) => bit === PermissionFlagsBits.ViewChannel && everyoneViews }) });
  assert.equal(exposesPrivateChannel(channel(false), channel(true), 'everyone'), true);
  assert.equal(exposesPrivateChannel(channel(true), channel(true), 'everyone'), false);
  assert.equal(exposesPrivateChannel(channel(false), channel(false), 'everyone'), false, 'a private starboard may show private posts');
  assert.equal(exposesPrivateChannel({ permissionsFor: () => { throw new Error('x'); } }, channel(true), 'everyone'), true, 'unknown counts as private');
});

// M7 ------------------------------------------------------------------------------------------
test('M7: join/leave renames counters at most once per server per 5 minutes, without blocking', async () => {
  const { refreshCountersOnMemberChange, _resetMemberChangeRefresh, MEMBER_CHANGE_RENAME_INTERVAL_MS } = await import('../src/services/serverstatsService.js');
  _resetMemberChangeRefresh();
  const renamed = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = {
    getServerCounters: async () => { await gate; return [{ type: 'members', channelId: 'c1' }, { type: 'bots', channelId: 'c2', enabled: false }]; },
    updateCounter: async (client, guild, counter) => { renamed.push(counter.channelId); return true; },
  };
  const guild = { id: '930000000000000001', memberCount: 10, members: { cache: new Collection() } };
  const t0 = 1_000_000;
  assert.equal(refreshCountersOnMemberChange({}, guild, { now: t0, deps }), true, 'returns at once (the load is still pending)');
  assert.equal(refreshCountersOnMemberChange({}, guild, { now: t0 + 1000, deps }), false, 'debounced');
  release();
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renamed, ['c1'], 'disabled counters skipped');
  assert.equal(refreshCountersOnMemberChange({}, guild, { now: t0 + MEMBER_CHANGE_RENAME_INTERVAL_MS, deps }), true, 'allowed again after 5 minutes');
  assert.equal(refreshCountersOnMemberChange({}, { id: '930000000000000002' }, { now: t0, deps }), true, 'per server');
  for (const p of ['events/guildMemberAdd.js', 'events/guildMemberRemove.js']) {
    assert.match(src(p), /\n {8}refreshCountersOnMemberChange\(member\.client, guild\);/, p);
    assert.doesNotMatch(src(p), /await updateCounter\(/, p);
  }
});

// L1 ------------------------------------------------------------------------------------------
test('L1: appeal forms and decision buttons always answer after deferring', () => {
  const s = src('handlers/appealsHandler.js');
  assert.match(s, /This form is not available here any more/);
  assert.doesNotMatch(s, /if \(!DECISIONS\.has\(decision\) \|\| !caseCode\) return;/);
});

// L3 ------------------------------------------------------------------------------------------
test('L3: /help caches the registered command ids; voice updates without a channel change return early', async () => {
  const { getRegisteredCommands, _resetCommandIdCache, COMMAND_ID_CACHE_TTL_MS } = await import('../src/handlers/help/helpSelectMenus.js');
  _resetCommandIdCache();
  let fetches = 0;
  let fail = true;
  const client = { application: { commands: { fetch: async () => {
    fetches += 1;
    if (fail) throw new Error('down');
    return new Map([['1', { id: '1', name: 'help' }]]);
  } } } };
  assert.equal((await getRegisteredCommands(client, { now: 0 })).size, 0, 'a failed fetch gives plain names');
  fail = false;
  assert.equal((await getRegisteredCommands(client, { now: 1 })).get('help').id, '1', 'a failure is not cached');
  await getRegisteredCommands(client, { now: 2 });
  assert.equal(fetches, 2);
  await getRegisteredCommands(client, { now: 1 + COMMAND_ID_CACHE_TTL_MS });
  assert.equal(fetches, 3);

  const { default: voice } = await import('../src/events/voiceStateUpdate.js');
  const voiceState = () => ({ channelId: 'v1', get guild() { throw new Error('should not be read'); }, member: { user: { bot: false } } });
  await voice.execute(voiceState(), voiceState(), {});
});

// L4 ------------------------------------------------------------------------------------------
test('L4: application answers match the questions or the form is refused', async () => {
  const { collectApplicationAnswers } = await import('../src/commands/Community/apply.js');
  const fields = (values) => ({ getTextInputValue: (id) => { if (!(id in values)) throw new Error('not found'); return values[id]; } });
  const questions = [{ question: 'Why?', minLength: 1 }, { question: 'Age?' }];
  assert.deepEqual(collectApplicationAnswers(fields({ q0: 'a', q1: '' }), questions), [
    { question: 'Why?', answer: 'a', minLength: 1 }, { question: 'Age?', answer: '', minLength: undefined },
  ]);
  assert.equal(collectApplicationAnswers(fields({ q0: 'a' }), questions), null, 'a question was added');
  assert.equal(collectApplicationAnswers(fields({ q0: 'a', q1: 'b', q2: 'c' }), questions), null, 'a question was removed');
  const s = src('commands/Community/apply.js');
  assert.ok(s.indexOf("postedToStaff ? 'Application sent'") > s.indexOf('postedToStaff = true'), 'the reply comes after the staff post');
});

// L6 ------------------------------------------------------------------------------------------
test('L6: dispatcher and panel refusals come from the bot catalog (English unchanged)', async () => {
  const { botText } = await import('../src/utils/botText.js');
  const en = botText('en');
  assert.equal(en.t('errors.dispatch.unknownCommand'), 'Sorry, that command does not exist.');
  assert.equal(en.t('errors.dispatch.cooldown', { time: '5s' }), 'This command is on cooldown. Please wait 5s before trying again.');
  assert.equal(en.t('errors.dispatch.disabledHere'), 'This command has been disabled for this server.');
  assert.equal(en.t('errors.panel.otherModerator'), 'This panel belongs to another moderator. Run /enforcements yourself.');
  assert.match(botText('de').t('errors.dispatch.cooldown', { time: '5s' }), /5s/);
  assert.notEqual(botText('ru').t('errors.panel.noAdmin'), en.t('errors.panel.noAdmin'));
  for (const p of ['events/interactionCreate.js', 'handlers/enforcementPanel.js']) {
    assert.doesNotMatch(src(p), /'Sorry, that command does not exist\.'|This panel belongs to another moderator|This command has been disabled for this server/, p);
  }
});

// L7 / L8 -------------------------------------------------------------------------------------
test('L7: premium rate-limit stores are bounded; L8: the Google query is not logged', async () => {
  const { _rateLimitStores } = await import('../src/commands/Core/premium.js');
  const { BoundedMap } = await import('../src/utils/boundedMap.js');
  assert.ok(_rateLimitStores.tries instanceof BoundedMap);
  assert.ok(_rateLimitStores.gifts instanceof BoundedMap);
  const google = src('commands/Search/modules/search_google.js');
  assert.doesNotMatch(google, /logger\.info/);
  assert.doesNotMatch(google, /query: query/);
});

// UX ------------------------------------------------------------------------------------------
test('UX: in-command re-checks match the Administrator gate and say so', async () => {
  const { hasAdminAccess } = await import('../src/utils/commandGate.js');
  const perms = (bits) => ({ has: (bit) => bits.includes(bit) });
  const guild = { id: '940000000000000001', ownerId: 'owner' };
  const call = (userId, bits) => ({ user: { id: userId }, guildId: guild.id, guild, memberPermissions: perms(bits) });
  assert.equal(hasAdminAccess(call('a', [PermissionFlagsBits.Administrator])), true);
  assert.equal(hasAdminAccess(call('m', [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels])), false, 'Manage Server is not enough');
  assert.equal(hasAdminAccess(call('owner', [])), true, 'the server owner');
  for (const p of [
    'commands/Birthday/modules/birthday_setchannel.js', 'commands/Logging/modules/logging_channel.js', 'commands/Logging/modules/logging_ignore.js',
    'commands/Logging/modules/logging_dashboard.js', 'commands/Utility/modules/report_setchannel.js', 'commands/ServerStats/modules/serverstats_create.js',
    'commands/ServerStats/modules/serverstats_delete.js', 'commands/ServerStats/modules/serverstats_list.js', 'commands/ServerStats/modules/serverstats_update.js',
    'commands/JoinToCreate/jointocreate.js', 'commands/Birthday/birthday.js', 'commands/Utility/report.js',
  ]) {
    assert.doesNotMatch(src(p), /Manage Server|Manage Channels/, p);
  }
  assert.doesNotMatch(src('commands/Enforcement/setappeal.js'), /main-server panel|only works in the main server/);
  assert.doesNotMatch(src('commands/Utility/wipedata.js'), /balance, AFK/);
  assert.doesNotMatch(src('handlers/wipedataButtons.js'), /balance, AFK/);
});

// Cleanup -------------------------------------------------------------------------------------
test('cleanup: dead code is gone', async () => {
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(new URL('../src/commands/JoinToCreate/modules/setup.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/commands/JoinToCreate/modules/config_setup.js', import.meta.url)), false);
  const jtc = await import('../src/services/joinToCreateService.js');
  assert.equal(jtc.createTemporaryChannel, undefined);
  assert.equal(jtc.hasManageGuildPermission, undefined);
  const moderation = await import('../src/utils/moderation.js');
  for (const name of ['generateCaseId', 'storeModerationCase', 'getModerationCases', 'logModerationAction']) assert.equal(moderation[name], undefined, name);
  assert.equal(typeof moderation.logEvent, 'function');
  assert.doesNotMatch(src('utils/database.js'), /function generateCaseId/);
  const guard = await import('../src/utils/permissionGuard.js');
  assert.equal(guard.isModerator, undefined);
  const { default: ConfigService } = await import('../src/services/config/configService.js');
  assert.equal(ConfigService.verifyPermission, undefined);
  assert.doesNotMatch(src('events/interactionCreate.js'), /reactroles/);
  assert.doesNotMatch(src('commands/JoinToCreate/jointocreate.js'), /Music Room/);
});
