// mergedCommand.js — one slash command whose subcommands are older standalone
// commands (/giveaway create = the old /gcreate). Each module keeps its own
// builder and execute(); its options become the subcommand's options, and a
// module that has subcommands of its own becomes a subcommand group.

const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

/**
 * @param {import('discord.js').SlashCommandBuilder} builder  name, description, permissions
 *   and any subcommands the command already has
 * @param {Record<string, { module: { data: { toJSON(): object }, execute: Function }, description: string }>} parts
 */
export function mergeSubcommands(builder, parts) {
    const data = {
        name: builder.name,
        toJSON() {
            const base = builder.toJSON();
            const merged = Object.entries(parts).map(([name, { module, description }]) => {
                const options = module.data.toJSON().options ?? [];
                const nested = options.some((option) => option.type === SUBCOMMAND);
                return { type: nested ? SUBCOMMAND_GROUP : SUBCOMMAND, name, description, options };
            });
            return { ...base, options: [...(base.options ?? []), ...merged] };
        },
    };

    /** Runs the module behind the invoked subcommand (or group); false when it isn't a merged one. */
    async function run(interaction, ...rest) {
        const key = interaction.options.getSubcommandGroup(false) ?? interaction.options.getSubcommand(false);
        const part = key ? parts[key] : null;
        if (!part) return false;
        await part.module.execute(interaction, ...rest);
        return true;
    }

    return { data, run };
}
