// Images in the terminal prompt: dropped/pasted paths, the clipboard, limits, permissions, and sending.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { deflateSync } from "zlib";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const img = await import("../src/ui/images");

/** Killed processes can linger as zombies for a moment until their new parent reaps them; a live one (these sleep for seconds) won't go. */
async function goneSoon(pid: number, ms = 1500): Promise<boolean> {
    for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(20)) {
        try {
            process.kill(pid, 0);
        } catch {
            return true;
        }
    }
    return false;
}
const { Editor, HISTORY_IMAGES, imagesIn, plainText, withoutImage } = await import("../src/ui/editor");
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { expandMentions } = await import("../src/ui/mentions");
const { PermissionChecker } = await import("../src/permissions/checker");
const { paths } = await import("../src/config/paths");

afterAll(cleanup);

// ---------------------------------------------------------------------------
// Real (tiny) images, built here so every decoder accepts them.

function pngChunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
    return Buffer.concat([head, data, crc]);
}

/** An RGB PNG, black; `size` pads it to that many bytes with a private ancillary chunk. */
function png(w = 2, h = 2, size = 0): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.alloc((w * 3 + 1) * h)))];
    const base = parts.reduce((n, p) => n + p.length, 0) + 12;
    if (size > base + 12) parts.push(pngChunk("paDd", Buffer.alloc(size - base - 12)));
    parts.push(pngChunk("IEND", Buffer.alloc(0)));
    return Buffer.concat(parts);
}

/** A grey baseline JPEG: one Huffman code each for "DC 0" and "end of block", so every 8×8 block is two bits. */
function jpeg(w = 8, h = 8): Buffer {
    const seg = (m: number, d: number[]) => [0xff, m, (d.length + 2) >> 8, (d.length + 2) & 255, ...d];
    const one = [1, ...Array(15).fill(0)];
    const bits = Math.ceil(w / 8) * Math.ceil(h / 8) * 2;
    const data = Buffer.alloc(Math.ceil(bits / 8));
    if (bits % 8) data[data.length - 1] = (1 << (8 - (bits % 8))) - 1;
    const head = [0xff, 0xd8, ...seg(0xdb, [0, ...Array(64).fill(1)]), ...seg(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]), ...seg(0xc4, [0x00, ...one, 0]), ...seg(0xc4, [0x10, ...one, 0]), ...seg(0xda, [1, 1, 0, 0, 63, 0])];
    return Buffer.concat([Buffer.from(head), data, Buffer.from([0xff, 0xd9])]);
}

class Bits {
    bytes: number[] = [];
    n = 0;
    put(v: number, k: number) {
        for (let i = 0; i < k; i++, this.n++) {
            if (this.n % 8 === 0) this.bytes.push(0);
            if ((v >> i) & 1) this.bytes[this.bytes.length - 1]! |= 1 << this.n % 8;
        }
    }
}

/** A black GIF: LZW with a clear code before every second pixel, so codes stay 3 bits. */
function gif(w = 2, h = 2): Buffer {
    const b = new Bits();
    for (let i = 0; i < w * h; i++) {
        if (i % 2 === 0) b.put(4, 3);
        b.put(0, 3);
    }
    b.put(5, 3);
    const lzw = [2];
    for (let i = 0; i < b.bytes.length; i += 255) lzw.push(Math.min(255, b.bytes.length - i), ...b.bytes.slice(i, i + 255));
    const le = (v: number) => [v & 255, v >> 8];
    return Buffer.from([...Buffer.from("GIF89a"), ...le(w), ...le(h), 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, ...le(w), ...le(h), 0, ...lzw, 0, 0x3b]);
}

/** A black lossless WebP (every prefix code has one symbol, so pixels take no bits); `extended` wraps it in VP8X. */
function webp(w = 2, h = 2, extended = false): Buffer {
    const b = new Bits();
    b.put(0x2f, 8);
    b.put(w - 1, 14);
    b.put(h - 1, 14);
    b.put(0, 4);
    b.put(0, 3); // no transform, color cache or meta prefix codes
    for (const [first8, sym] of [[0, 0], [0, 0], [0, 0], [1, 255], [0, 0]] as const) {
        b.put(1, 1);
        b.put(0, 1);
        b.put(first8, 1);
        b.put(sym, first8 ? 8 : 1);
    }
    const chunk = (type: string, d: Buffer) => {
        const head = Buffer.alloc(8);
        head.write(type, 0, "ascii");
        head.writeUInt32LE(d.length, 4);
        return Buffer.concat([head, d, Buffer.alloc(d.length % 2)]);
    };
    const chunks = [chunk("VP8L", Buffer.from(b.bytes))];
    if (extended) {
        const x = Buffer.alloc(10);
        x.writeUIntLE(w - 1, 4, 3);
        x.writeUIntLE(h - 1, 7, 3);
        chunks.unshift(chunk("VP8X", x));
    }
    const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
    const head = Buffer.alloc(8);
    head.write("RIFF", 0, "ascii");
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
}

/** A 3×2 lossy WebP from cwebp (a VP8 key frame is too much to encode here). */
const LOSSY_WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoDAAIAAgA0JaQAA3AA/vv9UAA=", "base64");

const NNBSP = "\u202f";
const shot = `Screenshot 2026-10-20 at 4.16.21${NNBSP}PM.png`;

type AppT = InstanceType<typeof App>;

function newApp(cwd = tempDir()) {
    const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    (app as any).renderLive = () => {};
    app.session = Session.create(app.cwd, { persist: false });
    const notices: string[] = [];
    app.notice = (m: string) => void notices.push(m);
    return { app, notices };
}
const paste = (app: AppT, s: string) => (app as any).onKey({ name: "paste", paste: s });
const settle = (app: AppT) => Promise.all([...((app as any).preparing as Map<number, Promise<void>>).values()]);
const value = (app: AppT) => app.editor.value();
const captureTurns = (app: AppT) => {
    const sent: { text: string; images: { name: string; bytes: number; mediaType: string }[] }[] = [];
    app.startTurn = (async (text: string, opts: any = {}) => {
        const images = opts.draft ? imagesIn(opts.draft.text, opts.draft.attachments) : [];
        sent.push({ text, images: images.map((i) => ({ name: i.name, bytes: i.bytes, mediaType: i.part.mediaType })) });
    }) as any;
    return sent;
};
const submit = (app: AppT) => (app as any).submit() as Promise<void>;
const state = (cwd: string) => ({ cwd, fileState: new Map() }) as any;
const checker = (cwd: string, deny: string[] = []) => new PermissionChecker(() => ({ permissions: { deny } }), cwd);
const image = (name: string, bytes = 1) => ({ name, bytes, part: { type: "image" as const, mediaType: "image/png", data: "AA==" } });

