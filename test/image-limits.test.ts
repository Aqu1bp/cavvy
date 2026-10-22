// Images on their way to a model, from every source (a prompt's attachments,
// the Read tool, an MCP tool, a resumed history): fitted to the providers'
// limits (2000px a side, 5 MB as base64, so a request with more than 20 is
// fine too), never sent to a model known to be text-only, and left out when a
// provider refuses them, instead of failing every later turn.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { deflateSync, inflateSync } from "zlib";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Agent, isImageRejection } = await import("../src/agent/agent");
const { PermissionChecker } = await import("../src/permissions/checker");
const { ReadTool } = await import("../src/tools/file-tools");
const { formatMcpResult } = await import("../src/mcp/manager");
const { Session } = await import("../src/agent/session");
const { ProviderError } = await import("../src/providers/types");
const { toAnthropicMessages } = await import("../src/providers/anthropic");
const { toOpenAIMessages } = await import("../src/providers/openai-compat");
const { getProvider } = await import("../src/providers/registry");
const { IMAGE_BASE64, IMAGE_PIXELS, IMAGE_SIDE, fitContent, fitImage, imageFits } = await import("../src/providers/images");
const { forkSession } = await import("../src/agent/fork");
const { imageSize } = await import("../src/ui/images");
import type { ImagePart, Message, UserContent } from "../src/providers/types";

afterAll(iso.cleanup);

function pngChunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
    return Buffer.concat([head, data, crc]);
}

/** A real RGB PNG: black, or random noise (which doesn't compress). */
function png(w: number, h: number, noise = false): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    if (noise) {
        for (let y = 0; y < h; y++) crypto.getRandomValues(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)));
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 1 })), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A real RGBA PNG of noise, its left half fully transparent (black linework on transparency, say). */
function transparentPng(w: number, h: number): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        const row = raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
        for (let i = 0; i < row.length; i += 65536) crypto.getRandomValues(row.subarray(i, Math.min(row.length, i + 65536)));
        for (let x = 0; x < w; x++) row[x * 4 + 3] = x < w / 2 ? 0 : 255;
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 1 })), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A pixel's alpha, from any image Bun decodes (255 for one without an alpha channel). */
async function alphaAt(p: ImagePart, x: number, y: number): Promise<number> {
    const b = Buffer.from(await new Bun.Image(Buffer.from(p.data, "base64")).png({ compressionLevel: 0 }).bytes());
    const w = b.readUInt32BE(16);
    const type = b[25];
    const bpp = type === 6 ? 4 : type === 2 ? 3 : type === 4 ? 2 : 1;
    const idat: Buffer[] = [];
    for (let at = 8; at < b.length; at += 12 + b.readUInt32BE(at)) if (b.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(b.subarray(at + 8, at + 8 + b.readUInt32BE(at)));
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * bpp;
    let prev = Buffer.alloc(stride);
    let row = prev;
    for (let r = 0; r <= y; r++) {
        const filter = raw[r * (stride + 1)]!;
        row = Buffer.from(raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1)));
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? row[i - bpp]! : 0;
            const up = prev[i]!;
            const c = i >= bpp ? prev[i - bpp]! : 0;
            const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
            const add = filter === 1 ? a : filter === 2 ? up : filter === 3 ? (a + up) >> 1 : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? up : c) : 0;
            row[i] = (row[i]! + add) & 0xff;
        }
        prev = row;
    }
    return type === 6 ? row[x * 4 + 3]! : type === 4 ? row[x * 2 + 1]! : 255;
}

/** Bun.Image with every decode counted, and the most running at once. */
function spyOnDecodes() {
    const Real = Bun.Image;
    const seen = { made: 0, running: 0, most: 0, maxPixels: [] as (number | undefined)[] };
    class Spy extends Real {
        constructor(input: ConstructorParameters<typeof Real>[0], options?: ConstructorParameters<typeof Real>[1]) {
            super(input, options);
            seen.made++;
            seen.maxPixels.push(options?.maxPixels);
        }
        override async bytes() {
            seen.most = Math.max(seen.most, ++seen.running);
            try {
                return await super.bytes();
            } finally {
                seen.running--;
            }
        }
    }
    (Bun as { Image: typeof Real }).Image = Spy;
    return { seen, restore: () => ((Bun as { Image: typeof Real }).Image = Real) };
}

