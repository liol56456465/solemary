import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { query, T } from '../services/enforcement/db.js';

// Ban/kick appeal staff threads (support server) are private threads under the channel the
// appellant reads. Discord adds a member to a private thread when someone @mentions them there,
// so the appellant is removed again at once and staff are told why.
export default {
  name: Events.ThreadMembersUpdate,
  once: false,

  async execute(addedMembers, removedMembers, thread) {
    try {
      if (!addedMembers?.size || !thread?.guild) return;
      const { rows } = await query(
        `SELECT user_id, case_code FROM ${T.appeals} WHERE staff_thread_id = $1 AND kind = 'appeal' ORDER BY created_at DESC LIMIT 1`, [thread.id]);
      const appeal = rows[0];
      if (!appeal || !addedMembers.has(appeal.user_id)) return;
      await thread.members.remove(appeal.user_id);
      logger.warn(`Appeal ${appeal.case_code}: the appellant was added to the staff thread ${thread.id} (a mention?) and removed again`);
      await thread.send({
        content: 'The appellant was added to this staff thread (probably by an @mention) and was removed again. Please refer to them by name, not by mention.',
        allowedMentions: { parse: [] },
      }).catch(() => {});
    } catch (error) {
      logger.error(`Could not keep the appellant out of staff thread ${thread?.id}: ${error.message}`);
    }
  }
};