/** A sips stand-in: writes `out` (a 2000×1 PNG) once `gate` resolves. */
function fakeSips(gate: Promise<unknown> = Promise.resolve(), out = png(2000, 1, 500)) {
    const calls: string[][] = [];
    const run: import("../src/ui/images").Runner = async (argv) => {
        calls.push(argv);
        await gate;
        writeFileSync(argv[argv.indexOf("--out") + 1]!, out);
        return { code: 0, stdout: Buffer.alloc(0) };
    };
    return { run, calls };
}

describe("normalizePath and the lexer", () => {
    test("strips quotes, shell escapes and expands ~", () => {
        expect(img.normalizePath(`"/a/b c.png"`)).toBe("/a/b c.png");
        expect(img.normalizePath(`'/a/b c.png'`)).toBe("/a/b c.png");
        expect(img.normalizePath("/a/Screenshot\\ 1\\ \\(2\\).png")).toBe("/a/Screenshot 1 (2).png");
        expect(img.normalizePath("~/Desktop/x.png")).toBe(join(homedir(), "Desktop/x.png"));
        expect(img.normalizePath("'~/x.png'")).toBe("~/x.png");
    });
    test("file:// URLs are percent-decoded", () => {
        expect(img.normalizePath("file:///tmp/My%20Shot.png")).toBe("/tmp/My Shot.png");
    });
    test("several escaped paths split into words", () => {
        expect(img.splitPathTokens("/a/x\\ y.png /b/'z w'.png  \"/c/d e.png\"\n/f.png")).toEqual(["/a/x\\ y.png", "/b/'z w'.png", '"/c/d e.png"', "/f.png"]);
    });
    test("splitting and normalising agree on quotes inside a word", () => {
        const words = img.lexWords(`/tmp/dir/'a b'.png "/c/\\"q\\" \\x.png" '/s/a\\b.png' it's`);
        expect(words.map((w) => w.value)).toEqual(["/tmp/dir/a b.png", '/c/"q" \\x.png', "/s/a\\b.png", "it's"]);
        expect(img.normalizePath(`/tmp/dir/'a b'.png`)).toBe("/tmp/dir/a b.png");
    });
    test("a path quoted mid-word is pasted as an image", async () => {
        const { app } = newApp();
        const dir = tempDir();
        mkdirSync(join(dir, "d"));
        writeFileSync(join(dir, "d", "a b.png"), png());
        paste(app, `${dir}/d/'a b'.png`);
        await settle(app);
        expect(value(app)).toBe("[Image #1] ");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["a b.png"]);
    });
});

describe("resolveExisting", () => {
    test("a typed space finds the U+202F name before AM/PM", () => {
        const dir = tempDir();
        writeFileSync(join(dir, shot), png());
        const typed = join(dir, "Screenshot 2026-10-20 at 4.16.21 PM.png");
        expect(img.resolveExisting(typed)).toBe(join(dir, shot));
    });
    test("a NBSP name is found too", () => {
        const dir = tempDir();
        writeFileSync(join(dir, "a\u00a0b.png"), png());
        expect(img.resolveExisting(join(dir, "a b.png"))).toBe(join(dir, "a\u00a0b.png"));
    });
    test("the basename matches case-insensitively", () => {
        const dir = tempDir();
        writeFileSync(join(dir, "Photo One.PNG"), png());
        // a case-insensitive filesystem already finds it as typed
        expect(img.resolveExisting(join(dir, "photo one.png"))?.toLowerCase()).toBe(join(dir, "Photo One.PNG").toLowerCase());
    });
    test("case and odd spaces together go through the directory listing", () => {
        const dir = tempDir();
        writeFileSync(join(dir, "Photo\u202fOne.PNG"), png());
        expect(img.resolveExisting(join(dir, "photo one.png"))?.toLowerCase()).toBe(join(dir, "Photo\u202fOne.PNG").toLowerCase());
    });
    test("nothing there is undefined", () => {
        expect(img.resolveExisting(join(tempDir(), "nope.png"))).toBeUndefined();
    });
});

describe("pasting image paths", () => {
    test("an escaped path becomes a placeholder with the bytes stored", async () => {
        const { app } = newApp();
        const dir = tempDir();
        const bytes = png(10, 10, 100);
        writeFileSync(join(dir, shot), bytes);
        paste(app, join(dir, shot).replace(/ /g, "\\ ").replace(NNBSP, "\\" + NNBSP));
        await settle(app);
        expect(value(app)).toBe("[Image #1] ");
        const [im] = app.editor.attachedImages();
        expect(im!.bytes).toBe(100);
        expect(im!.name).toBe(shot);
        expect(Buffer.from(im!.part.data, "base64")).toEqual(bytes);
    });
    test("typed spaces in a file:// URL still find the U+202F file; two paths give two images", async () => {
        const { app } = newApp();
        const dir = tempDir();
        writeFileSync(join(dir, shot), png());
        writeFileSync(join(dir, "b.jpg"), jpeg());
        paste(app, `file://${dir}/Screenshot%202026-10-20%20at%204.16.21%20PM.png '${dir}/b.jpg'`);
        await settle(app);
        expect(value(app)).toBe("[Image #1] [Image #2] ");
        expect(app.editor.attachedImages().map((i) => i.part.mediaType)).toEqual(["image/png", "image/jpeg"]);
    });
    test("an unreadable image path is pasted as it came, with a notice", () => {
        const { app, notices } = newApp();
        // as a drop gives it: one word, spaces escaped
        const p = join(tempDir(), "Screenshot gone.png").replace(/ /g, "\\ ");
        paste(app, p);
        expect(value(app)).toBe(p);
        expect(app.editor.attachedImages()).toEqual([]);
        expect(notices[0]).toContain("Couldn't read Screenshot gone.png");
        expect(notices[0]).toContain("Ctrl+V");
    });
    test("non-image paths and ordinary text are pasted as before", () => {
        const { app, notices } = newApp();
        const dir = tempDir();
        writeFileSync(join(dir, "a.txt"), "x");
        paste(app, join(dir, "a.txt"));
        paste(app, " see /tmp/x.png please");
        expect(value(app)).toBe(`${join(dir, "a.txt")} see /tmp/x.png please`);
        expect(notices).toEqual([]);
    });
    test("code mentioning an image is pasted exactly, with no notice, whether or not the file exists", () => {
        for (const exists of [false, true]) {
            const { app, notices } = newApp();
            if (exists) writeFileSync(join(app.cwd, "foo.png"), png());
            paste(app, "// load ./foo.png\n");
            expect(value(app)).toBe("// load ./foo.png\n");
            expect(notices).toEqual([]);
            expect((app as any).preparing.size).toBe(0);
        }
    });
    test("one unescaped line is one path only when it names a real image", async () => {
        const { app } = newApp();
        const dir = tempDir();
        writeFileSync(join(dir, "My Shot.png"), png());
        paste(app, `${dir}/My Shot.png`);
        await settle(app);
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["My Shot.png"]);
        const other = newApp();
        writeFileSync(join(dir, "Fake Shot.png"), "not an image");
        paste(other.app, `${dir}/Fake Shot.png and more`);
        expect(value(other.app)).toBe(`${dir}/Fake Shot.png and more`);
        expect(other.notices).toEqual([]);
    });
});