const part = (b: Uint8Array, mediaType = "image/png"): ImagePart => ({ type: "image", mediaType, data: Buffer.from(b).toString("base64") });
const sizeOf = (p: ImagePart) => imageSize(Buffer.from(p.data, "base64"))!;
const longSide = (p: ImagePart) => Math.max(sizeOf(p).width, sizeOf(p).height);

/** Every image a request carries: in prompts and in tool results. */
function imagesIn(messages: Message[]): ImagePart[] {
    return messages.flatMap((m) => (m.role === "user" ? m.content.flatMap((p) => (p.type === "image" ? [p] : p.type === "tool_result" ? (p.images ?? []) : [])) : []));
}
const textOf = (messages: Message[]) => JSON.stringify(messages.map((m) => (m.role === "user" ? m.content.map((p) => (p.type === "text" ? p.text : p.type === "tool_result" ? p.content : "")) : "")));

type Reply = { text?: string; call?: { name: string; input: Record<string, unknown> } } | Error;

/** A model that answers from a script and keeps every request it was sent. */
function scripted(replies: Reply[]) {
    const requests: Message[][] = [];
    let n = 0;
    const client = {
        stream: async (req: { messages: Message[] }) => {
            requests.push(req.messages);
            const r = replies[n++] ?? { text: "ok" };
            if (r instanceof Error) throw r;
            const content = r.call ? [{ type: "tool_call", id: `c${n}`, name: r.call.name, input: r.call.input }] : [{ type: "text", text: r.text ?? "ok" }];
            return { role: "assistant", provider: "test", model: "test", stopReason: r.call ? "tool_use" : "end_turn", content };
        },
    };
    return { client, requests };
}

function agentWith(o: { client: unknown; proj?: string; session?: InstanceType<typeof Session>; supportsImages?: boolean; tools?: unknown[]; allow?: string[] }) {
    const proj = o.proj ?? tempDir();
    const settings = { autoCompact: false, permissions: { allow: o.allow ?? [] } } as never;
    const session = o.session ?? Session.create(proj, { persist: false });
    const notices: string[] = [];
    const agent = new Agent({
        session,
        model: { provider: "test", id: "test", ...(o.supportsImages !== undefined ? { supportsImages: o.supportsImages } : {}) } as never,
        client: o.client as never,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, proj),
        tools: (o.tools ?? []) as never,
        mode: { get: () => "default", set() {} },
        toolState: { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() } as never,
        host: { emit: (e: { type: string; message?: string }) => e.type === "notice" && notices.push(e.message ?? ""), ui: {}, askPermission: async () => ({ allow: false }) } as never,
    });
    return { agent, session, notices, proj };
}
const run = (agent: InstanceType<typeof Agent>, content: UserContent[]) => agent.run(content, { signal: new AbortController().signal });

/** A stand-in for a browser MCP server's screenshot tool, its result shaped as MCP tools' are. */
const screenshotTool = (shot: Buffer) => ({
    name: "mcp__browser__screenshot",
    description: "Take a screenshot",
    parameters: { type: "object", properties: {} },
    category: "mcp",
    readOnly: true,
    title: () => "screenshot",
    run: async () => formatMcpResult({ content: [{ type: "text", text: "Here it is" }, { type: "image", mimeType: "image/png", data: shot.toString("base64") }] } as never),
});

