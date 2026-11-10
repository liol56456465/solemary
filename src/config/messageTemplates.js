// messageTemplates.js — ready-made announcement texts for the dashboard Messages page
// ("Start from a template") and the /embedbuilder template picker. Choosing one only fills
// the form (box title, box text, box colour); the admin edits it and posts it. Nothing is
// posted from here; typed text never pings (botMessageService.js allowedMentions), only the
// role / everyone the admin picks on the Messages page. Templates only Mewvo's own servers get
// live in config/mewvoTemplates.js (messageTemplate / templatesByGroup with { home: true }).
//
// Each template: { id, group, name (picker label), title (box title), text (box text),
// colour (a key of EMBED_COLOURS in botMessageService.js), celebrate? }.
// {server} is replaced with the server's name when the template is chosen. Parts in
// [square brackets] are for the admin to fill in before posting.
//
// Voice (checked by tests/messageTemplates.test.js): plain, short sentences, like a
// moderator typing. No marketing words, no emoji strings, no em dashes, at most one
// emoji, and an exclamation mark only in a celebratory template (celebrate: true), at most one.
//
// The appeal texts follow the real flow: case code from the DM, the Appeal button on the
// panel (/setappeal), one pending appeal per case, a wait after a denial (appealCooldownMs,
// 7 days by default), bans and mutes appealable while they last, warnings and kicks within
// the appeal window (appealWindowMs, 30 days by default). A server that changes those
// settings on the Enforcement page should edit the numbers before posting.

import { MEWVO_TEMPLATES, MEWVO_TEMPLATE_GROUP } from './mewvoTemplates.js';

export const MESSAGE_TEMPLATE_GROUPS = Object.freeze([
    { key: 'support', label: 'Support server' },
    { key: 'news', label: 'Server news' },
    { key: 'reminders', label: 'Welcome and rule reminders' },
    { key: 'events', label: 'Events and giveaways' },
    { key: 'voice', label: 'Voice events and game nights' },
    { key: 'downtime', label: 'Maintenance and downtime' },
    { key: 'milestones', label: 'Server milestones' },
    { key: 'partners', label: 'Partnerships' },
    { key: 'polls', label: 'Polls and feedback' },
    { key: 'holidays', label: 'Holiday greetings' },
    { key: 'community', label: 'Community' },
    { key: 'staff', label: 'Staff' },
    { key: 'safety', label: 'Safety and scams' },
]);

const T = (id, group, name, title, text, colour = 'primary', extra = {}) => Object.freeze({ id, group, name, title, text, colour, ...extra });