describe("content, not the name, makes an image", () => {
    test("a text file named fake.png keeps the pasted text and says why", async () => {
        const { app, notices } = newApp();
        const f = join(tempDir(), "fake.png");
        writeFileSync(f, "just text, honest");
        paste(app, f);
        await settle(app);
        expect(value(app)).toBe(f + " ");
        expect(app.editor.attachedImages()).toEqual([]);
        expect(notices.join("\n")).toContain("fake.png isn't a PNG, JPEG, GIF or WebP image");
    });
    test("the media type comes from the bytes", async () => {
        const r = await img.prepareImage("photo.png", jpeg(16, 16));
        expect("image" in r && r.image.part.mediaType).toBe("image/jpeg");
        for (const [bytes, type] of [[png(), "image/png"], [gif(3, 3), "image/gif"], [webp(5, 4), "image/webp"], [LOSSY_WEBP, "image/webp"]] as const) {
            const p = await img.prepareImage("x", bytes);
            expect("image" in p && p.image.part.mediaType).toBe(type);
        }
    });
    test("a mentioned fake image outside the workspace isn't sent", async () => {
        const dir = tempDir();
        writeFileSync(join(dir, "fake.png"), "secret text");
        const cwd = tempDir();
        const r = await expandMentions(`@${dir}/fake.png`, state(cwd), [cwd], checker(cwd));
        expect(r.parts).toHaveLength(1);
        expect(r.notices.join()).toContain("isn't a PNG");
    });
});

describe("permissions", () => {
    function project() {
        const cwd = tempDir();
        mkdirSync(join(cwd, "secrets"));
        writeFileSync(join(cwd, "secrets", "key.png"), png());
        const out = tempDir();
        symlinkSync(join(cwd, "secrets", "key.png"), join(out, "shot.png"));
        return { cwd, link: join(out, "shot.png") };
    }

    test("a pasted symlink into a denied folder isn't read", async () => {
        const { cwd, link } = project();
        const { app, notices } = newApp(cwd);
        app.settings = { ...app.settings, permissions: { deny: ["Read(secrets/**)"] } };
        paste(app, link);
        await settle(app);
        expect(app.editor.attachedImages()).toEqual([]);
        expect(value(app)).toBe(link + " ");
        expect(notices.join()).toContain("denied by permission rule Read(secrets/**)");
    });
    test("a mentioned symlink into a denied folder isn't read", async () => {
        const { cwd, link } = project();
        const r = await expandMentions(`look @${link} and @secrets/key.png`, state(cwd), [cwd], checker(cwd, ["Read(secrets/**)"]));
        expect(r.parts.filter((p) => p.type === "image")).toEqual([]);
        expect(r.attached).toEqual([]);
        expect(r.notices).toHaveLength(2);
    });
    test("the credential store and files that may hold credentials are never attached, even as images", async () => {
        const cwd = tempDir();
        const store = paths.credentialsFile();
        mkdirSync(dirname(store), { recursive: true });
        writeFileSync(store, png());
        const env = join(tempDir(), ".env.d");
        mkdirSync(env);
        writeFileSync(join(env, "shot.png"), png());
        const out = tempDir();
        symlinkSync(store, join(out, "creds.png"));
        symlinkSync(join(env, "shot.png"), join(out, "env.png"));
        try {
            const { app, notices } = newApp(cwd);
            paste(app, `${out}/creds.png ${out}/env.png`);
            await settle(app);
            expect(app.editor.attachedImages()).toEqual([]);
            expect(notices.join("\n")).toContain("credential store");
            expect(notices.join("\n")).toContain("may contain credentials");
            const r = await expandMentions(`@${out}/creds.png @${out}/env.png`, state(cwd), [cwd], app.checker);
            expect(r.parts.filter((p) => p.type === "image")).toEqual([]);
        } finally {
            rmSync(store, { force: true });
        }
    });
    test("an ordinary image outside the workspace is the user's to share", async () => {
        const dir = tempDir();
        writeFileSync(join(dir, "pic.png"), png());
        const { app } = newApp();
        paste(app, join(dir, "pic.png"));
        await settle(app);
        expect(app.editor.attachedImages()).toHaveLength(1);
    });
});

describe("sending", () => {
    test("submit hands the images over in placeholder order and clears the prompt", async () => {
        const { app } = newApp();
        const dir = tempDir();
        writeFileSync(join(dir, "a.png"), png(1, 1, 400));
        writeFileSync(join(dir, "b.png"), png(1, 1, 500));
        paste(app, join(dir, "a.png"));
        app.editor.home();
        paste(app, join(dir, "b.png"));
        await settle(app);
        const sent = captureTurns(app);
        await submit(app);
        expect(sent).toEqual([{ text: "[Image #2] [Image #1] ", images: [expect.objectContaining({ bytes: 500 }), expect.objectContaining({ bytes: 400 })] }]);
        expect(app.editor.text).toBe("");
    });
    test("deleting a placeholder drops its image", () => {
        const e = new Editor();
        e.attachImage(image("a.png"));
        e.attachImage(image("b.png"));
        e.backspace();
        expect(plainText(e.text)).toBe("[Image #1]");
        expect(e.attachedImages().map((i) => i.name)).toEqual(["a.png"]);
        e.undo();
        expect(e.attachedImages().map((i) => i.name)).toEqual(["a.png", "b.png"]);
        e.clear();
        e.undo();
        expect(e.attachedImages().length).toBe(2);
    });
});