describe("fitting one image", () => {
    test("too tall: scaled down to 2000px a side, aspect ratio kept, still a PNG", async () => {
        const fitted = (await fitImage(part(png(1280, 9000))))!;
        expect(fitted.mediaType).toBe("image/png");
        expect(sizeOf(fitted)).toEqual({ width: 284, height: 2000 });
        expect(imageFits(fitted)).toBe(true);
    });
    test("one that fits is left exactly as it is; one labelled as another type is relabelled, not re-encoded", async () => {
        const small = part(png(800, 600));
        expect(imageFits(small)).toBe(true);
        expect(await fitImage(small)).toBe(small);
        const jpeg = await new Bun.Image(png(64, 32)).jpeg().bytes();
        const mislabelled = part(jpeg, "image/png");
        expect(imageFits(mislabelled)).toBe(false);
        expect(await fitImage(mislabelled)).toEqual({ ...mislabelled, mediaType: "image/jpeg" });
    });
    test("too heavy at a size that's within the limit: re-encoded as a JPEG under 5 MB of base64", async () => {
        const noisy = part(png(2000, 2000, true));
        expect(noisy.data.length).toBeGreaterThan(IMAGE_BASE64);
        const fitted = (await fitImage(noisy))!;
        expect(fitted.mediaType).toBe("image/jpeg");
        expect(fitted.data.length).toBeLessThanOrEqual(IMAGE_BASE64);
        expect(longSide(fitted)).toBeLessThanOrEqual(IMAGE_SIDE);
    }, 30_000);
    test("bytes that aren't an image can't be fitted", async () => {
        expect(await fitImage(part(Buffer.from("not an image at all")))).toBeUndefined();
        expect(await fitImage(part(png(10, 10).subarray(0, 20)))).toBeUndefined();
    });
    test("a PNG cut short after its header isn't sent as it is: its header fits, its pixels don't decode", async () => {
        const cut = part(png(10, 10).subarray(0, 33));
        expect(imageFits(cut)).toBe(true);
        expect(await fitImage(cut)).toBeUndefined();
        // Decoded once: asked again, it's the same answer without decoding again.
        const { seen, restore } = spyOnDecodes();
        try {
            expect(await fitImage(cut)).toBeUndefined();
            expect(seen.made).toBe(0);
        } finally {
            restore();
        }
    });
    test("transparent and too heavy: re-encoded keeping its transparency (a WebP, not a JPEG that turns it black)", async () => {
        const clear = part(transparentPng(2000, 2000));
        expect(clear.data.length).toBeGreaterThan(IMAGE_BASE64);
        expect(await alphaAt(clear, 10, 10)).toBe(0);
        const fitted = (await fitImage(clear))!;
        expect(fitted.mediaType).toBe("image/webp");
        expect(fitted.data.length).toBeLessThanOrEqual(IMAGE_BASE64);
        expect(await alphaAt(fitted, 10, 10)).toBe(0);
        expect(await alphaAt(fitted, 1990, 10)).toBe(255);
    }, 30_000);
    test("decoding is bounded: an image over IMAGE_PIXELS isn't decoded at all, and a batch is decoded one image at a time", async () => {
        // A header claiming 8000×7000 (56 megapixels): 200 MB and more to decode, whatever the file's size.
        const huge = png(8000, 10);
        huge.writeUInt32BE(7000, 20);
        expect(8000 * 7000).toBeGreaterThan(IMAGE_PIXELS);
        const { seen, restore } = spyOnDecodes();
        try {
            expect(await fitImage(part(huge))).toBeUndefined();
            expect(seen.made).toBe(0);
            const batch = await fitContent([png(3000, 100), png(100, 3000), png(2500, 2500), png(2100, 50)].map((b) => part(b)));
            expect(batch.every((p) => p.type === "image" && imageFits(p))).toBe(true);
            expect(seen.made).toBeGreaterThanOrEqual(4);
            expect(seen.most).toBe(1);
            // Bun refuses a bigger canvas itself, before allocating it, where the header couldn't be read here.
            expect(seen.maxPixels.every((n) => n === IMAGE_PIXELS)).toBe(true);
        } finally {
            restore();
        }
    }, 30_000);
});

