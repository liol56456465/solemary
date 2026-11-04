// rulesLibrary.js — ready-made server rules for the dashboard Rules page ("Add from the
// library"). Each entry is a normal rule once added (title, text, consequence; editable and
// deletable like any other) plus `preset` = its key here, so the page can grey out the ones
// already added. `reason` is the prebuilt /enforcements reason (config/enforcement.js) the
// rule is linked to on add, when that reason is not linked to another rule yet.
//
// The consequence is only text: it is shown in the posted rules, on /rules and as a hint in
// the /enforcements confirm step ("Listed consequence: <text>."). It never punishes anyone
// by itself, and the warn ladder (3 warnings → 7-day ban, ...) stays as it is. The steps are
// graduated like a real server: a reminder or warning for small things, a short mute or a
// 1-day ban for repeats, long or permanent bans only for the serious ones. One line, at most
// 100 characters (RULES_LIMITS.consequenceMax), no full stop at the end (the hint adds one).

export const RULES_LIBRARY = Object.freeze([
    { key: 'respect', title: 'Be respectful', reason: 'harassment', consequence: 'Warning, then a 1-hour mute, then a 1-day ban',
        text: 'Treat people with respect. No insults, name-calling or starting fights. Banter is fine when both sides are in on it.' },
    { key: 'swearing', title: 'Keep swearing down', reason: 'slurs', consequence: 'Reminder, then a warning, then a 1-hour mute',
        text: 'Keep swearing to a minimum and do not dodge the filter with symbols or misspellings. Swearing at someone counts as disrespect.' },
    { key: 'hate', title: 'No hate speech or slurs', reason: 'slurs', consequence: '7-day ban, then a permanent ban',
        text: 'No slurs, and no attacks on anyone for their race, religion, nationality, gender, sexuality or disability. Not as a joke either.' },
    { key: 'harassment', title: 'No harassment', reason: 'harassment', consequence: '1-day mute, then a 7-day ban, then a permanent ban',
        text: 'Do not bully, threaten or stalk anyone. If someone asks you to stop messaging them, stop. This counts in DMs too.' },
    { key: 'spam', title: 'No spam', reason: 'spam', consequence: 'Message removed and a warning, then a 1-hour mute. Spam bots are banned',
        text: 'No message floods, walls of emoji, copy-paste chains or mass mentions.' },
    { key: 'advertising', title: 'No advertising', reason: 'advertising', consequence: 'Removed and a warning, then a 1-day ban. Advertising in DMs: 7-day ban',
        text: 'No server invites, self-promotion or ads, in channels or in members\' DMs, unless staff said yes first.' },
    { key: 'nsfw', title: 'No NSFW content', reason: 'nsfw', consequence: 'Removed and a 1-day ban, then a permanent ban',
        text: 'No sexual, gory or shocking content anywhere: messages, images, links, names, avatars or status.' },
    { key: 'doxxing', title: 'No sharing personal information', reason: 'harassment', consequence: 'Permanent ban',
        text: 'Never share someone\'s real name, address, photos, phone number or other private details. Not even if you think it is public already.' },
    { key: 'scams', title: 'No scams or phishing', reason: 'scamming', consequence: 'Permanent ban. Hacked accounts are kicked until they are secured',
        text: 'No fake giveaways, phishing links, account selling or anything else meant to trick members.' },
    { key: 'raiding', title: 'No raiding', reason: 'raiding', consequence: 'Permanent ban',
        text: 'Do not plan or take part in raids, here or on other servers.' },
    { key: 'channels', title: 'Use the right channels', reason: null, consequence: 'Reminder, then a warning',
        text: 'Post in the channel that fits the topic. Check the channel description if you are not sure.' },
    { key: 'impersonation', title: 'No impersonation', reason: null, consequence: 'Kick (change your name and rejoin). Pretending to be staff: 7-day ban',
        text: 'Do not pretend to be staff, a bot or another member, by name, avatar or the way you write.' },
    { key: 'tos', title: 'Follow the Discord rules', reason: null, consequence: 'Depends on what happened, up to a permanent ban',
        text: 'Follow the Discord Terms of Service and Community Guidelines (discord.com/guidelines). You must be at least 13 to use Discord.' },
    { key: 'staff', title: 'Listen to staff', reason: 'staff_disrespect', consequence: 'Warning, then a 1-hour mute, then a kick',
        text: 'Do what moderators ask. If you disagree, take it to a ticket and keep it calm, not in public chat.' },
    { key: 'begging', title: 'No begging', reason: null, consequence: 'Reminder, then a warning',
        text: 'Do not ask for roles, Nitro, money or items. Staff roles are given through applications, not by asking.' },
    { key: 'minimod', title: 'No mini-modding', reason: null, consequence: 'Reminder, then a warning',
        text: 'Leave moderating to staff. If someone breaks a rule, report it instead of telling them off in chat.' },
    { key: 'language', title: 'English in the main channels', reason: null, consequence: 'Reminder, then a warning',
        text: 'Use English in the main channels so everyone can follow along and staff can moderate. Other languages are fine in their own channels.' },
    { key: 'debates', title: 'No politics or religion debates', reason: null, consequence: 'Reminder, then a warning, then a 1-hour mute',
        text: 'Keep political and religious debates out of the chat. They turn into fights fast.' },
    { key: 'voice', title: 'No mic spam or soundboard spam', reason: null, consequence: 'Disconnected and a warning, then a 1-day mute',
        text: 'No screaming, ear-rape, music through your mic or soundboard spam in voice channels.' },
    { key: 'evasion', title: 'No alt accounts to dodge punishments', reason: null, consequence: 'Alt banned for good, and the punishment on your main account is extended',
        text: 'Do not use another account to get around a ban, mute or kick. If you think a punishment is wrong, appeal it.' },
    { key: 'spoilers', title: 'No spoilers outside spoiler channels', reason: null, consequence: 'Message removed, then a warning',
        text: 'Put spoilers in the spoiler channels, or hide them with ||spoiler tags||. That goes for new films, shows and games.' },
    { key: 'names', title: 'Readable names', reason: null, consequence: 'Nickname changed by staff. Changing it back: warning',
        text: 'Your name should be readable and easy to mention. No blank names, walls of symbols or offensive names.' },
].map((entry) => Object.freeze(entry)));

export function libraryRule(key) {
    return RULES_LIBRARY.find((entry) => entry.key === key) || null;
}