describe("placeholders are attachments, not text", () => {
    test("typing [Image #1] after clearing sends no image", async () => {
        const { app } = newApp();
        app.editor.attachImage(image("old.png"));
        app.editor.clear();
        for (const ch of "[Image #1]") (app as any).onKey({ name: "text", text: ch });
        expect(app.editor.attachedImages()).toEqual([]);
        const sent = captureTurns(app);
        await submit(app);
        expect(sent).toEqual([{ text: "[Image #1]", images: [] }]);
    });
    test("editing a placeholder's number makes it plain text; undo brings the image back", () => {
        const e = new Editor();
        e.attachImage(image("a.png"));
        e.attachImage(image("b.png"));
        e.left();
        e.backspace();
        e.insert("1");
        expect(plainText(e.text)).toBe("[Image #1][Image #1]");
        expect(e.attachedImages().map((i) => i.name)).toEqual(["a.png"]);
        e.undo();
        e.undo();
        expect(e.attachedImages().map((i) => i.name)).toEqual(["a.png", "b.png"]);
    });
    test("pasted or typed text can't forge a marker", () => {
        const e = new Editor();
        e.attachImage(image("a.png"));
        const forged = e.text;
        e.clear();
        e.paste(forged);
        e.insert(forged);
        expect(e.attachedImages()).toEqual([]);
        expect(e.text).toBe("[Image #1][Image #1]");
    });
    test("placeholders survive kill and yank, and browsing history", () => {
        const e = new Editor();
        e.setHistory(["earlier"]);
        e.insert("see ");
        e.attachImage(image("a.png"));
        e.killToStart();
        e.yank();
        expect(e.attachedImages().map((i) => i.name)).toEqual(["a.png"]);
        e.historyPrev();
        expect(e.text).toBe("earlier");
        e.historyNext();
        expect(e.attachedImages().map((i) => i.name)).toEqual(["a.png"]);
    });
    test("the cursor steps over a placeholder's marker", () => {
        const e = new Editor();
        e.insert("a");
        e.attachImage(image("x.png"));
        e.home();
        e.right();
        e.right();
        e.insert("!");
        // after "a[": inside the placeholder, which turns it into text
        expect(plainText(e.text)).toBe("a[!Image #1]");
        e.undo();
        e.home();
        e.right();
        e.insert("b");
        expect(plainText(e.text)).toBe("ab[Image #1]");
        expect(e.attachedImages()).toHaveLength(1);
    });
});

describe("queued prompts keep their images", () => {
    async function queueWithImage() {
        const { app } = newApp();
        const f = join(tempDir(), "q.png");
        writeFileSync(f, png(1, 1, 300));
        app.busy = true;
        await app.submitText("first");
        paste(app, f);
        await settle(app);
        app.editor.insert("look");
        await submit(app);
        await app.submitText("after");
        return app;
    }

    test("the running turn takes plain messages only up to one with images, which gets its own turn", async () => {
        const app = await queueWithImage();
        (app as any).printUser = () => {};
        expect((app as any).drainQueued()).toEqual(["first"]);
        expect((app as any).drainQueued()).toEqual([]);
        app.busy = false;
        const sent = captureTurns(app);
        await app.submitText((app as any).queued.shift());
        expect(sent).toEqual([{ text: "[Image #1] look", images: [expect.objectContaining({ name: "q.png", bytes: 300 })] }]);
    });
    test("an interrupt hands queued images back even after the editor's undo history has moved on", async () => {
        const app = await queueWithImage();
        // push every snapshot holding the placeholder out of the undo history
        for (let i = 0; i < 250; i++) app.editor.insert(i % 2 ? "x" : " ");
        app.editor.clear();
        app.editor.insert("draft");
        (app as any).returnQueued();
        (app as any).returnQueued();
        expect(value(app)).toBe("first\n[Image #1] look\nafter\ndraft");
        expect(app.editor.attachedImages().map((i) => i.bytes)).toEqual([300]);
        const sent = captureTurns(app);
        app.busy = false;
        await submit(app);
        expect(sent[0]!.images.map((i) => i.name)).toEqual(["q.png"]);
    });
});

describe("images still being prepared", () => {
    function twoPaths(gate: Promise<unknown>) {
        const { app, notices } = newApp();
        const dir = tempDir();
        writeFileSync(join(dir, "big.png"), png(9000, 1));
        writeFileSync(join(dir, "small.png"), png(1, 1, 200));
        const sips = fakeSips(gate);
        app.imagePrep = { run: sips.run, platform: "darwin" };
        paste(app, `${dir}/big.png ${dir}/small.png`);
        return { app, notices };
    }

    test("they keep their place: a wait shorter than the bound sends both, in paste order", async () => {
        let release!: () => void;
        const { app } = twoPaths(new Promise<void>((r) => (release = r)));
        const sent = captureTurns(app);
        const done = submit(app);
        setTimeout(release, 20);
        await done;
        expect(sent[0]!.text).toBe("[Image #1] [Image #2] ");
        expect(sent[0]!.images.map((i) => [i.name, i.bytes])).toEqual([["big.png", 500], ["small.png", 200]]);
    });
    test("past the bound they're left out with a notice, and never land in the next prompt", async () => {
        let release!: () => void;
        const { app, notices } = twoPaths(new Promise<void>((r) => (release = r)));
        app.attachWaitMs = 20;
        const sent = captureTurns(app);
        await submit(app);
        expect(sent[0]!.text).toBe(" [Image #2] ");
        expect(sent[0]!.images.map((i) => i.name)).toEqual(["small.png"]);
        expect(notices.join()).toContain("Image #1 wasn't ready in time");
        app.editor.insert("next prompt");
        release();
        await settle(app);
        expect(value(app)).toBe("next prompt");
        expect(app.editor.attachedImages()).toEqual([]);
        app.editor.clear();
        app.editor.undo();
        expect(app.editor.attachedImages()).toEqual([]);
    });
    test("Ctrl+V reserves its place too, and an empty clipboard leaves nothing behind", async () => {
        const { app } = newApp();
        app.imagePrep = {
            run: async (argv) => {
                writeFileSync(argv[argv.length - 1]!, png(4, 4));
                return { code: 0, stdout: Buffer.alloc(0) };
            },
            platform: "darwin",
        };
        app.editor.insert("a ");
        (app as any).onKey({ name: "v", ctrl: true });
        app.editor.insert(" b");
        await settle(app);
        expect(value(app)).toBe("a [Image #1] b");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["clipboard.png"]);
        app.imagePrep = { run: async () => ({ code: 1, stdout: Buffer.alloc(0) }), platform: "darwin" };
        (app as any).onKey({ name: "v", ctrl: true });
        await settle(app);
        expect(value(app)).toBe("a [Image #1] b");
        expect((app as any).flash.text).toBe("No image on the clipboard");
    });
});

