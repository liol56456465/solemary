import { PermissionFlagsBits } from 'discord.js';

export const VOICE_CHANNEL_DENIAL =
    'You need to be in the same voice channel as the bot to use music controls.';

export function canControlMusic(member, player) {
    // Admins and the server owner may control playback from anywhere.
    if (member && (member.guild?.ownerId === member.id || member.permissions?.has?.(PermissionFlagsBits.Administrator))) {
        return Boolean(player?.voiceChannel);
    }
    const memberChannel = member?.voice?.channel;
    if (!memberChannel || !player?.voiceChannel) {
        return false;
    }
    return memberChannel.id === player.voiceChannel;
}

export function requireVoiceChannel(member) {
    return Boolean(member?.voice?.channel);
}