export const MESSAGE_TEMPLATES = Object.freeze([
    // ── Support server ────────────────────────────────────────────────────
    T('appeal-overview', 'support', 'How to appeal (all punishments)', 'How to appeal', [
        'If you were banned, kicked, muted or warned in {server} and you think it was wrong, you can appeal.',
        '',
        '**1. Find your case code**',
        'It is in the DM Mewvo sent you when it happened. It looks like `k7m2qx`. Lost the DM? Ask staff and we will look it up.',
        '',
        '**2. Press Appeal**',
        'Use the Appeal button on the panel in #appeals.',
        '',
        '**3. Fill in the form**',
        'Say why it should be lifted and add your case code. Be honest about what happened. Staff can see the logs, and an appeal that owns up to a mistake goes a lot further than one that denies it.',
        '',
        '**What happens next**',
        'For a ban or kick, a private channel opens here where you can talk to staff. For a mute or warning, staff review it on their side. Either way you get the decision by DM. Most appeals get an answer within a few days.',
        '',
        '**Good to know**',
        '- One appeal per case at a time.',
        '- If an appeal is denied, you can try again after 7 days.',
        '- Bans and mutes can be appealed while they last. Warnings and kicks within 30 days.',
        '- Some cases cannot be appealed. Your DM says so when that is the case.',
        '- Press My appeals on the panel to see where yours stands.',
    ].join('\n'), 'primary'),
    T('appeal-ban', 'support', 'How to appeal a ban', 'Appealing a ban', [
        'Banned from {server}? You can appeal from this server.',
        '',
        '1. Get your case code from the ban DM Mewvo sent you.',
        '2. Press Appeal on the panel in #appeals.',
        '3. Explain why the ban should be lifted and paste the case code.',
        '',
        'A private channel opens where you and staff can talk about it. Answer their questions there. You get the decision by DM.',
        '',
        'If the appeal is accepted, the ban is lifted and you get a one-time invite back to the server by DM. It works for 7 days.',
        '',
        'You can only have one open appeal per ban. If it is denied, you can appeal again after 7 days. Some bans cannot be appealed at all, or only until a set date. The ban DM tells you if that applies to yours.',
    ].join('\n'), 'red'),
    T('appeal-kick', 'support', 'How to appeal a kick', 'Appealing a kick', [
        'A kick is not a ban. You can join {server} again with the invite in your kick DM.',
        '',
        'If you still think the kick was wrong and want it off your record, you can appeal it within 30 days:',
        '1. Press Appeal on the panel in #appeals.',
        '2. Paste the case code from the kick DM.',
        '3. Explain what happened.',
        '',
        'A private channel opens where staff can ask you about it. You get the decision by DM.',
    ].join('\n'), 'yellow'),
    T('appeal-mute', 'support', 'How to appeal a mute', 'Appealing a mute', [
        'Muted in {server}? You can appeal while the mute is still running.',
        '',
        '1. Press Appeal on the appeal panel, here or in the main server.',
        '2. Paste the case code from the mute DM.',
        '3. Say why the mute should be lifted.',
        '',
        'Staff look at the case and the messages behind it. You get the decision by DM. If it is accepted, the mute is removed straight away.',
    ].join('\n'), 'yellow'),
    T('appeal-warn', 'support', 'How to appeal a warning', 'Appealing a warning', [
        'You can appeal a warning within 30 days of getting it.',
        '',
        '1. Press Appeal on the appeal panel.',
        '2. Paste the case code from the warning DM.',
        '3. Say why the warning should be removed.',
        '',
        'If the appeal is accepted, the warning is removed and no longer counts toward a ban. Press My record on the panel to see how many warnings you have right now.',
    ].join('\n'), 'yellow'),
    T('appeal-honest', 'support', 'Tips for a good appeal', 'Before you appeal', [
        'A few things that help your appeal:',
        '',
        '- Read the reason in your DM first, and check the rule it points to.',
        '- Tell us what happened in your own words.',
        '- If you did break the rule, say so. Saying sorry and explaining what you will do differently works better than arguing.',
        '- If you think staff got it wrong, say why and add links to the messages if you have them.',
        '- Keep it calm. Insulting staff in an appeal gets it denied.',
        '',
        'Asking for an update in other channels does not speed it up. Press My appeals on the panel to see where yours stands.',
    ].join('\n'), 'primary'),
    T('appeal-status', 'support', 'We read every appeal', 'About your appeals', [
        'We read every appeal, including the long ones.',
        '',
        'Right now it takes about [number] days to get an answer. You get a DM as soon as there is a decision.',
        '',
        'Please do not send a second appeal for the same case or ping staff about it. Press My appeals on the appeal panel to check where yours stands.',
    ].join('\n'), 'grey'),
    T('appeals-paused', 'support', 'Appeals paused for now', 'Appeals are paused', [
        'We are not taking new appeals until [date].',
        '',
        'Reason: [short reason, for example staff are busy with a raid clean-up].',
        '',
        'Appeals that were already sent are still open and will be answered. Nothing is lost. When appeals open again we will post it here.',
    ].join('\n'), 'yellow'),
    T('banned-role', 'support', 'Why you only see a few channels', 'Why can I only see a few channels?', [
        'If you are banned from {server}, you get the Banned role here. With it you can only see the appeal channels.',
        '',
        'The role is removed by itself when your ban ends or is lifted.',
        '',
        'To appeal, press Appeal on the panel in #appeals.',
    ].join('\n'), 'grey'),
    T('ticket-howto', 'support', 'How to open a ticket', 'Need help from staff?', [
        'Press the button on the ticket panel in #[ticket channel] to open a ticket.',
        '',
        'A private channel opens that only you and staff can see. Say what you need in your first message so we can help faster.',
        '',
        'Use a ticket for things like:',
        '- questions about the rules',
        '- problems with roles or channels',
        '- reporting something you do not want to post in public',
        '',
        'One topic per ticket. Staff close it when it is sorted.',
    ].join('\n'), 'blurple'),
    T('modmail-howto', 'support', 'How modmail works', 'Message the staff team', [
        'You can talk to staff in private by sending Mewvo a DM.',
        '',
        '1. Send your message to Mewvo in DMs.',
        '2. Press Send to staff.',
        '3. Staff reply in the same DM.',
        '',
        'Everything you send after that goes to staff until they close the conversation. Only staff can see it.',
        '',
        'You need to be in {server} for this to work.',
    ].join('\n'), 'blurple'),
    T('staff-reports', 'support', 'Reporting a staff member', 'Reporting a staff member', [
        'If a staff member broke the rules or treated you unfairly, you can report them.',
        '',
        'Press Report staff on the appeal panel in #appeals. Give their username, what happened, and links to the messages if you have them.',
        '',
        'Only administrators see reports. The staff member you report does not.',
        '',
        'You can have one open report at a time and send up to three a day. Reports made up to get back at someone are treated as a rule break.',
    ].join('\n'), 'red'),
    T('support-hours', 'support', 'Support hours', 'When staff are around', [
        'Staff are usually online:',
        '- Weekdays: [time] to [time] ([time zone])',
        '- Weekends: [time] to [time] ([time zone])',
        '',
        'You can open a ticket or send an appeal at any time. Outside these hours it may take longer to get an answer.',
        '',
        'If something is urgent, like a raid or someone in danger, ping @[role].',
    ].join('\n'), 'grey'),
    T('support-welcome', 'support', 'Welcome to the support server', 'Welcome to {server}', [
        'This server is for help with appeals, reports and questions.',
        '',
        '- To appeal a punishment, go to #appeals.',
        '- To report a staff member, use Report staff on the same panel.',
        '- For anything else, ask in #[help channel].',
        '',
        'Keep it civil. The rules of the main server apply here too.',
    ].join('\n'), 'primary'),

    // ── Server news ───────────────────────────────────────────────────────
    T('rules-updated', 'news', 'Rules updated', 'The rules have changed', [
        'We updated the rules in #[rules channel].',
        '',
        'What changed:',
        '- [change]',
        '- [change]',
        '',
        'The new rules apply from now on. Take a minute to read them. If something is unclear, open a ticket and ask.',
    ].join('\n'), 'blurple'),
    T('changelog', 'news', 'Server update / changelog', 'Server update', [
        'A few changes to {server}:',
        '',
        '**New**',
        '- [what was added]',
        '',
        '**Changed**',
        '- [what changed]',
        '',
        '**Removed**',
        '- [what was removed]',
        '',
        'Questions or feedback go in #[feedback channel].',
    ].join('\n'), 'primary'),
    T('maintenance', 'news', 'Planned maintenance', 'Planned maintenance', [
        'We are doing some work on the server on [date] from [time] to [time] ([time zone]).',
        '',
        'During that time [what will not work, for example some channels will be locked].',
        '',
        'Nothing you need to do. We will post here when it is done.',
    ].join('\n'), 'yellow'),
    T('maintenance-done', 'news', 'Maintenance finished', 'Maintenance is done', [
        'Everything should be back to normal.',
        '',
        'If something still looks broken, tell us in #[help channel] or open a ticket.',
    ].join('\n'), 'green'),
    T('bot-outage', 'news', 'Bot outage', 'Mewvo is having problems', [
        'Mewvo is not working properly right now. Commands may not respond and levels may not count.',
        '',
        'We know about it and are working on it. You do not need to report it.',
        '',
        'Anything that needs staff in the meantime: ping @[role].',
    ].join('\n'), 'red'),
    T('new-channel', 'news', 'New channel', 'New channel: #[channel]', [
        'We added #[channel] for [what it is for].',
        '',
        'Keep it on topic. The normal rules apply there too.',
    ].join('\n'), 'primary'),
    T('channel-cleanup', 'news', 'Inactive channel cleanup', 'Channel cleanup', [
        'Some channels have been quiet for a long time, so we are cleaning up.',
        '',
        'On [date] we will remove or archive:',
        '- #[channel]',
        '- #[channel]',
        '',
        'If you want to keep one of them, say so in #[feedback channel] before then.',
    ].join('\n'), 'grey'),
    T('partnership', 'news', 'New partnership', 'New partner: [server name]', [
        '{server} is now partnered with [server name].',
        '',
        '[One or two sentences about what they are.]',
        '',
        'You can join them here: [invite link]',
        '',
        'Partner posts go in #[partners channel] only. Advertising in other channels is still not allowed.',
    ].join('\n'), 'purple'),
    T('milestone', 'news', 'Member milestone', 'We hit [number] members', [
        '{server} just passed [number] members. Thanks to everyone who chats here and invites their friends.',
        '',
        '[Optional: what we are doing to mark it, like a giveaway or an event.]',
    ].join('\n'), 'green', { celebrate: true }),
    T('holiday', 'news', 'Holiday greeting', 'Happy [holiday]', [
        'Happy [holiday] from the {server} staff team.',
        '',
        'Staff may be slower to answer over the next few days. Tickets and appeals stay open and will be answered.',
    ].join('\n'), 'purple', { celebrate: true }),
    T('weekly-reminder', 'news', 'Weekly reminder', 'Weekly reminder', [
        'A few things to keep in mind:',
        '',
        '- Read the rules in #[rules channel] if you have not yet.',
        '- Use the right channel for the topic.',
        '- Report problems with a ticket instead of arguing in chat.',
        '- Staff will never DM you first asking for your password or a code.',
        '',
        'Have a good week.',
    ].join('\n'), 'grey'),

    // ── Events and giveaways ──────────────────────────────────────────────
    T('event-announce', 'events', 'Event announcement', '[Event name]', [
        '**When:** [date], [time] ([time zone])',
        '**Where:** #[channel or voice channel]',
        '',
        '[What the event is, in one or two sentences.]',
        '',
        'React or press Interested on the Discord event if you plan to come, so we know how many people to expect.',
    ].join('\n'), 'purple'),
    T('event-reminder', 'events', 'Event reminder', '[Event name] starts soon', [
        '[Event name] starts in [time] in #[channel].',
        '',
        'If you said you would come, now is a good time to get ready.',
    ].join('\n'), 'purple'),
    T('event-start', 'events', 'Event starting now', '[Event name] is starting', [
        '[Event name] is starting now in #[channel]. Come join.',
        '',
        'The usual rules apply in the event channels too.',
    ].join('\n'), 'purple'),
    T('event-cancelled', 'events', 'Event cancelled or moved', '[Event name] is moved', [
        '[Event name] will not happen on [date] as planned.',
        '',
        'New date: [new date, or "we will post a new date soon"].',
        '',
        'Sorry for the change.',
    ].join('\n'), 'yellow'),
    T('giveaway-winner', 'events', 'Giveaway winner', 'Giveaway winner', [
        'The giveaway for **[prize]** is over. Congratulations to [winner].',
        '',
        'Winner: message [host] within 48 hours to claim your prize, or we pick someone else.',
        '',
        'Thanks to everyone who entered.',
    ].join('\n'), 'green', { celebrate: true }),
    T('giveaway-rules', 'events', 'Giveaway rules', 'How our giveaways work', [
        '- Press the Join button on the giveaway to enter.',
        '- Winners are picked at random when it ends.',
        '- Winners have 48 hours to message the host, or we reroll.',
        '- Alt accounts are not allowed. Entering with one gets all your accounts removed from the giveaway.',
        '- Staff will never ask you to pay or log in somewhere to claim a prize.',
    ].join('\n'), 'green'),
    T('poll-results', 'events', 'Poll results', 'Poll results: [question]', [
        'Thanks for voting. Here is how it went:',
        '',
        '- [option]: [number] votes',
        '- [option]: [number] votes',
        '',
        'So we are going with **[result]**. [What happens next.]',
    ].join('\n'), 'blurple'),

    // ── Community ─────────────────────────────────────────────────────────
    T('roles-menu', 'community', 'Pick your roles', 'Pick your roles', [
        'Go to #[roles channel] and pick the roles you want.',
        '',
        '- **Ping roles** decide which announcements notify you.',
        '- **Interest roles** open the channels for those topics.',
        '',
        'You can change them any time by picking again.',
    ].join('\n'), 'blurple'),
    T('new-role', 'community', 'New role', 'New role: [role name]', [
        'There is a new role, **[role name]**.',
        '',
        '[What it is for and how to get it.]',
    ].join('\n'), 'blurple'),
    T('introduce-yourself', 'community', 'Introduce yourself', 'Introduce yourself', [
        'New here? Say hi in #[intro channel].',
        '',
        'Some ideas for what to write:',
        '- what you like to be called',
        '- how you found {server}',
        '- what games, shows or hobbies you are into',
        '',
        'Do not share personal details like your address, school or phone number.',
    ].join('\n'), 'primary'),
    T('level-rewards', 'community', 'Level rewards explained', 'Levels and rewards', [
        'You get XP for chatting. Spamming to level up does not work and can get you muted.',
        '',
        'Use `/rank` to see your level and `/leaderboard` to see the top members.',
        '',
        'Rewards:',
        '- Level [number]: [role]',
        '- Level [number]: [role]',
        '- Level [number]: [role]',
    ].join('\n'), 'green'),
    T('boost-thanks', 'community', 'Thanks for boosting', 'Thanks to our boosters', [
        'Thanks to everyone boosting {server}. The boosts pay for [what they unlock, like better sound quality and more emoji slots].',
        '',
        'Boosters get [perk, for example a colour role and access to #[channel]].',
    ].join('\n'), 'purple'),
    T('mewvo-features', 'community', 'What members can do with Mewvo', 'Mewvo commands you can use', [
        'Mewvo is the bot that runs moderation and levels here. A few things you can use yourself:',
        '',
        '- `/rank`: your level and XP',
        '- `/leaderboard`: the most active members',
        '- `/appeal status`: where your appeals stand',
        '- `/report file`: report a member to staff in private',
        '- DM Mewvo: talk to staff in private (modmail)',
        '',
        'On the website, My record shows your own warnings, cases and appeals: [website link]/me',
    ].join('\n'), 'primary'),
    T('quiet-hours', 'community', 'Keep chat friendly', 'Keep chat friendly', [
        'Chat has been getting heated lately.',
        '',
        'Disagreeing is fine. Insults, baiting and pile-ons are not. If someone annoys you, block them or open a ticket instead of fighting in public.',
        '',
        'Staff will hand out mutes from here on when it keeps going.',
    ].join('\n'), 'yellow'),

    // ── Staff ─────────────────────────────────────────────────────────────
    // Staff rules (owner, 2026-11-10): posted in a staff-only channel. The usual consequence is a
    // demotion (staff role removed); abuse of moderation powers can also mean a ban.
    T('staff-rules-mods', 'staff', 'Staff rules: moderators', 'Rules for moderators', [
        'These apply to everyone with a moderator role, on top of the server rules.',
        '',
        '**1. Follow the server rules first.** Staff are held to a higher standard, not a lower one.',
        '**2. Use the right punishment.** Follow the listed consequence for the rule. Not sure? Ask in staff chat before you act.',
        '**3. Always give a reason.** Every warn, mute, kick and ban needs a real reason and evidence if there is any.',
        '**4. No personal grudges.** Do not punish someone you are arguing with. Let another moderator handle it.',
        '**5. Keep staff matters private.** Do not share cases, reports, appeals or staff chat outside the staff channels.',
        '**6. Stay calm in public.** Disagree with another staff member in staff chat, not in front of members.',
        '**7. Do not abuse bot or role powers.** No pranks, no fake punishments, no giving roles to friends.',
        '**8. Tell us when you are away.** Going inactive for more than [time]? Post it in #[staff channel].',
        '',
        '**Consequences**',
        '- Small mistakes: a talk with an admin',
        '- Repeated or careless mistakes: demotion',
        '- Abusing moderation powers, leaking staff info or raiding: demotion and a ban',
    ].join('\n'), 'blurple'),
    T('staff-rules-admins', 'staff', 'Staff rules: administrators', 'Rules for administrators', [
        'These apply to everyone with Administrator, on top of the moderator rules.',
        '',
        '**1. Changes go through staff chat.** Do not change channels, roles, bots or server settings without telling the other admins.',
        '**2. Never hand out staff permissions alone.** New moderators and admins are agreed on by [who decides].',
        '**3. Protect the server.** Never add untrusted bots, never share bot tokens, logins or the dashboard with anyone.',
        '**4. Review, do not overrule quietly.** Undoing another moderator\'s action needs a note in the case and a message to them.',
        '**5. Appeals and staff reports are handled fairly.** Do not decide an appeal or report about yourself or a friend.',
        '**6. Mass actions need a reason.** Mass bans, purges and lockdowns are for raids and emergencies only.',
        '',
        '**Consequences**',
        '- Mistakes: a talk with the owner',
        '- Ignoring these rules: demotion to moderator or removal from staff',
        '- Abusing Administrator, nuking or helping a raid: removal from staff and a permanent ban',
    ].join('\n'), 'red'),
    T('staff-apps-open', 'staff', 'Staff applications open', 'Staff applications are open', [
        'We are looking for [number] new moderators.',
        '',
        'You should:',
        '- have been active here for at least [time]',
        '- have no recent warnings',
        '- be online at least a few hours a week',
        '',
        'Apply with `/apply submit` or in #[applications channel] before [date]. We read every application and answer by DM.',
        '',
        'Asking staff about your application does not speed it up.',
    ].join('\n'), 'blurple'),
    T('staff-apps-closed', 'staff', 'Staff applications closed', 'Staff applications are closed', [
        'Applications are closed. Thanks to everyone who applied.',
        '',
        'We will go through them over the next [number] days and answer everyone by DM, also if the answer is no.',
    ].join('\n'), 'grey'),
    T('staff-welcome', 'staff', 'New staff member', 'New on the team', [
        'Please welcome [name] to the moderation team.',
        '',
        'They can help with tickets, reports and keeping chat on track. Give them a bit of time to settle in.',
    ].join('\n'), 'green'),
    T('staff-leaving', 'staff', 'Staff member leaving', 'Thanks, [name]', [
        '[name] is stepping down from the staff team.',
        '',
        'Thanks for all the time you put into {server}. You will be missed.',
        '',
        'Open tickets they had are being picked up by the rest of the team.',
    ].join('\n'), 'grey'),

    // ── Safety and scams ──────────────────────────────────────────────────
    T('lockdown-active', 'safety', 'Lockdown active', 'The server is locked', [
        'We locked the server because of [a raid / spam / the reason].',
        '',
        'Most channels are read-only for now. You do not need to do anything.',
        '',
        'Do not click links from accounts you do not know, and do not reply to the raiders. We will post here when it is over.',
    ].join('\n'), 'red'),
    T('raid-ended', 'safety', 'Raid over, lockdown lifted', 'Lockdown lifted', [
        'The raid is over and the channels are open again.',
        '',
        'The accounts involved were banned and their messages removed. If you still see something we missed, report it with a ticket and include the message link.',
        '',
        'Thanks for staying calm.',
    ].join('\n'), 'green'),
    T('verification-required', 'safety', 'Verification required', 'Verify to get access', [
        'New members now have to verify before they can see the rest of {server}.',
        '',
        'Go to #[verify channel] and press Verify. It takes a few seconds.',
        '',
        'This helps keep raid bots and spam accounts out.',
    ].join('\n'), 'blurple'),
    T('scam-dm', 'safety', 'Scam DM warning', 'Watch out for scam DMs', [
        'Some members are getting DMs from accounts pretending to be from {server} or Discord.',
        '',
        'They might say you won something, that your account will be banned, or ask you to "verify" on a website.',
        '',
        '- Do not click the links.',
        '- Do not scan QR codes they send.',
        '- Do not send codes, passwords or money.',
        '',
        'Block the account, and if they are in this server, report them with a ticket.',
    ].join('\n'), 'red'),
    T('nitro-scam', 'safety', 'Free Nitro scam warning', 'Free Nitro links are scams', [
        'If someone sends you a link for free Nitro, it is almost always a scam to steal your account.',
        '',
        'Real Nitro gifts show up as a gift box inside Discord, not as a link to a website. If a site asks you to log in or scan a QR code, close it.',
        '',
        'If you already clicked one and logged in, change your password now and turn on two-factor authentication.',
    ].join('\n'), 'red'),
    T('never-dm-first', 'safety', 'Staff never DM you first', 'Staff will never DM you first', [
        'Nobody on the {server} staff team will DM you first to ask for:',
        '- your password or a login code',
        '- money, gift cards or Nitro',
        '- to download something or "test a game"',
        '',
        'If someone does, they are not staff. Check the member list for the real staff roles and report the account with a ticket.',
    ].join('\n'), 'red'),
    T('phishing-link', 'safety', 'Phishing link warning', 'Do not click that link', [
        'A phishing link was posted in #[channel] earlier. We removed it and banned the account.',
        '',
        'If you clicked it and entered your Discord login:',
        '1. Change your password right away.',
        '2. Turn on two-factor authentication.',
        '3. Check Settings > Devices and log out anything you do not know.',
        '',
        'Accounts that get hacked and start spamming are kicked until they are secured. Message staff when yours is safe again.',
    ].join('\n'), 'red'),
    T('compromised-account', 'safety', 'Hacked account kicked', 'About hacked accounts', [
        'If your account gets hacked and posts scam links, we kick it to protect everyone else. It is not a punishment.',
        '',
        'To come back:',
        '1. Change your password and turn on two-factor authentication.',
        '2. Message a staff member or open a ticket in the support server.',
        '3. We send you a new invite.',
    ].join('\n'), 'yellow'),

    // ── Welcome and rule reminders ────────────────────────────────────────
    T('welcome-new-members', 'reminders', 'Welcome this week\'s new members', 'Welcome to everyone who joined', [
        'A warm welcome to everyone who joined {server} this week.',
        '',
        '- Read the rules in #[rules channel].',
        '- Pick your roles in #[roles channel].',
        '- Say hi in #[chat channel].',
        '',
        'If you have a question, ask in #[help channel] or open a ticket.',
    ].join('\n'), 'green'),
    T('rules-reminder', 'reminders', 'Rules reminder', 'A quick rules reminder', [
        'Things have been a bit loud lately, so here is a short reminder.',
        '',
        '- Be kind to each other.',
        '- Keep each channel on its topic.',
        '- No spam, no self-promotion outside #[promo channel].',
        '',
        'The full rules are in #[rules channel]. Staff will warn or mute if needed.',
    ].join('\n'), 'yellow'),
    T('rule-added', 'reminders', 'New rule added', 'New rule: [short name]', [
        'We added a rule to {server}:',
        '',
        '**[Rule number]. [Rule title]**',
        '[What the rule says, in one or two sentences.]',
        '',
        'Why: [the reason, for example what kept happening].',
        '',
        'It applies from now on. Nothing posted before today counts against you.',
    ].join('\n'), 'blurple'),
    T('rule-removed', 'reminders', 'Rule removed', 'A rule was removed', [
        'Rule [number] ([rule title]) is gone. [Why it was removed.]',
        '',
        'The other rules are numbered again, so check #[rules channel] if you link to a rule by number.',
    ].join('\n'), 'grey'),
    T('rule-clarified', 'reminders', 'Rule clarified', 'Rule [number], explained', [
        'A few people asked about rule [number], so here is what it means in practice.',
        '',
        '**Allowed:** [example]',
        '**Not allowed:** [example]',
        '',
        'The rule itself did not change. Ask staff if something is still unclear.',
    ].join('\n'), 'blurple'),
    T('no-ping-staff', 'reminders', 'Do not ping staff', 'Please do not ping staff', [
        'Pinging staff for every question slows everyone down.',
        '',
        '- For help, ask in #[help channel].',
        '- For a problem with a member, open a ticket.',
        '- Only ping staff when something is happening right now, like a raid.',
    ].join('\n'), 'yellow'),
    T('spoiler-reminder', 'reminders', 'Spoiler reminder', 'Use spoiler tags', [
        '[Thing] just came out, so not everyone has seen it yet.',
        '',
        'Wrap spoilers like this: ||spoiler||. Talk about it freely in #[spoiler channel].',
        '',
        'Unmarked spoilers in other channels will be removed.',
    ].join('\n'), 'purple'),

    // ── Events and giveaways (more) ───────────────────────────────────────
    T('giveaway-start', 'events', 'Giveaway started', 'Giveaway: [prize]', [
        'We are giving away [prize] in {server}.',
        '',
        'How to enter: [react / press the button / message in #channel].',
        'Ends: [date and time].',
        'Winners: [number].',
        '',
        'One entry per person. Alt accounts are removed from the draw.',
    ].join('\n'), 'purple'),
    T('giveaway-ending', 'events', 'Giveaway ends soon', 'Last chance: [prize]', [
        'The giveaway for [prize] ends in [time].',
        '',
        'If you have not entered yet, [how to enter].',
    ].join('\n'), 'yellow'),
    T('giveaway-reroll', 'events', 'Giveaway rerolled', 'New winner for [prize]', [
        'The first winner did not claim [prize] in time, so we drew again.',
        '',
        'The new winner is [name]. Open a ticket within [48 hours] to claim it.',
    ].join('\n'), 'purple'),
    T('event-recap', 'events', 'Event recap', 'Thanks for coming', [
        'Thanks to everyone who joined [event] yesterday. [Number] people took part.',
        '',
        '[Short recap: winners, best moment, screenshots channel.]',
        '',
        'Ideas for the next one? Post them in #[suggestions channel].',
    ].join('\n'), 'green'),

    // ── Voice events and game nights ──────────────────────────────────────
    T('game-night', 'voice', 'Game night', 'Game night: [game]', [
        'Game night in {server} on [day] at [time] ([time zone]).',
        '',
        'Game: [game]',
        'Voice channel: #[voice channel]',
        '',
        'Everyone is welcome, new players too. React below if you want to join, so we know how many groups to make.',
    ].join('\n'), 'blurple'),
    T('movie-night', 'voice', 'Movie night', 'Movie night', [
        'We are watching [movie] together on [day] at [time] ([time zone]).',
        '',
        'Join #[voice channel] a few minutes early. The stream starts on time.',
        '',
        'Chat about it in #[chat channel]. Keep spoilers out of other channels.',
    ].join('\n'), 'purple'),
    T('voice-hangout', 'voice', 'Voice hangout', 'Voice hangout tonight', [
        'Hang out with us in #[voice channel] tonight from [time] ([time zone]).',
        '',
        'No plan, just talking. Drop in and leave whenever you like.',
    ].join('\n'), 'blurple'),
    T('stage-talk', 'voice', 'Stage talk / Q&A', 'Q&A on stage: [topic]', [
        '[Name] answers your questions about [topic] on [day] at [time] ([time zone]) in #[stage channel].',
        '',
        'Post questions in #[questions channel] before it starts. Raise your hand on stage to ask live.',
    ].join('\n'), 'blurple'),
    T('karaoke-night', 'voice', 'Karaoke night', 'Karaoke night', [
        'Karaoke in #[voice channel] on [day] at [time] ([time zone]).',
        '',
        'Sign up in #[event channel] with the song you want to sing. Listeners are welcome too.',
    ].join('\n'), 'purple'),
    T('tournament-signup', 'voice', 'Tournament sign-ups', 'Tournament: [game]', [
        'Sign-ups for the [game] tournament are open until [date].',
        '',
        'Format: [teams of 2 / 1v1 / ...]',
        'Starts: [date and time] ([time zone])',
        'Prize: [prize, if any]',
        '',
        'Sign up in #[signup channel]. Read the tournament rules there first.',
    ].join('\n'), 'blurple'),

    // ── Maintenance and downtime ──────────────────────────────────────────
    T('maintenance-extended', 'downtime', 'Maintenance takes longer', 'Maintenance is taking longer', [
        'The work on the server is taking longer than planned. We now expect it to be done by [time] ([time zone]).',
        '',
        'Sorry for the wait. We will post here when it is finished.',
    ].join('\n'), 'yellow'),
    T('emergency-maintenance', 'downtime', 'Unplanned maintenance', 'Unplanned maintenance', [
        'We need to fix something right away, so [what is affected] is not working for now.',
        '',
        'We expect it to take about [time]. You do not need to do anything.',
    ].join('\n'), 'red'),
    T('discord-outage', 'downtime', 'Discord is having problems', 'Discord is having problems', [
        'Discord itself is having trouble right now. Messages may not send, and bots may not answer.',
        '',
        'This is not something we can fix. You can follow it on discordstatus.com. Things should work again once Discord fixes it.',
    ].join('\n'), 'grey'),
    T('channel-readonly', 'downtime', 'Channel read-only for now', '#[channel] is read-only for now', [
        '#[channel] is read-only while we [reason].',
        '',
        'Use #[other channel] in the meantime. We will open it again on [date].',
    ].join('\n'), 'grey'),

    // ── Server milestones ─────────────────────────────────────────────────
    T('server-anniversary', 'milestones', 'Server birthday', '{server} is [number] years old', [
        '{server} started [number] years ago today.',
        '',
        'Thanks to everyone who helped it grow, from the first members to the people who joined last week.',
        '',
        '[Optional: an event or giveaway to mark it.]',
    ].join('\n'), 'purple', { celebrate: true }),
    T('boost-level', 'milestones', 'New boost level', 'Boost level [number] reached', [
        'Thanks to our boosters, {server} reached boost level [number].',
        '',
        'That gives us [perks, for example better voice quality and more emoji slots].',
    ].join('\n'), 'purple', { celebrate: true }),
    T('message-milestone', 'milestones', 'Message milestone', '[Number] messages', [
        'Members of {server} have now sent [number] messages. Thanks for keeping the chat alive.',
    ].join('\n'), 'green'),

    // ── Staff applications (more) ─────────────────────────────────────────
    T('staff-apps-deadline', 'staff', 'Staff applications close soon', 'Staff applications close soon', [
        'Staff applications close on [date]. If you want to apply, [how to apply].',
        '',
        'We read every application. Answers go out by DM by [date].',
    ].join('\n'), 'yellow'),
    T('staff-apps-results', 'staff', 'Staff application results', 'Staff applications: results', [
        'Thanks to everyone who applied. Everyone has their answer by DM now.',
        '',
        'If you were not picked this time, you can apply again when applications open next. We will post it here.',
    ].join('\n'), 'blurple'),

    // ── Partnerships ──────────────────────────────────────────────────────
    T('partner-requirements', 'partners', 'Partnership requirements', 'Want to partner with us?', [
        'We partner with servers that:',
        '- have at least [number] members,',
        '- follow the Discord Terms of Service,',
        '- have active staff and clear rules.',
        '',
        'To ask, open a ticket and choose Partnership. Include your invite link.',
    ].join('\n'), 'purple'),
    T('partnership-ended', 'partners', 'Partnership ended', 'Partnership with [server name] ended', [
        'We are no longer partnered with [server name]. [Optional: short reason.]',
        '',
        'Their posts in #[partners channel] were removed.',
    ].join('\n'), 'grey'),

    // ── Polls and feedback ────────────────────────────────────────────────
    T('feedback-wanted', 'polls', 'Feedback wanted', 'Tell us what you think', [
        'We want to hear what you think about [topic].',
        '',
        'Answer in #[feedback channel] or in the poll below. Every answer is read by staff.',
    ].join('\n'), 'blurple'),
    T('suggestions-open', 'polls', 'Suggestions channel', 'Have an idea for the server?', [
        'Post it in #[suggestions channel]. One idea per message, so people can vote on each.',
        '',
        'Staff look at the top ideas every [week / month] and say what will happen with them.',
    ].join('\n'), 'blurple'),
    T('poll-reminder', 'polls', 'Poll closes soon', 'The poll closes soon', [
        'The poll about [topic] closes on [date]. If you have not voted yet, find it in #[channel].',
    ].join('\n'), 'yellow'),

    // ── Holiday greetings ─────────────────────────────────────────────────
    T('new-year', 'holidays', 'Happy New Year', 'Happy New Year', [
        'Happy New Year from the {server} staff team.',
        '',
        'Thanks for being part of the server this year. See you in the next one.',
    ].join('\n'), 'purple', { celebrate: true }),
    T('halloween', 'holidays', 'Halloween', 'Happy Halloween', [
        'Happy Halloween from {server}.',
        '',
        '[Optional: costume contest in #channel, spooky roles, event time.]',
    ].join('\n'), 'yellow'),
    T('winter-holidays', 'holidays', 'Winter holidays', 'Happy holidays', [
        'Happy holidays from the {server} staff team.',
        '',
        'Staff may answer slower until [date]. Tickets and appeals stay open.',
    ].join('\n'), 'blurple'),
    T('summer-break', 'holidays', 'Summer break', 'Summer break', [
        'Many of us are away over the summer, so events pause until [date].',
        '',
        'The server stays open and staff still answer tickets.',
    ].join('\n'), 'green'),
]);

