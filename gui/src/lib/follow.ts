// How the conversation follows a reply as it streams (Transcript.tsx's `follow`). Each new line used to glide the
// whole conversation up by a line: while a reply streamed it was nearly always in motion, and every frame of that
// motion drew the conversation again (on a Mac, about a third of WindowServer's time). Instead the reply writes down
// into room kept under it, the conversation holding still, and the conversation glides up by a room's worth once the
// room is used: one glide every few lines, as smooth as before. The room is what the reply writes in a couple of
// seconds: it opens only once words come steadily, and a slow reply leaves less of it empty. When the words stop (a
// tool, the reply's end) the room goes in one glide, so nothing stands empty under a wait; what lands between words
// (a tool's row) glides in as before.

/** Follow in room kept under a reply (false: a glide for each new line, as before). */
export const FOLLOW_ROOM = true;

/** How much writing the room holds: what the reply wrote over this long (a slow reply needs less room). */
export const ROOM_WRITTEN_MS = 2000;

/**
 * The room under a reply: what it wrote over the last ROOM_WRITTEN_MS, no more than a third of the view or than a glide
 * covers. None while that's less than ROOM_KEPT (a reply's first words, a sentence before a tool): they glide in as
 * any line, rather than opening room that goes again as soon as the words stop.
 */
export function roomFor(viewHeight: number, glideMax: number, written = Infinity) {
    const room = Math.round(Math.min(glideMax, viewHeight / 3, written));
    return room < ROOM_KEPT ? 0 : room;
}

/** Room that's always left under a reply as it writes, and the least worth opening. */
export const ROOM_KEPT = 56;
