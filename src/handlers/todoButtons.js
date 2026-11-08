import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, escapeMarkdown } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';

import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { botText, textForGuild } from '../utils/botText.js';
import { replyText } from '../commands/Core/modules/commandText.js';
// User text goes into embed markdown; escape it (escapeMarkdown also escapes backslashes) so it
// cannot form masked links or formatting.
function escapeUserText(text) {
  return escapeMarkdown(String(text ?? '')).replace(/[[\]()]/g, '\\$&');
}

// The shared-list view is a public post: `tr` is the server's language (English by default).
function buildSharedTodoViewPayload(listData, listId, guild, tr = botText('en')) {
  const memberList = (listData.members || []).map(memberId => {
    const member = guild?.members?.cache?.get(memberId);
    return member ? member.user.username : `<@${memberId}>`;
  }).join(', ');

  const owner = guild?.members?.cache?.get(listData.creatorId);
  const ownerName = owner ? owner.user.username : `<@${listData.creatorId}>`;

  const tasks = Array.isArray(listData.tasks) ? listData.tasks : [];

  if (tasks.length === 0) {
    return {
      embeds: [
        successEmbed(
          tr.t('utility.todo.sharedTitle', { id: listId }),
          `**${escapeUserText(listData.name)}**\n\n` +
          `${tr.t('utility.todo.owner', { name: ownerName })}\n` +
          `${tr.t('utility.todo.members', { names: memberList })}\n\n` +
          tr.t('utility.todo.emptyShared')
        )
      ],
      components: [
        new ActionRowBuilder().addComponents(
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
        )
      ]
    };
  }

  const taskList = tasks
    .map(task =>
      `${task.completed ? tr.t('utility.todo.done') : tr.t('utility.todo.open')} · #${task.id} ${escapeUserText(task.text)} ` +
      `\`[${new Date(task.createdAt).toLocaleDateString()}]` +
      (task.completed ? ` ${tr.t('utility.todo.completedBy', { user: `<@${task.completedBy}>` })}` : '') + '`'
    )
    .join('\n');

  return {
    embeds: [
      successEmbed(
        tr.t('utility.todo.sharedTitle', { id: listId }),
        `**${escapeUserText(listData.name)}**\n\n` +
        `${tr.t('utility.todo.owner', { name: ownerName })}\n` +
        `${tr.t('utility.todo.members', { names: memberList })}\n\n` +
        `${tr.t('utility.todo.tasks')}\n${taskList}`
      )
    ],
    components: [
      new ActionRowBuilder().addComponents(
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
      )
    ]
  };
}

async function refreshSharedTodoMessage(interaction, listId, messageId) {
  if (!messageId || !interaction.channel) {
    return;
  }

  const listKey = `shared_todo_${listId}`;
  const listData = await getFromDb(listKey, null);
  if (!listData) {
    return;
  }

  try {
    const targetMessage = await interaction.channel.messages.fetch(messageId);
    if (!targetMessage) {
      return;
    }

    const updatedPayload = buildSharedTodoViewPayload(listData, listId, interaction.guild, textForGuild(interaction.guildId, { purpose: 'public' }));
    await targetMessage.edit(updatedPayload);
  } catch (error) {
    logger.warn('Unable to refresh shared todo view message', {
      listId,
      messageId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      error: error.message
    });
  }
}

const sharedTodoAddHandler = {
  name: 'shared_todo_add',
  async execute(interaction, client, args) {
    const listId = args[0];
    const sourceMessageId = interaction.message?.id;

    if (!listId || !/^[a-zA-Z0-9_-]{1,64}$/.test(listId)) {
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.invalidListId') });
      return;
    }
    
    const modal = new ModalBuilder()
      .setCustomId(`shared_todo_add_modal:${listId}:${sourceMessageId || ''}`)
      .setTitle(replyText(interaction).t('utility.todo.modalAddTitle'));

    const taskInput = new TextInputBuilder()
      .setCustomId('task_text')
      .setLabel(replyText(interaction).t('utility.todo.taskLabel'))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200);

    const actionRow = new ActionRowBuilder().addComponents(taskInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
  }
};

