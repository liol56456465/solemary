import {
  giveawayJoinHandler,
  giveawayLeaveHandler,
  giveawayEndHandler,
  giveawayRerollHandler,
  giveawayViewHandler,
} from '../../../handlers/giveawayButtons.js';

function fromCustomId(handler) {
  return {
    name: handler.customId,
    execute: handler.execute,
  };
}

export default [
  fromCustomId(giveawayJoinHandler),
  fromCustomId(giveawayLeaveHandler),
  fromCustomId(giveawayEndHandler),
  fromCustomId(giveawayRerollHandler),
  fromCustomId(giveawayViewHandler),
];