// messageTemplates.js — ready-made announcement texts for the dashboard Messages page
// ("Start from a template") and the /embedbuilder template picker. Choosing one only fills
// the form (box title, box text, box colour); the admin edits it and posts it. Nothing is
// posted from here, and posting keeps allowedMentions { parse: [] } (botMessageService.js).
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

export const MESSAGE_TEMPLATE_GROUPS = Object.freeze([
    { key: 'support', label: 'Support server' },
    { key: 'news', label: 'Server news' },
    { key: 'events', label: 'Events and giveaways' },
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
        'If the appeal is accepted, the warning is removed and no longer counts toward a ban. Press My standing on the panel to see how many warnings you have right now.',
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
]);

/** The template with this id, or null. */
export function messageTemplate(id) {
    return MESSAGE_TEMPLATES.find((t) => t.id === id) || null;
}

/** [{ key, label, templates: [...] }] in group order (groups without templates left out). */
export function templatesByGroup() {
    return MESSAGE_TEMPLATE_GROUPS
        .map((g) => ({ ...g, templates: MESSAGE_TEMPLATES.filter((t) => t.group === g.key) }))
        .filter((g) => g.templates.length);
}

/** { title, text, colour } with {server} replaced by the server name (or "the server"). Pure. */
export function fillTemplate(template, { server } = {}) {
    const name = String(server ?? '').trim() || 'the server';
    const fill = (value) => String(value).replaceAll('{server}', name);
    return { title: fill(template.title).slice(0, 256), text: fill(template.text), colour: template.colour };
}
