/**
 * What xterm.js sends by itself, answering the shell or reporting focus:
 * device attributes (CSI ? … c, CSI > … c), status (CSI 0 n), cursor position
 * (CSI y;x R, CSI ? y;x R), mode reports (CSI … $ y), focus (CSI I, CSI O),
 * window reports (CSI 4|6|8 ; … t), OSC colour replies and DCS replies. Anything
 * else (keys, Escape, Alt+key, arrows, paste, mouse) is the user.
 */
const REPLY = /\x1b(?:\[[?>][\d;]*c|\[0n|\[\??\d+;\d+R|\[\??\d+;\d+\$y|\[[IO]|\[[468];\d+;\d+t|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)/y;

/** All of `data` is the terminal's own replies (one or several). */
export function isTerminalReply(data: string): boolean {
    let at = 0;
    while (at < data.length) {
        REPLY.lastIndex = at;
        if (!REPLY.test(data)) return false;
        at = REPLY.lastIndex;
    }
    return data.length > 0;
}

