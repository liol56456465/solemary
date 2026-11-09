import { SlashCommandBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, escapeMarkdown } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getFromDb, setInDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import crypto from 'crypto';
import { localized, publicText, replyText } from '../../utils/commandLocalizations.js';

/** The Add / Complete / Remove task buttons under a shared list (labels in the post's language). */
function sharedListButtons(listId, tr) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`shared_todo_add_${listId}`)
            .setLabel(tr.t('utility.todo.addTask'))
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`shared_todo_complete_${listId}`)
            .setLabel(tr.t('utility.todo.completeTask'))
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`shared_todo_remove_${listId}`)
            .setLabel(tr.t('utility.todo.removeTask'))
            .setStyle(ButtonStyle.Danger)
    );
}

// User text goes into embed markdown; escape it (escapeMarkdown also escapes backslashes) so it
// cannot form masked links or formatting.
function escapeUserText(text) {
    return escapeMarkdown(String(text ?? '')).replace(/[[\]()]/g, '\\$&');
}

function generateShareId() {
    return crypto.randomBytes(16).toString('hex');
}

export default {
    data: new SlashCommandBuilder()
        .setName("todo")
        .setDescription("Manage your personal to-do list")
        .setDescriptionLocalizations(localized('utility.slash.todo.description'))
        .addSubcommand(subcommand =>
            subcommand
                .setName("add")
                .setDescription("Add a task to your to-do list")
                .setDescriptionLocalizations(localized('utility.slash.todo.sub.add.description'))
                .addStringOption(option =>
                    option
                        .setName("task")
                        .setDescription("The task to add")
                        .setDescriptionLocalizations(localized('utility.slash.todo.sub.add.options.task'))
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("list")
                .setDescription("View your to-do list")
                .setDescriptionLocalizations(localized('utility.slash.todo.sub.list.description'))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("complete")
                .setDescription("Mark a task as complete")
                .setDescriptionLocalizations(localized('utility.slash.todo.sub.complete.description'))
                .addIntegerOption(option =>
                    option
                        .setName("number")
                        .setDescription("The number of the task to complete")
                        .setDescriptionLocalizations(localized('utility.slash.todo.sub.complete.options.number'))
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("remove")
                .setDescription("Remove a task from your to-do list")
                .setDescriptionLocalizations(localized('utility.slash.todo.sub.remove.description'))
                .addIntegerOption(option =>
                    option
                        .setName("number")
                        .setDescription("The number of the task to remove")
                        .setDescriptionLocalizations(localized('utility.slash.todo.sub.remove.options.number'))
                        .setRequired(true)
                )
        )
        .addSubcommandGroup(group => 
            group
                .setName("share")
                .setDescription("Manage shared to-do lists")
                .setDescriptionLocalizations(localized('utility.slash.todo.sub.share.description'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("create")
                        .setDescription("Create a new shared to-do list")
                        .setDescriptionLocalizations(localized('utility.slash.todo.sub.shareCreate.description'))
                        .addStringOption(option =>
                            option
                                .setName("name")
                                .setDescription("Name for the shared list")
                                .setDescriptionLocalizations(localized('utility.slash.todo.sub.shareCreate.options.name'))
                                .setRequired(true)
                        )
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("add")
                        .setDescription("Add a member to a shared list")
                        .setDescriptionLocalizations(localized('utility.slash.todo.sub.shareAdd.description'))
                        .addStringOption(option =>
                            option
                                .setName("list_id")
                                .setDescription("ID of the shared list")
                                .setDescriptionLocalizations(localized('utility.slash.todo.options.listId'))
                                .setRequired(true)
                        )
                        .addUserOption(option =>
                            option
                                .setName("user")
                                .setDescription("User to add to the list")
                                .setDescriptionLocalizations(localized('utility.slash.todo.sub.shareAdd.options.user'))
                                .setRequired(true)
                        )
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("view")
                        .setDescription("View a shared to-do list")
                        .setDescriptionLocalizations(localized('utility.slash.todo.sub.shareView.description'))
                        .addStringOption(option =>
                            option
                                .setName("list_id")
                                .setDescription("ID of the shared list")
                                .setDescriptionLocalizations(localized('utility.slash.todo.options.listId'))
                                .setRequired(true)
                        )
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("addtask")
                        .setDescription("Add a task to a shared to-do list")
                        .setDescriptionLocalizations(localized('utility.slash.todo.sub.shareAddtask.description'))
                        .addStringOption(option =>
                            option
                                .setName("list_id")
                                .setDescription("ID of the shared list")
                                .setDescriptionLocalizations(localized('utility.slash.todo.options.listId'))
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option
                                .setName("task")
                                .setDescription("The task to add")
                                .setDescriptionLocalizations(localized('utility.slash.todo.sub.add.options.task'))
                                .setRequired(true)
                        )
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("remove")
                        .setDescription("Remove a task from a shared to-do list")
                        .setDescriptionLocalizations(localized('utility.slash.todo.sub.shareRemove.description'))
                        .addStringOption(option =>
                            option
                                .setName("list_id")
                                .setDescription("ID of the shared list")
                                .setDescriptionLocalizations(localized('utility.slash.todo.options.listId'))
                                .setRequired(true)
                        )
                        .addIntegerOption(option =>
                            option
                                .setName("number")
                                .setDescription("The number of the task to remove")
                                .setDescriptionLocalizations(localized('utility.slash.todo.sub.remove.options.number'))
                                .setRequired(true)
                        )
                )
        )
        .setDMPermission(false),
    category: "Utility",

    async execute(interaction, config, client) {
        const userId = interaction.user.id;
        // Private answers: the user's language; the shared-list view is posted for everyone: the server's.
        const tr = replyText(interaction);
        const pub = publicText(interaction);
                const subcommand = interaction.options.getSubcommand();
                const shareSubcommand = interaction.options.getSubcommandGroup() === 'share' ? interaction.options.getSubcommand() : null;

        async function getOrCreateSharedList(listId, creatorId = null, listName = null) {
            const listKey = `shared_todo_${listId}`;
            let listData = await getFromDb(listKey, null);
            
            if (!listData || (listData.ok === false && listData.error)) {
                if (creatorId) {
                    listData = {
                        id: listId,
                        name: listName,
                        creatorId,
                        members: [creatorId],
                        tasks: [],
                        nextId: 1,
                        createdAt: new Date().toISOString()
                    };
                    await setInDb(listKey, listData);
                } else {
                    return null;
                }
            }
            
            if (listData) {
                if (!Array.isArray(listData.tasks)) listData.tasks = [];
                if (!listData.nextId) listData.nextId = 1;
                if (!Array.isArray(listData.members)) listData.members = [];
            }
            
            return listData;
        }

        // Only a shared-list view is posted for everyone (its buttons are for the list's members);
        // personal lists and confirmations stay private.
        const deferSuccess = await InteractionHelper.safeDefer(
            interaction,
            shareSubcommand === 'view' ? {} : { flags: MessageFlags.Ephemeral },
        );
        if (!deferSuccess) {
            logger.warn(`Todo interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'todo'
            });
            return;
        }

        if (shareSubcommand) {
            switch (shareSubcommand) {
                case 'create': {
                    const listName = interaction.options.getString('name');
                    const listId = generateShareId();

                    await getOrCreateSharedList(listId, userId, listName);

                    const userSharedLists = await getFromDb(`user_shared_lists_${userId}`, []);
                    const sharedListsArray = Array.isArray(userSharedLists) ? userSharedLists : [];
                    if (!sharedListsArray.includes(listId)) {
                        sharedListsArray.push(listId);
                        await setInDb(`user_shared_lists_${userId}`, sharedListsArray);
                    }

                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            successEmbed(
                                tr.t('utility.todo.createdTitle'),
                                tr.t('utility.todo.created', { name: escapeUserText(listName), id: listId })
                            )
                        ]
                    });
                }

                case 'add': {
                    const listId = interaction.options.getString('list_id');
                    const memberToAdd = interaction.options.getUser('user');

                    const listData = await getOrCreateSharedList(listId);
                    if (!listData) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.listNotFound') });
                    }

                    if (listData.creatorId !== userId) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.onlyCreator') });
                    }

                    if (!listData.members.includes(memberToAdd.id)) {
                        listData.members.push(memberToAdd.id);
                        await setInDb(`shared_todo_${listId}`, listData);

                        const memberLists = await getFromDb(`user_shared_lists_${memberToAdd.id}`, []);
                        const memberListsArray = Array.isArray(memberLists) ? memberLists : [];
                        if (!memberListsArray.includes(listId)) {
                            memberListsArray.push(listId);
                            await setInDb(`user_shared_lists_${memberToAdd.id}`, memberListsArray);
                        }

                        return await InteractionHelper.safeEditReply(interaction, {
                            embeds: [
                                successEmbed(tr.t('utility.todo.memberAddedTitle'),
                                    tr.t('utility.todo.memberAdded', { user: memberToAdd.username, name: escapeUserText(listData.name) })
                                )
                            ]
                        });
                    } else {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.alreadyMember') });
                    }
                }

                case 'view': {
                    const listId = interaction.options.getString('list_id');
                    const listData = await getOrCreateSharedList(listId);

                    if (!listData) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.listNotFound') });
                    }

                    if (!listData.members.includes(userId)) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.noAccess') });
                    }

                    if (listData.tasks.length === 0) {
                        const memberList = listData.members.map(memberId => {
                            const member = interaction.guild.members.cache.get(memberId);
                            return member ? member.user.username : `<@${memberId}>`;
                        }).join(',');

                        const owner = interaction.guild.members.cache.get(listData.creatorId);
                        const ownerName = owner ? owner.user.username : `<@${listData.creatorId}>`;

                        return await InteractionHelper.safeEditReply(interaction, {
                                embeds: [
                                    successEmbed(
                                        pub.t('utility.todo.sharedTitle', { id: listId }),
                                        `**${escapeUserText(listData.name)}**\n\n` +
                                        `${pub.t('utility.todo.owner', { name: ownerName })}\n` +
                                        `${pub.t('utility.todo.members', { names: memberList })}\n\n` +
                                        pub.t('utility.todo.emptyShared')
                                    )
                                ],
                                components: [sharedListButtons(listId, pub)]
                            });
                    }

                    const taskList = listData.tasks
                        .map(task => 
                            `${task.completed ? pub.t('utility.todo.done') : pub.t('utility.todo.open')} · #${task.id} ${escapeUserText(task.text)}` +
                            `\`[${new Date(task.createdAt).toLocaleDateString()}]` +
                            (task.completed ? pub.t('utility.todo.completedBy', { user: task.completedBy }) : '') + '`'
                        )
                        .join('\n');

                    const memberList = listData.members.map(memberId => {
                        const member = interaction.guild.members.cache.get(memberId);
                        return member ? member.user.username : `<@${memberId}>`;
                    }).join(',');

                    const owner = interaction.guild.members.cache.get(listData.creatorId);
                    const ownerName = owner ? owner.user.username : `<@${listData.creatorId}>`;

                    const fullListDisplay = `**${escapeUserText(listData.name)}**\n\n` +
                        `${pub.t('utility.todo.owner', { name: ownerName })}\n` +
                        `${pub.t('utility.todo.members', { names: memberList })}\n\n` +
                        `${pub.t('utility.todo.tasks')}\n${taskList}`;

                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            successEmbed(pub.t('utility.todo.sharedTitle', { id: listId }), fullListDisplay)
                        ],
                        components: [sharedListButtons(listId, pub)]
                    });
                }

                case 'addtask': {
                    const listId = interaction.options.getString('list_id');
                    const taskText = interaction.options.getString('task');

                    const listData = await getOrCreateSharedList(listId);

                    if (!listData) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.listNotFound') });
                    }

                    if (!listData.members.includes(userId)) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.noAccess') });
                    }

                    const newTask = {
                        id: listData.nextId++,
                        text: taskText,
                        completed: false,
                        createdAt: new Date().toISOString(),
                        createdBy: userId
                    };

                    listData.tasks.push(newTask);
                    await setInDb(`shared_todo_${listId}`, listData);

                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            successEmbed(tr.t('utility.todo.taskAddedTitle'), tr.t('utility.todo.taskAddedShared', { task: escapeUserText(taskText), name: escapeUserText(listData.name) }))
                        ]
                    });
                }

                case 'remove': {
                    const listId = interaction.options.getString('list_id');
                    const taskNumber = interaction.options.getInteger('number');

                    const listData = await getOrCreateSharedList(listId);

                    if (!listData) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.listNotFound') });
                    }

                    if (!listData.members.includes(userId)) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.noAccess') });
                    }

                    const taskIndex = listData.tasks.findIndex(task => task.id === taskNumber);
                    if (taskIndex === -1) {
                        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.taskNotFound') });
                    }

                    const [removedTask] = listData.tasks.splice(taskIndex, 1);
                    await setInDb(`shared_todo_${listId}`, listData);

                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [
                            successEmbed(tr.t('utility.todo.taskRemovedTitle'), tr.t('utility.todo.taskRemovedShared', { task: escapeUserText(removedTask.text), name: escapeUserText(listData.name) }))
                        ]
                    });
                }
            }
            return;
        }

        const dbKey = `todo_${userId}`;

        const userData = await getFromDb(dbKey, {
            tasks: [],
            nextId: 1
        });

        if (!userData.tasks) userData.tasks = [];
        if (!userData.nextId) userData.nextId = 1;

        switch (subcommand) {
            case 'add': {
                const taskText = interaction.options.getString('task');

                const newTask = {
                    id: userData.nextId++,
                    text: taskText,
                    completed: false,
                    createdAt: new Date().toISOString()
                };

                userData.tasks.push(newTask);
                await setInDb(dbKey, userData);

                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            tr.t('utility.todo.taskAddedTitle'),
                            tr.t('utility.todo.taskAdded', { task: escapeUserText(taskText) })
                        ),
                    ],
                });
            }

            case 'list': {
                if (userData.tasks.length === 0) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [successEmbed(tr.t('utility.todo.yourList'), tr.t('utility.todo.emptyList'))],
                    });
                }

                const taskList = userData.tasks
                    .map(task => 
                        `${task.completed ? tr.t('utility.todo.done') : tr.t('utility.todo.open')} · #${task.id} ${escapeUserText(task.text)}` +
                        `\`[${new Date(task.createdAt).toLocaleDateString()}]\``
                    )
                    .join('\n');

                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(tr.t('utility.todo.yourList'), taskList)
                    ],
                });
            }

            case 'complete': {
                const taskNumber = interaction.options.getInteger('number');
                const task = userData.tasks.find(t => t.id === taskNumber);

                if (!task) {
                    return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.taskNotFound') });
                }

                if (task.completed) {
                    return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.alreadyDone', { id: task.id }) });
                }

                task.completed = true;
                await setInDb(`todo_${userId}`, userData);

                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(tr.t('utility.todo.taskDoneTitle'), tr.t('utility.todo.taskDone', { task: escapeUserText(task.text) }))
                    ],
                });
            }

            case 'remove': {
                const taskNumber = interaction.options.getInteger('number');
                const taskIndex = userData.tasks.findIndex(t => t.id === taskNumber);

                if (taskIndex === -1) {
                    return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.taskNotFound') });
                }

                const [removedTask] = userData.tasks.splice(taskIndex, 1);
                await setInDb(`todo_${userId}`, userData);

                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(tr.t('utility.todo.taskRemovedTitle'), tr.t('utility.todo.taskRemoved', { task: escapeUserText(removedTask.text) }))
                    ],
                });
            }

            default:
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: tr.t('utility.todo.invalidSubcommand') });
        }
    },
};