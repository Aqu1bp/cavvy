// Side chats: a question about a session, asked without adding to it. A side
// chat is a session of its own, hidden (it isn't listed), whose model is sent
// the parent's conversation before its own messages. Not copied into it: the
// parent's messages as they were when it opened, the same objects, so an open
// side chat keeps no second copy of them (a parent whose messages aren't held
// in memory, read for it, lets go of them again). Its own messages never reach
// the parent. It runs read-only (plan mode) unless the user changes that, and
// is discarded when it's closed or its parent is.

import { join } from "path";
import { cavvyHome } from "../config/paths";
import { toolCallsOf, type Message } from "../providers/types";

/** The parent's conversation as the side chat sees it, frozen when it opened, and where that is in the parent. */
export interface SideChatOrigin {
    /** The parent session's id. */
    of: string;
    /** Its messages up to `cut` (sideChatCut). Shared with the parent, never changed here. */
    context: readonly Message[];
}

/**
 * How much of a conversation a side chat is given: all of it, but a reply whose tool calls haven't come back
 * (a turn under way) stops before that reply. What it's given always ends where a next message can follow.
 */
export function sideChatCut(messages: readonly Message[]): number {
    const last = messages.at(-1);
    if (last?.role === "assistant" && toolCallsOf(last).length) return messages.length - 1;
    return messages.length;
}

/** Said to the side chat's model with its first question. */
export const SIDE_CHAT_REMINDER =
    "This is a side chat: the user is asking about the conversation above without adding to it. What's said here never reaches that session or its agent, which may still be working. Answer the question; don't carry on that session's task, and don't change files unless the user asks you to here.";

/** Where side chats keep their files while they're open: a folder each, removed with it. Never listed with the sessions. */
export function sideChatsDir(): string {
    return join(cavvyHome(), "side-chats");
}

/** A side chat's own folder. */
export function sideChatDir(id: string): string {
    return join(sideChatsDir(), id.replace(/[^\w.-]/g, "_"));
}

/** What a side chat's model is sent: the parent's conversation, then its own. */
export function withContext(context: readonly Message[] | undefined, own: Message[]): Message[] {
    return context?.length ? [...context, ...own] : own;
}
