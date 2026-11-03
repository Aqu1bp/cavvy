// How the conversation follows a reply as it streams (Transcript.tsx's `follow`). Each new line used to glide the
// whole conversation up by a line: while a reply streamed it was nearly always in motion, and every frame of that
// motion drew the conversation again (on a Mac, about a third of WindowServer's time). Instead the reply writes down
// into room kept under it, the conversation holding still, and the conversation glides up by a room's worth once the
// room is used: one glide every few lines, as smooth as before. When the words stop (a tool, the reply's end) the room
// goes in one glide, so nothing stands empty under a wait; what lands between words (a tool's row) glides in as before.

/** Follow in room kept under a reply (false: a glide for each new line, as before). */
export const FOLLOW_ROOM = true;

/** The room under a reply: a third of the view, and no more than a glide covers. */
export const roomFor = (viewHeight: number, glideMax: number) => Math.min(glideMax, Math.round(viewHeight / 3));

/** Room that's always left under a reply as it writes: what lands as it ends (its footer) fits in it. */
export const ROOM_KEPT = 56;