describe("limits", () => {
    test("planImage checks bytes, the long side, and that the size is known", () => {
        expect(img.planImage(1000, { width: 100, height: 100 })).toBe("ok");
        expect(img.planImage(img.MAX_IMAGE_BYTES + 1, { width: 1, height: 1 })).toBe("downscale");
        expect(img.planImage(1000, { width: 100, height: img.MAX_IMAGE_SIDE + 1 })).toBe("downscale");
        expect(img.planImage(1000)).toBe("downscale");
    });
    test("imageSize reads PNG, JPEG, GIF and every WebP flavour", () => {
        expect(img.imageSize(png(321, 123))).toEqual({ width: 321, height: 123 });
        expect(img.imageSize(jpeg(40, 24))).toEqual({ width: 40, height: 24 });
        expect(img.imageSize(gif(7, 5))).toEqual({ width: 7, height: 5 });
        expect(img.imageSize(webp(9, 3))).toEqual({ width: 9, height: 3 });
        expect(img.imageSize(webp(9000, 1, true))).toEqual({ width: 9000, height: 1 });
        expect(img.imageSize(LOSSY_WEBP)).toEqual({ width: 3, height: 2 });
        expect(img.imageSize(png().subarray(0, 16))).toBeUndefined();
    });
    test("a 9000×1 WebP isn't sent as is: shrunk with sips, or refused elsewhere", async () => {
        const wide = webp(9000, 1, true);
        const off = await img.prepareImage("wide.webp", wide, { platform: "linux" });
        expect("error" in off && off.error).toContain("9000×1px");
        const sips = fakeSips();
        const on = await img.prepareImage("wide.webp", wide, { run: sips.run, platform: "darwin" });
        expect("image" in on && on.image.bytes).toBe(500);
        expect(sips.calls[0]!.slice(0, 3)).toEqual(["sips", "-Z", "2000"]);
    });
    test("unknown dimensions are refused when they can't be fixed", async () => {
        const r = await img.prepareImage("cut.png", png().subarray(0, 16), { platform: "linux" });
        expect("error" in r && r.error).toContain("dimensions couldn't be read");
    });
    test("sips failing, or making something that still doesn't fit, yields a notice", async () => {
        const fail = await img.prepareImage("x.png", png(9000, 1), { run: async () => ({ code: 1, stdout: Buffer.alloc(0) }), platform: "darwin" });
        expect("error" in fail && fail.error).toContain("x.png");
        const still = await img.prepareImage("y.png", png(9000, 1), { run: fakeSips(undefined, png(9000, 1)).run, platform: "darwin" });
        expect("error" in still).toBe(true);
    });
    test("mentions go through the same checks and shrinking", async () => {
        const cwd = tempDir();
        writeFileSync(join(cwd, "wide.png"), png(9000, 1));
        const r = await expandMentions("@wide.png", state(cwd), [cwd], checker(cwd), { prepare: { run: fakeSips().run, platform: "darwin" } });
        expect(r.attached).toEqual(["wide.png"]);
        expect((r.parts[1] as any).data).toBe(png(2000, 1, 500).toString("base64"));
        const off = await expandMentions("@wide.png", state(cwd), [cwd], checker(cwd), { prepare: { platform: "linux" } });
        expect(off.attached).toEqual([]);
        expect(off.notices.join()).toContain("wide.png can't be attached");
    });
    test("files over the processing ceiling are refused before they're read", async () => {
        const f = join(tempDir(), "huge.png");
        writeFileSync(f, png());
        truncateSync(f, img.MAX_PROCESS_BYTES + 1);
        const r = await img.loadImageFile(f, () => undefined);
        expect("error" in r && r.error).toContain("too large");
        expect(img.readCapped(f)).toBeUndefined();
    });
    test("a command printing past its cap is killed", async () => {
        const started = Date.now();
        expect(await img.runCommand(["yes"], 5000, 4096)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(4000);
        expect((await img.runCommand(["printf", "hi"], 5000, 4096))?.stdout.toString()).toBe("hi");
    });
});

describe("clipboard", () => {
    test("macOS: osascript writes the PNG to a temp file, which is read and removed", async () => {
        const bytes = png();
        let out = "";
        const ok = await img.readClipboardImage(async (argv) => {
            out = argv[argv.length - 1]!;
            expect(argv.join(" ")).toContain("open for access");
            writeFileSync(out, bytes);
            return { code: 0, stdout: Buffer.alloc(0) };
        }, "darwin");
        expect(ok).toEqual(bytes);
        expect(existsSync(dirname(out))).toBe(false);
        expect(await img.readClipboardImage(async () => ({ code: 1, stdout: Buffer.alloc(0) }), "darwin")).toBeUndefined();
        const notPng = await img.readClipboardImage(async (argv) => (writeFileSync(argv[argv.length - 1]!, "text"), { code: 0, stdout: Buffer.alloc(0) }), "darwin");
        expect(notPng).toBeUndefined();
    });
    test("Linux: tries wl-paste, then xclip, skips tools that are missing, and caps what they print", async () => {
        const bytes = png();
        const tried: string[] = [];
        const caps: (number | undefined)[] = [];
        const got = await img.readClipboardImage(async (argv, _t, max) => {
            tried.push(argv[0]!);
            caps.push(max);
            return argv[0] === "wl-paste" ? undefined : { code: 0, stdout: bytes };
        }, "linux");
        expect(tried).toEqual(["wl-paste", "xclip"]);
        expect(caps).toEqual([img.MAX_PROCESS_BYTES, img.MAX_PROCESS_BYTES]);
        expect(got).toEqual(bytes);
        expect(await img.readClipboardImage(async () => ({ code: 0, stdout: Buffer.from("not an image") }), "linux")).toBeUndefined();
    });
});

describe("@path mentions", () => {
    test("a path typed with normal spaces finds the U+202F file, even outside the workspace", async () => {
        const dir = tempDir();
        mkdirSync(join(dir, "Shots"));
        writeFileSync(join(dir, "Shots", shot), png());
        const cwd = tempDir();
        const typed = `look at @${dir}/Shots/Screenshot 2026-10-20 at 4.16.21 PM.png please`;
        const { parts, attached } = await expandMentions(typed, state(cwd), [cwd], checker(cwd));
        expect(parts.filter((p) => p.type === "image")).toHaveLength(1);
        expect(attached).toHaveLength(1);
    });
    test("escaped and quoted forms work", async () => {
        const dir = tempDir();
        writeFileSync(join(dir, "a b.png"), png());
        expect((await expandMentions("@a\\ b.png", state(dir), [dir], checker(dir))).attached).toHaveLength(1);
        expect((await expandMentions('@"a b.png"', state(dir), [dir], checker(dir))).attached).toHaveLength(1);
        expect((await expandMentions("@'a b.png'.", state(dir), [dir], checker(dir))).attached).toHaveLength(1);
    });
    test("prose after a mention stays prose", async () => {
        const cwd = tempDir();
        writeFileSync(join(cwd, "a.txt"), "alpha");
        writeFileSync(join(cwd, "small.png"), png());
        const r = await expandMentions("@./a.txt compare with small.png", state(cwd), [cwd], checker(cwd));
        expect(r.attached).toEqual(["a.txt"]);
        expect(r.parts.filter((p) => p.type === "image")).toEqual([]);
        const two = await expandMentions("@./a.txt and @small.png, thanks", state(cwd), [cwd], checker(cwd));
        expect(two.attached).toEqual(["a.txt", "small.png"]);
    });
    test("non-image files outside the workspace are still skipped", async () => {
        const dir = tempDir();
        writeFileSync(join(dir, "n.txt"), "secret");
        const cwd = tempDir();
        expect((await expandMentions(`@${dir}/n.txt`, state(cwd), [cwd], checker(cwd))).attached).toEqual([]);
    });
});

describe("a prompt sent while its images are still being prepared", () => {
    const key = (app: AppT, k: object) => (app as any).onKey(k);
    const type = (app: AppT, s: string) => {
        for (const ch of s) key(app, { name: "text", text: ch });
    };
    const tick = () => new Promise((r) => setTimeout(r, 10));
    function slowDraft() {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { app, notices } = newApp();
        const dir = tempDir();
        writeFileSync(join(dir, "big.png"), png(9000, 1));
        writeFileSync(join(dir, "small.png"), png(1, 1, 200));
        app.imagePrep = { run: fakeSips(gate).run, platform: "darwin" };
        paste(app, `${dir}/big.png ${dir}/small.png`);
        return { app, notices, dir, release, sent: captureTurns(app) };
    }

    test("Enter, Ctrl+C, then typing: nothing is sent, and the draft comes back to be edited", async () => {
        const { app, release, sent } = slowDraft();
        key(app, { name: "enter" });
        expect(value(app)).toBe("");
        key(app, { name: "c", ctrl: true });
        await tick();
        expect(value(app)).toBe("[Image #1] [Image #2] ");
        type(app, "x");
        release();
        await settle(app);
        await tick();
        expect(sent).toEqual([]);
        expect(value(app)).toBe("[Image #1] [Image #2] x");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["big.png", "small.png"]);
    });
    test("a replacement typed during the wait is kept and never sent, not by Esc, a second Enter, nor the images finishing", async () => {
        const { app, notices, release, sent } = slowDraft();
        key(app, { name: "enter" });
        type(app, "replacement");
        key(app, { name: "enter" });
        expect(value(app)).toBe("replacement");
        key(app, { name: "escape" });
        release();
        await settle(app);
        await tick();
        expect(sent).toEqual([]);
        expect(value(app)).toBe("replacement");
        expect(notices.join()).toContain("Not sent");
    });
    test("without a cancel only the submitted draft goes; text typed meanwhile stays in the prompt", async () => {
        const { app, release, sent } = slowDraft();
        key(app, { name: "enter" });
        type(app, "next");
        release();
        await settle(app);
        await tick();
        expect(sent).toEqual([{ text: "[Image #1] [Image #2] ", images: [expect.objectContaining({ name: "big.png", bytes: 500 }), expect.objectContaining({ name: "small.png" })] }]);
        expect(value(app)).toBe("next");
    });
    test("an image pasted during the wait isn't dropped as late: it stays with the next prompt", async () => {
        const { app, notices, dir, release, sent } = slowDraft();
        key(app, { name: "enter" });
        let releaseLater!: () => void;
        app.imagePrep = { run: fakeSips(new Promise<void>((r) => (releaseLater = r))).run, platform: "darwin" };
        writeFileSync(join(dir, "later.png"), png(9000, 1));
        paste(app, `${dir}/later.png`);
        release();
        await tick();
        expect(sent.map((s) => s.images.map((i) => i.name))).toEqual([["big.png", "small.png"]]);
        expect(notices.join()).not.toContain("wasn't ready");
        expect(value(app)).toBe("[Image #3] ");
        releaseLater();
        await settle(app);
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["later.png"]);
    });
});