describe("every source is fitted before it's stored or sent", () => {
    test("a prompt's image (GUI attachment, paste, terminal): sent and stored within the limits", async () => {
        const { client, requests } = scripted([{ text: "seen" }]);
        const { agent, session } = agentWith({ client });
        expect(await run(agent, [{ type: "text", text: "look" }, part(png(1280, 9000))])).toBe("done");
        const [sent] = imagesIn(requests[0]!);
        expect(sizeOf(sent!)).toEqual({ width: 284, height: 2000 });
        // The history holds the fitted copy, so later turns resend that, not the original.
        expect(imagesIn(session.messages)[0]!.data).toBe(sent!.data);
    });
    test("Read: a Retina screenshot is shrunk on its way to the model; the file on disk is untouched", async () => {
        const proj = tempDir();
        const file = join(proj, "shot.png");
        const original = png(2880, 1800);
        writeFileSync(file, original);
        const { client, requests } = scripted([{ call: { name: "Read", input: { file_path: file } } }, { text: "done" }]);
        const { agent, session } = agentWith({ client, proj, tools: [ReadTool] });
        expect(await run(agent, [{ type: "text", text: "read it" }])).toBe("done");
        const [sent] = imagesIn(requests[1]!);
        expect(sizeOf(sent!)).toEqual({ width: 2000, height: 1250 });
        expect(imagesIn(session.messages)[0]!.data).toBe(sent!.data);
        expect(readFileSync(file).equals(original)).toBe(true);
    });
    test("Read types an image by its bytes: a .png that's a JPEG goes as a JPEG, and a .png that isn't an image is an error", async () => {
        const proj = tempDir();
        writeFileSync(join(proj, "photo.png"), await new Bun.Image(png(40, 20)).jpeg().bytes());
        writeFileSync(join(proj, "fake.png"), "hello");
        const ctx = { state: { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() }, settings: {}, signal: new AbortController().signal } as never;
        const r = await ReadTool.run({ file_path: join(proj, "photo.png") }, ctx);
        expect(r.images?.[0]?.mediaType).toBe("image/jpeg");
        const bad = await ReadTool.run({ file_path: join(proj, "fake.png") }, ctx);
        expect(bad.isError).toBe(true);
        expect(bad.images).toBeUndefined();
    });
    test("an MCP tool's screenshot is shrunk too, and one that can't be read becomes a line in the result", async () => {
        const { client, requests } = scripted([{ call: { name: "mcp__browser__screenshot", input: {} } }, { text: "done" }]);
        const { agent } = agentWith({ client, tools: [screenshotTool(png(1280, 9000))], allow: ["mcp__browser__screenshot"] });
        expect(await run(agent, [{ type: "text", text: "screenshot" }])).toBe("done");
        expect(sizeOf(imagesIn(requests[1]!)[0]!)).toEqual({ width: 284, height: 2000 });

        const broken = scripted([{ call: { name: "mcp__browser__screenshot", input: {} } }, { text: "done" }]);
        const b = agentWith({ client: broken.client, tools: [screenshotTool(Buffer.from("garbage"))], allow: ["mcp__browser__screenshot"] });
        expect(await run(b.agent, [{ type: "text", text: "screenshot" }])).toBe("done");
        expect(imagesIn(broken.requests[1]!)).toEqual([]);
        expect(textOf(broken.requests[1]!)).toContain("Here it is\\n[An image this returned isn't included: it couldn't be read as a PNG, JPEG, GIF or WebP image of at most 50 megapixels.]");
    });
    test("a broken attachment beside a good one: the good one goes, the broken one is a note, and nothing is refused", async () => {
        const { client, requests } = scripted([{ text: "seen" }]);
        const { agent, notices } = agentWith({ client });
        expect(await run(agent, [{ type: "text", text: "look" }, part(png(40, 40)), part(png(10, 10).subarray(0, 33))])).toBe("done");
        expect(requests.length).toBe(1);
        expect(imagesIn(requests[0]!).length).toBe(1);
        expect(textOf(requests[0]!)).toContain("[An image the user attached isn't included: it couldn't be read");
        expect(notices.join("\n")).not.toContain("refused");
    });
    test("a resumed history stored before images were fitted is fitted when it's sent; the transcript keeps the original", async () => {
        const session = Session.create(tempDir(), { persist: false });
        const big = part(png(9000, 1200));
        session.push({ role: "user", content: [{ type: "text", text: "earlier" }, big], meta: { kind: "prompt" } });
        session.push({ role: "assistant", provider: "test", model: "test", stopReason: "end_turn", content: [{ type: "text", text: "ok" }] } as never);
        const { client, requests } = scripted([{ text: "a" }, { text: "b" }]);
        const { agent } = agentWith({ client, session });
        await run(agent, [{ type: "text", text: "again" }]);
        await run(agent, [{ type: "text", text: "and again" }]);
        const first = imagesIn(requests[0]!)[0]!;
        expect(sizeOf(first)).toEqual({ width: 2000, height: 267 });
        // The same bytes every time (prompt caches match on prefix).
        expect(imagesIn(requests[1]!)[0]!.data).toBe(first.data);
        expect(imagesIn(session.messages)[0]!.data).toBe(big.data);
    });
});

describe("Anthropic's many-image rule", () => {
    test("21 Retina screenshots read one after another: no request carries an image over 2000px, however many it has", async () => {
        const proj = tempDir();
        const shot = png(2880, 1800);
        const replies: Reply[] = [];
        for (let i = 0; i < 21; i++) {
            writeFileSync(join(proj, `shot${i}.png`), shot);
            replies.push({ call: { name: "Read", input: { file_path: join(proj, `shot${i}.png`) } } });
        }
        replies.push({ text: "done" });
        const { client, requests } = scripted(replies);
        const { agent } = agentWith({ client, proj, tools: [ReadTool] });
        expect(await run(agent, [{ type: "text", text: "read them all" }])).toBe("done");
        const last = imagesIn(requests.at(-1)!);
        expect(last.length).toBe(21);
        expect(Math.max(...requests.flatMap((r) => imagesIn(r).map(longSide)))).toBeLessThanOrEqual(2000);
        // As Anthropic is sent them: 21 image blocks inside tool_result content, each within the stricter limit.
        const blocks = JSON.stringify(toAnthropicMessages(requests.at(-1)!)).match(/"type":"image"/g) ?? [];
        expect(blocks.length).toBe(21);
    }, 60_000);
});