const sharedTodoCompleteHandler = {
  name: 'shared_todo_complete',
  async execute(interaction, client, args) {
    const listId = args[0];
    const sourceMessageId = interaction.message?.id;

    if (!listId || !/^[a-zA-Z0-9_-]{1,64}$/.test(listId)) {
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.invalidListId') });
      return;
    }
    
    const modal = new ModalBuilder()
      .setCustomId(`shared_todo_complete_modal:${listId}:${sourceMessageId || ''}`)
      .setTitle(replyText(interaction).t('utility.todo.modalCompleteTitle'));

    const taskIdInput = new TextInputBuilder()
      .setCustomId('task_id')
      .setLabel(replyText(interaction).t('utility.todo.taskNumberLabel'))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder(replyText(interaction).t('utility.todo.taskNumberPlaceholder'));

    const actionRow = new ActionRowBuilder().addComponents(taskIdInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
  }
};

const sharedTodoRemoveHandler = {
  name: 'shared_todo_remove',
  async execute(interaction, client, args) {
    const listId = args[0];
    const sourceMessageId = interaction.message?.id;

    if (!listId || !/^[a-zA-Z0-9_-]{1,64}$/.test(listId)) {
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.invalidListId') });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`shared_todo_remove_modal:${listId}:${sourceMessageId || ''}`)
      .setTitle(replyText(interaction).t('utility.todo.modalRemoveTitle'));

    const taskIdInput = new TextInputBuilder()
      .setCustomId('task_id')
      .setLabel(replyText(interaction).t('utility.todo.taskNumberLabel'))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder(replyText(interaction).t('utility.todo.taskNumberPlaceholder'));

    const actionRow = new ActionRowBuilder().addComponents(taskIdInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
  }
};

const sharedTodoAddModalHandler = {
  name: 'shared_todo_add_modal',
  async execute(interaction, client, args) {
    const listId = args[0];
    const sourceMessageId = args[1] || null;
    const taskText = interaction.fields.getTextInputValue('task_text');
    const userId = interaction.user.id;

    try {
      const allowed = await checkRateLimit(`${userId}:shared_todo_add`, 5, 30000);
      if (!allowed) {
        return await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: replyText(interaction).t('utility.todo.tooFast') });
      }

      if (!listId || !/^[a-zA-Z0-9_-]{1,64}$/.test(listId)) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.invalidListId') });
      }

      if (!taskText || taskText.trim().length === 0) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.emptyText') });
      }

      const listKey = `shared_todo_${listId}`;
      let listData = await getFromDb(listKey, null);
      
      if (!listData) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.listNotFound') });
      }

      if (!listData.members || !listData.members.includes(userId)) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.noAccess') });
      }

      if (!listData.tasks) listData.tasks = [];
      if (!listData.nextId) listData.nextId = 1;

      const newTask = {
        id: listData.nextId++,
        text: taskText,
        completed: false,
        createdAt: new Date().toISOString(),
        createdBy: userId
      };
      
      listData.tasks.push(newTask);
      await setInDb(listKey, listData);

      await refreshSharedTodoMessage(interaction, listId, sourceMessageId);

      return interaction.reply({
        embeds: [successEmbed(replyText(interaction).t('utility.todo.taskAddedTitle'), replyText(interaction).t('utility.todo.taskAddedSharedShort', { task: escapeUserText(taskText) }))],
        flags: MessageFlags.Ephemeral
      });

    } catch (error) {
      logger.error('Error in shared todo add modal:', error);
      return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.addFailed') });
    }
  }
};

const sharedTodoCompleteModalHandler = {
  name: 'shared_todo_complete_modal',
  async execute(interaction, client, args) {
    const listId = args[0];
    const sourceMessageId = args[1] || null;
    const taskId = parseInt(interaction.fields.getTextInputValue('task_id'), 10);
    const userId = interaction.user.id;

    try {
      const allowed = await checkRateLimit(`${userId}:shared_todo_complete`, 5, 30000);
      if (!allowed) {
        return await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: replyText(interaction).t('utility.todo.tooFast') });
      }

      if (!listId || !/^[a-zA-Z0-9_-]{1,64}$/.test(listId)) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.invalidListId') });
      }

      if (!Number.isInteger(taskId) || taskId <= 0) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.badTaskId') });
      }

      const listKey = `shared_todo_${listId}`;
      let listData = await getFromDb(listKey, null);
      
      if (!listData) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.listNotFound') });
      }

      if (!listData.members || !listData.members.includes(userId)) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.noAccess') });
      }

      if (!listData.tasks) listData.tasks = [];

      const task = listData.tasks.find(t => t.id === taskId);
      
      if (!task) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.taskNotFound') });
      }

      if (task.completed) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.alreadyDone', { id: task.id }) });
      }
      
      task.completed = true;
      task.completedBy = userId;
      task.completedAt = new Date().toISOString();
      
      await setInDb(listKey, listData);

      await refreshSharedTodoMessage(interaction, listId, sourceMessageId);
      
      return interaction.reply({
        embeds: [successEmbed(replyText(interaction).t('utility.todo.taskDoneTitle'), replyText(interaction).t('utility.todo.taskDone', { task: escapeUserText(task.text) }))],
        flags: MessageFlags.Ephemeral
      });

    } catch (error) {
      logger.error('Error in shared todo complete modal:', error);
      return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.completeFailed') });
    }
  }
};

const sharedTodoRemoveModalHandler = {
  name: 'shared_todo_remove_modal',
  async execute(interaction, client, args) {
    const listId = args[0];
    const sourceMessageId = args[1] || null;
    const taskId = parseInt(interaction.fields.getTextInputValue('task_id'), 10);
    const userId = interaction.user.id;

    try {
      const allowed = await checkRateLimit(`${userId}:shared_todo_remove`, 5, 30000);
      if (!allowed) {
        return await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: replyText(interaction).t('utility.todo.tooFast') });
      }

      if (!listId || !/^[a-zA-Z0-9_-]{1,64}$/.test(listId)) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.invalidListId') });
      }

      if (!Number.isInteger(taskId) || taskId <= 0) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.badTaskId') });
      }

      const listKey = `shared_todo_${listId}`;
      const listData = await getFromDb(listKey, null);

      if (!listData) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.listNotFound') });
      }

      if (!listData.members || !listData.members.includes(userId)) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.noAccess') });
      }

      if (!Array.isArray(listData.tasks)) {
        listData.tasks = [];
      }

      const taskIndex = listData.tasks.findIndex(task => task.id === taskId);
      if (taskIndex === -1) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.taskNotFound') });
      }

      const [removedTask] = listData.tasks.splice(taskIndex, 1);
      await setInDb(listKey, listData);

      await refreshSharedTodoMessage(interaction, listId, sourceMessageId);

      return interaction.reply({
        embeds: [successEmbed(replyText(interaction).t('utility.todo.taskRemovedTitle'), replyText(interaction).t('utility.todo.taskRemovedSharedShort', { task: escapeUserText(removedTask.text) }))],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      logger.error('Error in shared todo remove modal:', error);
      return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: replyText(interaction).t('utility.todo.removeFailed') });
    }
  }
};

export default sharedTodoAddHandler;
export { sharedTodoCompleteHandler, sharedTodoRemoveHandler, sharedTodoAddModalHandler, sharedTodoCompleteModalHandler, sharedTodoRemoveModalHandler };