describe("mentions of missing files", () => {
    test("800 missing mentions, alike or all different, take well under 200 ms", async () => {
        const cwd = tempDir();
        for (const text of [Array(800).fill("@missing.png").join(" "), Array.from({ length: 800 }, (_, i) => `@missing ${i}.png`).join(" ")]) {
            const started = performance.now();
            const r = await expandMentions(text, state(cwd), [cwd], checker(cwd));
            expect(performance.now() - started).toBeLessThan(200);
            expect(r.attached).toEqual([]);
        }
    });
    test("a spaced path still resolves, but never across the next mention or a line break", async () => {
        const cwd = tempDir();
        writeFileSync(join(cwd, "My Shot.png"), png());
        writeFileSync(join(cwd, "missing @My Shot.png"), png());
        const r = await expandMentions("@missing @My Shot.png", state(cwd), [cwd], checker(cwd));
        expect(r.attached).toEqual(["My Shot.png"]);
        writeFileSync(join(cwd, "two\nlines.png"), png());
        expect((await expandMentions("@two\nlines.png", state(cwd), [cwd], checker(cwd))).attached).toEqual([]);
    });
});

describe("commands that won't stop", () => {
    test("one ignoring SIGTERM is killed after the grace period and is gone when the runner returns", async () => {
        const f = join(tempDir(), "pid");
        const started = Date.now();
        expect(await img.runCommand(["sh", "-c", `echo $$ > '${f}'; trap "" TERM; sleep 5`], 200)).toBeUndefined();
        const took = Date.now() - started;
        expect(took).toBeGreaterThanOrEqual(200 + img.KILL_GRACE_MS - 20);
        expect(took).toBeLessThan(200 + img.KILL_GRACE_MS + 700);
        const pid = Number(readFileSync(f, "utf8"));
        expect(await goneSoon(pid)).toBe(true);
    });
    test("past the output cap it's killed, and the runner waits for it to exit", async () => {
        const f = join(tempDir(), "pid");
        const started = Date.now();
        // Ignores TERM and the closed pipe alike, so only the kill stops it.
        expect(await img.runCommand(["sh", "-c", `echo $$ > '${f}'; trap "" TERM PIPE; while :; do echo y 2>/dev/null; done`], 10_000, 4096)).toBeUndefined();
        expect(Date.now() - started).toBeGreaterThanOrEqual(img.KILL_GRACE_MS - 20);
        const pid = Number(readFileSync(f, "utf8"));
        expect(await goneSoon(pid)).toBe(true);
    });
    test("a timed-out command that exits cleanly on TERM still counts as failed, and what it started is gone", async () => {
        const dir = tempDir();
        const f = join(dir, "pid");
        const started = Date.now();
        const r = await img.runCommand(["sh", "-c", `sh -c 'trap "" TERM; echo $$ > "${f}"; exec sleep 30' > /dev/null & trap "exit 0" TERM; wait`], 300);
        expect(r).toBeUndefined();
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
        const pid = Number(readFileSync(f, "utf8"));
        expect(await goneSoon(pid)).toBe(true);
    });
    test("a helper still running when the harness exits goes with it", async () => {
        const dir = tempDir();
        const f = join(dir, "pid");
        const script = join(dir, "exit.ts");
        writeFileSync(script, `const img = await import(${JSON.stringify(join(import.meta.dir, "../src/ui/images.ts"))});\nvoid img.runCommand(["sh", "-c", "echo $$ > '${f}'; exec sleep 30"], 60_000);\nawait Bun.sleep(300);\nprocess.exit(0);\n`);
        const child = Bun.spawn([process.execPath, "--no-env-file", script], { stdout: "ignore", stderr: "ignore" });
        await child.exited;
        const pid = Number(readFileSync(f, "utf8"));
        expect(pid).toBeGreaterThan(0);
        await Bun.sleep(100);
        expect(await goneSoon(pid)).toBe(true);
    });
});