/** True when `id` is one of the templates only Mewvo's own servers get (config/mewvoTemplates.js). */
export function isHomeTemplate(id) {
    return MEWVO_TEMPLATES.some((t) => t.id === id);
}

/**
 * The template with this id, or null. Home-only templates (config/mewvoTemplates.js) only with
 * { home: true } (the caller checked isMewvoServer); everywhere else their ids are unknown.
 */
export function messageTemplate(id, { home = false } = {}) {
    return MESSAGE_TEMPLATES.find((t) => t.id === id) || (home ? MEWVO_TEMPLATES.find((t) => t.id === id) : null) || null;
}

/** [{ key, label, templates: [...] }] in group order (groups without templates left out); the Mewvo group first with { home: true }. */
export function templatesByGroup({ home = false } = {}) {
    const groups = MESSAGE_TEMPLATE_GROUPS
        .map((g) => ({ ...g, templates: MESSAGE_TEMPLATES.filter((t) => t.group === g.key) }))
        .filter((g) => g.templates.length);
    return home ? [{ ...MEWVO_TEMPLATE_GROUP, templates: [...MEWVO_TEMPLATES] }, ...groups] : groups;
}

/** The languages a template's text comes in: English, plus its translations (home templates). */
export function templateLanguages(template) {
    return ['en', ...Object.keys(template?.translations || {})];
}

/**
 * { title, text, colour, lang } with {server} replaced by the server name (or "the server"),
 * and for home templates {count} and {changes} by what the caller worked out. `lang` picks a
 * translation when the template has one (else English; `lang` in the result says which).
 * {mods} stays: it becomes the picked members' mentions when posting. Pure.
 */
export function fillTemplate(template, { server, lang = 'en', count = null, changes = null } = {}) {
    const name = String(server ?? '').trim() || 'the server';
    const translated = lang !== 'en' ? template.translations?.[lang] : null;
    const source = translated || template;
    const fill = (value) => String(value)
        .replaceAll('{server}', name)
        .replaceAll('{count}', count === null || count === undefined ? '[number]' : String(count))
        .replaceAll('{changes}', changes === null || changes === undefined ? '[changes]' : String(changes));
    return { title: fill(source.title).slice(0, 256), text: fill(source.text), colour: template.colour, lang: translated ? lang : 'en' };
}
