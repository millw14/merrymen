/**
 * A CHAT WITH NOTHING IN IT, for tests that render the Agent screen for
 * something else beside the conversation (the positions list, the trades
 * table).
 *
 * The chat moved out of Agent into an App-level controller (chat-controller.ts)
 * so a reply in flight survives the dock closing; Agent now takes that
 * controller as its `chat` prop, and a desk test that renders it without one
 * fails on the first property it reads. One stub, shared, so the next change
 * to the controller's shape is made here once.
 */
import type { ChatController } from "./chat-controller";

const noop = () => {};

export const idleChat: ChatController = {
  messages: [],
  draft: "",
  setDraft: noop,
  sending: false,
  streaming: null,
  proposal: null,
  setProposal: noop,
  confirming: false,
  confirm: async () => {},
  unread: false,
  settings: null,
  ceiling: null,
  send: async () => false,
  retry: async () => false,
  say: noop,
  followOrder: noop,
  refreshSettings: noop,
  clearThread: noop,
};