describe("models known to be text-only", () => {
    const history = async (supportsImages: boolean | undefined) => {
        const proj = tempDir();
        writeFileSync(join(proj, "shot.png"), png(100, 100));
        const { client, requests } = scripted([{ call: { name: "Read", input: { file_path: join(proj, "shot.png") } } }, { text: "done" }, { text: "later" }]);
        const { agent, session } = agentWith({ client, proj, tools: [ReadTool], supportsImages });
        await run(agent, [{ type: "text", text: "what's this" }, part(png(50, 50))]);
        await run(agent, [{ type: "text", text: "and now" }]);
        return { requests, session };
    };
    test("get a note for each attached and tool-returned image, on every request; the transcript keeps them", async () => {
        const { requests, session } = await history(false);
        for (const r of requests) expect(imagesIn(r)).toEqual([]);
        const later = requests.at(-1)!;
        expect(textOf(later)).toContain("[The user attached an image, but this model can't read images, so it isn't included.]");
        expect(textOf(later)).toContain("[An image this returned isn't included: this model can't read images.]");
        // As an OpenAI-compatible provider (Groq, DeepSeek) is sent it: no image_url part at all.
        expect(JSON.stringify(toOpenAIMessages("", later, getProvider("groq")!))).not.toContain("image_url");
        expect(imagesIn(session.messages).length).toBe(2);
    });
    test("a model whose image support isn't known is sent the images", async () => {
        const { requests } = await history(undefined);
        expect(imagesIn(requests.at(-1)!).length).toBe(2);
    });
});

