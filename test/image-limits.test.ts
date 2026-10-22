// Images on their way to a model, from every source (a prompt's attachments,
// the Read tool, an MCP tool, a resumed history): fitted to the providers'
// limits (2000px a side, 5 MB as base64, so a request with more than 20 is
// fine too), never sent to a model known to be text-only, and left out when a
// provider refuses them, instead of failing every later turn.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { deflateSync } from "zlib";
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
const { IMAGE_BASE64, IMAGE_SIDE, fitImage, imageFits } = await import("../src/providers/images");
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
        expect(textOf(broken.requests[1]!)).toContain("Here it is\\n[An image this returned isn't included: it couldn't be read as a PNG, JPEG, GIF or WebP image.]");
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
    test("which errors count: image ones, not context overflow or unrelated 400s", () => {
        expect(isImageRejection(tooBig())).toBe(true);
        expect(isImageRejection(new ProviderError("messages.3.content.0.image: many-image requests may not exceed 2000 pixels", 400))).toBe(true);
        expect(isImageRejection(new ProviderError("Image does not match the provided media type image/png", 400))).toBe(true);
        expect(isImageRejection(new ProviderError("unknown variant `image_url`, expected `text`", 400))).toBe(true);
        expect(isImageRejection(new ProviderError("No endpoints found that support image input", 404))).toBe(true);
        expect(isImageRejection(new ProviderError("prompt is too long: 250000 tokens > 200000 maximum", 400))).toBe(false);
        expect(isImageRejection(new ProviderError("max_tokens: must be at most 64000", 400))).toBe(false);
        expect(isImageRejection(new ProviderError("image exceeds 5 MB maximum", 500))).toBe(false);
    });
});