describe("editing the prompt in $VISUAL (Ctrl+G)", () => {
    async function edit(app: AppT, script?: string) {
        const saved = process.env.VISUAL;
        if (script) {
            const f = join(tempDir(), "edit.sh");
            writeFileSync(f, `#!/bin/sh\ncat > "$1" <<'EOF'\n${script}\nEOF\n`);
            chmodSync(f, 0o755);
            process.env.VISUAL = f;
        } else process.env.VISUAL = "true";
        try {
            await (app as any).externalEditor();
        } finally {
            if (saved === undefined) delete process.env.VISUAL;
            else process.env.VISUAL = saved;
        }
    }

    test("saving unchanged keeps the draft exactly, images included", async () => {
        const { app } = newApp();
        app.editor.insert("see ");
        app.editor.attachImage(image("a.png"));
        app.editor.paste("x\n".repeat(20));
        const before = app.editor.text;
        await edit(app);
        expect(app.editor.text).toBe(before);
        const sent = captureTurns(app);
        await submit(app);
        expect(sent[0]!.images.map((i) => i.name)).toEqual(["a.png"]);
    });
    test("an edit keeps each image whose label appears once, in the new order; duplicated, removed and typed labels are text", async () => {
        const { app } = newApp();
        app.editor.attachImage(image("old.png"));
        app.editor.clear();
        for (const n of ["a.png", "b.png", "c.png"]) {
            app.editor.insert(" ");
            app.editor.attachImage(image(n));
        }
        app.editor.insert(" [Image #1]");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["a.png", "b.png", "c.png"]);
        await edit(app, "B [Image #3] A [Image #2] dup [Image #4][Image #4] typed [Image #1] [Image #9]");
        expect(value(app)).toBe("B [Image #3] A [Image #2] dup [Image #4][Image #4] typed [Image #1] [Image #9]");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["b.png", "a.png"]);
        const sent = captureTurns(app);
        await submit(app);
        expect(sent[0]!.images.map((i) => i.name)).toEqual(["b.png", "a.png"]);
    });
});

describe("slash commands with images", () => {
    test("/review takes the images typed with it into its turn", async () => {
        const { app } = newApp();
        const turns: { display?: string; images: string[] }[] = [];
        app.startTurn = (async (_t: string, opts: any = {}) => {
            turns.push({ display: opts.display, images: opts.draft ? imagesIn(opts.draft.text, opts.draft.attachments).map((i) => i.name) : [] });
        }) as any;
        app.editor.insert("/review ");
        app.editor.attachImage(image("bug.png"));
        await submit(app);
        expect(turns).toEqual([{ display: "/review [Image #1]", images: ["bug.png"] }]);
        expect(value(app)).toBe("");
    });
    test("a command that can't use images isn't run, and the draft stays with its images", async () => {
        const { app, notices } = newApp();
        const sent = captureTurns(app);
        const title = app.session.meta.title;
        app.editor.insert("/rename ");
        app.editor.attachImage(image("pic.png"));
        await submit(app);
        expect(sent).toEqual([]);
        expect(app.session.meta.title).toBe(title);
        expect(notices.join()).toContain("/rename can't take images");
        expect(value(app)).toBe("/rename [Image #1]");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["pic.png"]);
    });
});

