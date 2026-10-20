// A minimal terminal emulator for renderer tests: enough of VT100 to follow
// what src/ui/screen.ts writes (text, CR/LF, cursor up, clears, SGR ignored).
// Wide characters aren't handled; the tests use ASCII and box-drawing text.

export class VT {
    grid: string[][];
    scrollback: string[] = [];
    r = 0;
    c = 0;
    private pendingWrap = false;

    constructor(
        public rows: number,
        public cols: number,
    ) {
        this.grid = this.blank(rows);
    }

    private blank(n: number) {
        return Array.from({ length: n }, () => Array<string>(this.cols).fill(" "));
    }

    private newline() {
        this.pendingWrap = false;
        if (this.r === this.rows - 1) {
            this.scrollback.push(this.grid.shift()!.join("").trimEnd());
            this.grid.push(Array<string>(this.cols).fill(" "));
        } else this.r++;
    }

    feed(s: string) {
        for (let i = 0; i < s.length; i++) {
            const ch = s[i]!;
            if (ch === "\x1b") {
                const m = /^\x1b\[([?<>=]?)([0-9;]*)([A-Za-z])/.exec(s.slice(i)) ?? /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s.slice(i));
                if (!m) continue;
                i += m[0].length - 1;
                if (m[0][1] !== "[" || m[1]) continue;
                const n = m[2] ? Number(m[2].split(";")[0]) : 0;
                const fin = m[3];
                if (fin === "A") this.r = Math.max(0, this.r - (n || 1));
                else if (fin === "H") [this.r, this.c] = [0, 0];
                else if (fin === "J") {
                    if (n === 0) {
                        this.grid[this.r]!.fill(" ", this.c);
                        for (let k = this.r + 1; k < this.rows; k++) this.grid[k]!.fill(" ");
                    } else if (n === 2) this.grid = this.blank(this.rows);
                    else if (n === 3) this.scrollback = [];
                } else if (fin === "K") {
                    if (n === 0) this.grid[this.r]!.fill(" ", this.c);
                    else if (n === 1) this.grid[this.r]!.fill(" ", 0, this.c + 1);
                    else if (n === 2) this.grid[this.r]!.fill(" ");
                }
                if (fin !== "m") this.pendingWrap = false;
                continue;
            }
            if (ch === "\r") {
                this.c = 0;
                this.pendingWrap = false;
            } else if (ch === "\n") {
                // The pty turns \n into \r\n.
                this.c = 0;
                this.newline();
            } else {
                if (this.pendingWrap) {
                    this.c = 0;
                    this.newline();
                }
                this.grid[this.r]![this.c] = ch;
                if (this.c === this.cols - 1) this.pendingWrap = true;
                else this.c++;
            }
        }
    }

    /** Resize without re-wrapping (the screen is redrawn anyway). */
    resize(rows: number, cols: number) {
        const lines = this.screen();
        this.rows = rows;
        this.cols = cols;
        this.grid = lines.slice(-rows).map((l) => [...l.padEnd(cols).slice(0, cols)]);
        while (this.grid.length < rows) this.grid.push(Array<string>(cols).fill(" "));
        this.r = Math.min(this.r, rows - 1);
        this.c = Math.min(this.c, cols - 1);
    }

    screen(): string[] {
        return this.grid.map((r) => r.join("").trimEnd());
    }

    all(): string[] {
        return [...this.scrollback, ...this.screen()];
    }
}