describe("a request refused for its images", () => {
    const tooBig = () => new ProviderError("messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes", 400);

    test("is sent again without them, once; later turns don't carry them, but new images go", async () => {
        const { client, requests } = scripted([tooBig(), { text: "answered without it" }, { text: "fine" }]);
        const { agent, session, notices } = agentWith({ client });
        expect(await run(agent, [{ type: "text", text: "look" }, part(png(100, 100))])).toBe("done");
        expect(requests.length).toBe(2);
        expect(imagesIn(requests[1]!)).toEqual([]);
        expect(textOf(requests[1]!)).toContain("[An image the user attached isn't included any more: the provider rejected a request carrying it.]");
        expect(notices.join("\n")).toContain("sending it again without them");
        // The next turn: the refused image stays out, a new one goes.
        expect(await run(agent, [{ type: "text", text: "this one?" }, part(png(30, 30))])).toBe("done");
        expect(imagesIn(requests[2]!).length).toBe(1);
        expect(sizeOf(imagesIn(requests[2]!)[0]!)).toEqual({ width: 30, height: 30 });
        // The transcript keeps both.
        expect(imagesIn(session.messages).length).toBe(2);
    });
    test("refused again, the turn ends on the error instead of looping", async () => {
        const { client, requests } = scripted([tooBig(), tooBig()]);
        const { agent } = agentWith({ client });
        expect(await run(agent, [{ type: "text", text: "look" }, part(png(100, 100))])).toBe("error");
        expect(requests.length).toBe(2);
    });
    test("compaction falls back to a text transcript when its request is refused for images", async () => {
        const session = Session.create(tempDir(), { persist: false });
        session.push({ role: "user", content: [{ type: "text", text: "fix the header" }, part(png(100, 100))], meta: { kind: "prompt" } });
        session.push({ role: "assistant", provider: "test", model: "test", stopReason: "end_turn", content: [{ type: "text", text: "ok" }] } as never);
        const { client, requests } = scripted([tooBig(), { text: "1. Primary request: fix the header" }]);
        const { agent } = agentWith({ client, session });
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        expect(imagesIn(requests[1]!)).toEqual([]);
        expect(JSON.stringify(session.messages)).toContain("Primary request: fix the header");
    });
    test("which errors count: image ones, not context overflow, a tool's schema, or unrelated 400s", () => {
        expect(isImageRejection(tooBig())).toBe(true);
        expect(isImageRejection(new ProviderError("messages.0.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels", 400))).toBe(true);
        expect(isImageRejection(new ProviderError("At least one of the image dimensions exceed max allowed size: 8000 pixels", 400))).toBe(true);
        expect(isImageRejection(new ProviderError("Invalid schema for function image_lookup: unsupported keyword", 400))).toBe(false);
        expect(isImageRejection(new ProviderError("Invalid schema for function 'image': unsupported keyword 'format'", 400))).toBe(false);
        expect(isImageRejection(new ProviderError("tools.2.custom.input_schema: invalid image property", 400))).toBe(false);
        expect(isImageRejection(new ProviderError("messages.3.content.0.image: many-image requests may not exceed 2000 pixels", 400))).toBe(true);
        expect(isImageRejection(new ProviderError("Image does not match the provided media type image/png", 400))).toBe(true);
        expect(isImageRejection(new ProviderError("unknown variant `image_url`, expected `text`", 400))).toBe(true);
        expect(isImageRejection(new ProviderError("No endpoints found that support image input", 404))).toBe(true);
        expect(isImageRejection(new ProviderError("prompt is too long: 250000 tokens > 200000 maximum", 400))).toBe(false);
        expect(isImageRejection(new ProviderError("max_tokens: must be at most 64000", 400))).toBe(false);
        expect(isImageRejection(new ProviderError("image exceeds 5 MB maximum", 500))).toBe(false);
    });
    test("a retry that fails too keeps nothing out: the next turn sends the images again", async () => {
        const unrelated = new ProviderError("max_tokens: must be at most 64000", 400);
        const { client, requests } = scripted([tooBig(), unrelated, { text: "fine" }]);
        const { agent, session } = agentWith({ client });
        expect(await run(agent, [{ type: "text", text: "look" }, part(png(100, 100))])).toBe("error");
        expect(await run(agent, [{ type: "text", text: "again" }])).toBe("done");
        expect(requests.map((r) => imagesIn(r).length)).toEqual([1, 0, 1]);
        expect(session.messages.some((m) => m.role === "user" && m.meta?.imagesRefused)).toBe(false);
    });
    test("refused by one model only: a model that reads images is sent them again, the one that refused isn't", async () => {
        const noImages = () => new ProviderError("No endpoints found that support image input", 404);
        const { client, requests } = scripted([noImages(), { text: "without" }, { text: "with" }, { text: "without again" }]);
        const { agent } = agentWith({ client });
        await run(agent, [{ type: "text", text: "look" }, part(png(100, 100))]);
        agent.setModel({ provider: "test", id: "vision", supportsImages: true } as never, client as never);
        await run(agent, [{ type: "text", text: "and you?" }]);
        agent.setModel({ provider: "test", id: "test" } as never, client as never);
        await run(agent, [{ type: "text", text: "back" }]);
        expect(requests.map((r) => imagesIn(r).length)).toEqual([1, 0, 1, 0]);
    });
    test("kept for that model when the session is opened again or forked, and the images stay in the transcript", async () => {
        const proj = tempDir();
        const session = Session.create(proj);
        const image = part(png(100, 100));
        // Answered with the image once; refused for it on the next turn, after the turn a fork is cut at.
        const { client, requests } = scripted([{ text: "seen" }, tooBig(), { text: "without" }, { text: "resumed" }, { text: "forked" }, { text: "other model" }, { text: "cut" }]);
        const { agent } = agentWith({ client, proj, session });
        await run(agent, [{ type: "text", text: "look" }, image]);
        await run(agent, [{ type: "text", text: "more" }]);
        expect(requests.map((r) => imagesIn(r).length)).toEqual([1, 1, 0]);

        const opened = Session.load(session.path);
        expect(imagesIn(opened.messages)[0]!.data).toBe(image.data);
        await run(agentWith({ client, proj, session: opened }).agent, [{ type: "text", text: "resumed" }]);
        await run(agentWith({ client, proj, session: session.fork({ persist: false }) }).agent, [{ type: "text", text: "forked" }]);
        const other = agentWith({ client, proj, session: Session.load(session.path) }).agent;
        other.setModel({ provider: "test", id: "vision", supportsImages: true } as never, client as never);
        await run(other, [{ type: "text", text: "other model" }]);
        expect(requests.slice(3).map((r) => imagesIn(r).length)).toEqual([0, 0, 1]);

        // A fork cut before the refusal was recorded still has it (and the saved history still matches).
        const cut = forkSession(session, { cut: 2 });
        expect(imagesIn(cut.messages)[0]!.data).toBe(image.data);
        await run(agentWith({ client, proj, session: cut }).agent, [{ type: "text", text: "cut" }]);
        expect(imagesIn(requests.at(-1)!).length).toBe(0);
    });
});