describe("history keeps images in memory", () => {
    const key = (app: AppT, k: object) => (app as any).onKey(k);
    test("↑ after sending an image prompt brings the image back; history on disk stays plain text", async () => {
        const cwd = tempDir();
        const { app } = newApp(cwd);
        const sent = captureTurns(app);
        app.editor.insert("see ");
        app.editor.attachImage(image("a.png"));
        await submit(app);
        app.editor.attachImage(image("b.png"));
        app.editor.clear();
        key(app, { name: "up" });
        expect(value(app)).toBe("see [Image #1]");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["a.png"]);
        await submit(app);
        expect(sent.map((s) => s.images.map((i) => i.name))).toEqual([["a.png"], ["a.png"]]);
        const { loadPromptHistory } = await import("../src/agent/session");
        expect(loadPromptHistory(cwd).at(-1)).toBe("see [Image #1]");
    });
    test("a cancelled waiting prompt recalled from history has its images", async () => {
        const { app, notices } = newApp();
        const dir = tempDir();
        writeFileSync(join(dir, "big.png"), png(9000, 1));
        let release!: () => void;
        app.imagePrep = { run: fakeSips(new Promise<void>((r) => (release = r))).run, platform: "darwin" };
        paste(app, `${dir}/big.png`);
        app.editor.insert("original");
        const sent = captureTurns(app);
        key(app, { name: "enter" });
        for (const ch of "other") key(app, { name: "text", text: ch });
        key(app, { name: "escape" });
        release();
        await settle(app);
        await new Promise((r) => setTimeout(r, 10));
        expect(notices.join()).toContain("in history (↑)");
        key(app, { name: "up" });
        expect(value(app)).toBe("[Image #1] original");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["big.png"]);
        await submit(app);
        expect(sent.map((s) => s.images.map((i) => i.name))).toEqual([["big.png"]]);
    });
    test(`only the last ${HISTORY_IMAGES} entries keep their images; older ones recall as text`, () => {
        const e = new Editor();
        e.insert("pic ");
        e.attachImage(image("a.png"));
        const d = e.capture();
        e.pushHistory(plainText(d.text), d);
        e.clear();
        for (let i = 1; i < HISTORY_IMAGES; i++) e.pushHistory(`p${i}`);
        for (let i = 0; i < HISTORY_IMAGES; i++) e.historyPrev();
        expect(e.attachedImages().map((i) => i.name)).toEqual(["a.png"]);
        e.clear();
        e.pushHistory("one more");
        for (let i = 0; i <= HISTORY_IMAGES; i++) e.historyPrev();
        expect(e.text).toBe("pic [Image #1]");
        expect(e.attachedImages()).toEqual([]);
    });
});

describe("a submission whose only image never arrives", () => {
    function pendingClipboard(result: Promise<unknown>) {
        const { app, notices } = newApp();
        app.imagePrep = { run: async () => (await result, { code: 1, stdout: Buffer.alloc(0) }), platform: "darwin" };
        (app as any).onKey({ name: "v", ctrl: true });
        expect(value(app)).toBe("[Image #1]");
        return { app, notices, sent: captureTurns(app) };
    }
    test("an empty clipboard: no turn starts", async () => {
        let release!: () => void;
        const { app, sent } = pendingClipboard(new Promise<void>((r) => (release = r)));
        const done = submit(app);
        release();
        await done;
        expect(sent).toEqual([]);
        expect(value(app)).toBe("");
        expect((app as any).flash.text).toBe("No image on the clipboard");
    });
    test("past the wait bound: no turn starts", async () => {
        const { app, notices, sent } = pendingClipboard(new Promise(() => {}));
        app.attachWaitMs = 20;
        await submit(app);
        expect(sent).toEqual([]);
        expect(value(app)).toBe("");
        expect(notices.join()).toContain("Image #1 wasn't ready in time");
    });
});

describe("busy slash commands keep their drafts", () => {
    test("/plan with a task and an image is queued with the image, and runs after the turn", async () => {
        const { app, notices } = newApp();
        const sent = captureTurns(app);
        app.print = () => {};
        app.busy = true;
        app.editor.insert("/plan ");
        app.editor.attachImage(image("plan.png"));
        await submit(app);
        expect(notices).toEqual([]);
        expect(value(app)).toBe("");
        app.busy = false;
        await app.submitText((app as any).queued.shift());
        expect(sent).toEqual([{ text: "[Image #1]", images: [expect.objectContaining({ name: "plan.png" })] }]);
    });
    test("a refused command goes back to the prompt", async () => {
        const { app, notices } = newApp();
        app.busy = true;
        app.editor.insert("/plan");
        await submit(app);
        expect(notices.join()).toContain("/plan isn't available while");
        expect(value(app)).toBe("/plan");
    });
    test("an unknown command keeps its images", async () => {
        const { app } = newApp();
        app.editor.insert("/nosuch ");
        app.editor.attachImage(image("x.png"));
        await submit(app);
        expect(value(app)).toBe("/nosuch [Image #1]");
        expect(app.editor.attachedImages().map((i) => i.name)).toEqual(["x.png"]);
    });
});

describe("a placeholder yanked twice", () => {
    function twice() {
        const e = new Editor();
        e.insert("see ");
        const uid = e.attachImage(image("a.png"));
        e.killToStart();
        e.yank();
        e.yank();
        return { e, uid };
    }
    test("sends its image once, at the first occurrence", () => {
        const { e } = twice();
        expect(plainText(e.text)).toBe("see [Image #1]see [Image #1]");
        expect(e.attachedImages().map((i) => i.name)).toEqual(["a.png"]);
    });
    test("dropImage and withoutImage replace every copy", () => {
        const { e, uid } = twice();
        const d = e.capture();
        withoutImage(d, uid, "x");
        expect(plainText(d.text)).toBe("see xsee x");
        e.dropImage(uid, "y");
        expect(e.text).toBe("see ysee y");
        expect(e.cursor).toBe(e.text.length);
    });
});

describe("a command's process group", () => {
    test("a TERM-resistant grandchild holding stdout is killed by the time the runner returns", async () => {
        const f = join(tempDir(), "gpid");
        const grandchild = `trap '' TERM; echo \\$\\$ > '${f}'; echo \\$\\$; exec sleep 5`;
        const started = Date.now();
        expect(await img.runCommand(["sh", "-c", `echo $$ > '${f}.parent'; sh -c "${grandchild}" & wait`], 200)).toBeUndefined();
        expect(Date.now() - started).toBeGreaterThanOrEqual(200 + img.KILL_GRACE_MS - 20);
        const gpid = Number(readFileSync(f, "utf8"));
        expect(gpid).not.toBe(Number(readFileSync(`${f}.parent`, "utf8")));
        expect(await goneSoon(gpid)).toBe(true);
    });
});
