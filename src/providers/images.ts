// Every image on its way to a model, from wherever it came (a prompt's
// attachments, a paste, the Read tool, an MCP tool, a resumed history):
// fitted to what providers take, or a note in its place.
//
// Anthropic's limits (https://platform.claude.com/docs/en/build-with-claude/vision,
// 2026-10): 8000px a side; in a request with more than 20 images, every image
// at most 2000px a side (resent and tool_result images count); 10 MB as base64
// on its API, 5 MB on Bedrock and Google Cloud (where OpenRouter may route a
// Claude model). The other providers' docs (checked 2026-10-22) give looser
// per-image limits or none (Vertex: 7 MB inline), so one target serves them
// all: at most 2000px a side and 5 MB as base64.
// An image is fitted once, as it enters the conversation, so what's stored
// (and resent every turn) already fits, and the 20-image threshold never
// changes what an earlier image looks like (prompt caches match on prefix).
// Types: providers list different ones (registry.ts `imageTypes`, from their
// docs); PNG and JPEG are on every list, so fitting only ever changes an
// image into one of those (a transparent one into a PNG, never a JPEG, which
// would turn it black, nor a WebP, which xAI, Fireworks and Cerebras don't
// list). What's stored doesn't depend on the provider: an image of a type the
// provider in use doesn't list (a pasted WebP or GIF) is re-encoded when it's
// sent. A provider whose docs give a total for a request's images (Fireworks,
// Cerebras) is sent the newest images within it.
// The file it came from is never touched. Decoding takes memory by pixels,
// not by file size (a 1 MB PNG can be a 36-megapixel canvas), so there's a
// limit on those too, and images are decoded one at a time.

import type { ImagePart, Message, ToolResultPart, UserContent } from "./types";
import { imageSize } from "../ui/images";
import { sniffImage } from "../util/files";

/** The long side every image is brought within (Anthropic's limit for requests with more than 20 images). */
export const IMAGE_SIDE = 2000;
/** An image's base64 at most (Anthropic on Bedrock and Google Cloud). */
export const IMAGE_BASE64 = 5 * 1024 * 1024;
/** Pixels an image may have to be decoded at all (about 200 MB as RGBA): a 48-megapixel phone photo is within it. */
export const IMAGE_PIXELS = 50_000_000;

const ENCODINGS = ["png", "jpeg", "webp"] as const;
type Encoding = (typeof ENCODINGS)[number];
/** A re-encoding to try: the long side, the type, and a JPEG or WebP's quality or a PNG's palette. */
type Try = [number, Encoding, { quality?: number; palette?: boolean }?];

/**
 * Whether an image may go as it is, by its header: its bytes are the type it
 * says, its size is known, and it's within both limits. Its pixels can still
 * be broken (a truncated download): fitImage decodes it too.
 */
export function imageFits(p: ImagePart): boolean {
    if (p.data.length > IMAGE_BASE64) return false;
    const bytes = Buffer.from(p.data, "base64");
    const size = imageSize(bytes);
    return sniffImage(bytes) === p.mediaType && Boolean(size?.width && size.height) && Math.max(size!.width, size!.height) <= IMAGE_SIDE;
}

/** Decodes waiting their turn: each can take IMAGE_PIXELS × 4 bytes while it runs, so a batch of images doesn't run at once. */
let decoding: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(f: () => Promise<T>): Promise<T> {
    const run = decoding.then(f);
    decoding = run.catch(() => {});
    return run;
}

/** Whether an image's pixels decode, by a hash of its base64: each is decoded once, however often it's sent. */
const decodable = new Map<number | bigint, boolean>();
async function decodes(data: string, bytes: Uint8Array): Promise<boolean> {
    const key = Bun.hash(data);
    let ok = decodable.get(key);
    if (ok === undefined) {
        // Scaled to a few pixels, so only the decode costs anything.
        ok = await oneAtATime(() => new Bun.Image(bytes, { maxPixels: IMAGE_PIXELS }).resize(8, 8, { fit: "inside", withoutEnlargement: true }).png().bytes()).then(
            () => true,
            () => false,
        );
        if (decodable.size >= 1000) decodable.delete(decodable.keys().next().value!);
        decodable.set(key, ok);
    }
    return ok;
}

/** Whether an image may have transparent pixels: a PNG with an alpha channel or a tRNS chunk, and any GIF or WebP. */
function mayBeTransparent(bytes: Uint8Array, type: string): boolean {
    if (type === "image/jpeg") return false;
    if (type !== "image/png") return true;
    // The colour type: 4 is grey and alpha, 6 is RGBA.
    if (bytes[25] === 4 || bytes[25] === 6) return true;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 8; at + 8 <= bytes.length; ) {
        const name = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
        if (name === "tRNS") return true;
        if (name === "IDAT") return false;
        at += 12 + view.getUint32(at);
    }
    return false;
}

/** Every type an image is ever stored as or sent in. */
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * The image as a model may be sent it: as it is when it fits, decodes, and is
 * of a type in `types` (what the provider takes); otherwise decoded, scaled
 * down to IMAGE_SIDE (aspect ratio kept) and re-encoded: in its own type if
 * that's one the provider takes (a GIF becomes a PNG of its first frame), else
 * as a PNG. Still too heavy, an opaque image goes as a smaller JPEG. One that
 * may be transparent goes as an indexed PNG (256 colours, alpha kept), at
 * 2000px and then 1568px: a JPEG would turn its transparent pixels black, and
 * WebP isn't taken by every provider (xAI documents only JPEG and PNG).
 * Undefined when it can't be decoded as a PNG, JPEG, GIF or WebP of at most
 * IMAGE_PIXELS. Every provider takes PNG and JPEG, so `types` always has them.
 */
export async function fitImage(p: ImagePart, types: readonly string[] = IMAGE_TYPES): Promise<ImagePart | undefined> {
    const bytes = Buffer.from(p.data, "base64");
    const type = sniffImage(bytes);
    if (!type) return undefined;
    const size = imageSize(bytes);
    if (size && size.width * size.height > IMAGE_PIXELS) return undefined;
    if (types.includes(type) && size?.width && size.height && Math.max(size.width, size.height) <= IMAGE_SIDE && p.data.length <= IMAGE_BASE64) {
        if (!(await decodes(p.data, bytes))) return undefined;
        // Within the limits, only labelled as something else (a .png that's a JPEG): the label is put right.
        return type === p.mediaType ? p : { type: "image", mediaType: type, data: p.data };
    }
    const own = type.slice("image/".length);
    const first: Encoding = types.includes(type) && (ENCODINGS as readonly string[]).includes(own) ? (own as Encoding) : "png";
    // An indexed PNG at 1568px is at most about 1568 × 1569 bytes (3.3 MB as base64) however it compresses, so the last try always fits.
    const tries: Try[] = mayBeTransparent(bytes, type)
        ? [[IMAGE_SIDE, first], [IMAGE_SIDE, "png", { palette: true }], [1568, "png", { palette: true }]]
        : [[IMAGE_SIDE, first], [IMAGE_SIDE, "jpeg", { quality: 80 }], [1568, "jpeg", { quality: 70 }], [1000, "jpeg", { quality: 60 }]];
    try {
        return await oneAtATime(async () => {
            for (const [side, as, o] of tries) {
                const img = new Bun.Image(bytes, { maxPixels: IMAGE_PIXELS }).resize(side, side, { fit: "inside", withoutEnlargement: true });
                const out = await (as === "jpeg" ? img.jpeg({ quality: o?.quality ?? 85 }) : as === "webp" ? img.webp({ quality: o?.quality ?? 85 }) : img.png({ palette: o?.palette ?? false })).bytes();
                const data = Buffer.from(out).toString("base64");
                if (data.length <= IMAGE_BASE64) return { type: "image", mediaType: `image/${as}`, data } satisfies ImagePart;
            }
            return undefined;
        });
    } catch {
        // not decodable after all, or over IMAGE_PIXELS
        return undefined;
    }
}

const UNREADABLE = `it couldn't be read as a PNG, JPEG, GIF or WebP image of at most ${IMAGE_PIXELS / 1_000_000} megapixels`;

/** A tool result with `images` in place of its own, and a line saying why for any taken out. */
function lessImages(p: ToolResultPart, images: ImagePart[], why: string): ToolResultPart {
    const gone = (p.images?.length ?? 0) - images.length;
    if (!gone) return { ...p, images };
    const note = `[${gone === 1 ? "An image" : `${gone} images`} this returned ${gone === 1 ? "isn't" : "aren't"} included: ${why}.]`;
    const { images: _, ...rest } = p;
    return { ...rest, ...(images.length ? { images } : {}), content: p.content ? `${p.content}\n${note}` : note };
}

/** A prompt's parts, or a tool's results, with every image fitted (one that can't be becomes a note). */
export async function fitContent(content: UserContent[], fit: (p: ImagePart) => Promise<ImagePart | undefined> = (p) => fitImage(p)): Promise<UserContent[]> {
    if (!content.some((p) => p.type === "image" || (p.type === "tool_result" && p.images?.length))) return content;
    return Promise.all(
        content.map(async (p): Promise<UserContent> => {
            if (p.type === "image") return (await fit(p)) ?? { type: "text", text: `[An image the user attached isn't included: ${UNREADABLE}.]` };
            if (p.type === "tool_result" && p.images?.length) {
                const fitted = await Promise.all(p.images.map(fit));
                const images = fitted.filter((i): i is ImagePart => Boolean(i));
                const same = images.length === p.images.length && images.every((img, i) => img === p.images![i]);
                return same ? p : lessImages(p, images, UNREADABLE);
            }
            return p;
        }),
    );
}

/** Each stored image fitted once for each set of types: a history is checked again on every request. */
const fitted = new WeakMap<ImagePart, Map<string, ImagePart | null>>();
async function fitOnce(p: ImagePart, types: readonly string[]): Promise<ImagePart | undefined> {
    const key = types.join();
    let byTypes = fitted.get(p);
    if (!byTypes) fitted.set(p, (byTypes = new Map()));
    let f = byTypes.get(key);
    if (f === undefined) byTypes.set(key, (f = (await fitImage(p, types)) ?? null));
    return f ?? undefined;
}

/** A message with its images replaced by notes. */
function withoutImages(m: Message, user: string, tool: string): Message {
    if (m.role !== "user" || !hasImages(m)) return m;
    return {
        ...m,
        content: m.content.map((p): UserContent => {
            if (p.type === "image") return { type: "text", text: user };
            if (p.type === "tool_result" && p.images?.length) return lessImages(p, [], tool);
            return p;
        }),
    };
}

/** Whether a message carries an image. */
export function hasImages(m: Message): boolean {
    return m.role === "user" && m.content.some((p) => p.type === "image" || (p.type === "tool_result" && Boolean(p.images?.length)));
}

/**
 * The conversation as this model may be sent it. A model known to take no
 * images (`supportsImages: false`; unknown isn't text-only) gets a note for
 * each. A message `refused` picks out (this model refused a request for its
 * images) loses them. Any other image is fitted now, if it wasn't on the way
 * in (a history stored before images were fitted), and re-encoded if its type
 * isn't one in `types` (the provider's: what's stored may have come in while
 * another provider was in use). With `maxBase64` (a provider that caps a
 * request's images in total), the newest images that fit within it go and
 * older ones get a note. Only what's sent changes, never the transcript; the
 * same conversation always comes out the same.
 */
export async function imagesFor(messages: Message[], o: { readsImages: boolean; types?: readonly string[]; maxBase64?: number; refused?: (m: Message) => boolean }): Promise<Message[]> {
    if (!messages.some(hasImages)) return messages;
    const out = await Promise.all(
        messages.map(async (m) => {
            if (m.role !== "user" || !hasImages(m)) return m;
            if (!o.readsImages) return withoutImages(m, "[The user attached an image, but this model can't read images, so it isn't included.]", "this model can't read images");
            if (o.refused?.(m)) return withoutImages(m, "[An image the user attached isn't included any more: the provider rejected a request carrying it.]", "the provider rejected a request carrying it");
            const content = await fitContent(m.content, (p) => fitOnce(p, o.types ?? IMAGE_TYPES));
            return content.every((p, i) => p === m.content[i]) ? m : { ...m, content };
        }),
    );
    return o.maxBase64 === undefined ? out : withinTotal(out, o.maxBase64);
}

/** The conversation with only the newest images that total at most `max` of base64: older ones get a note. */
function withinTotal(messages: Message[], max: number): Message[] {
    let left = max;
    const fits = (p: ImagePart) => p.data.length <= left && ((left -= p.data.length), true);
    const why = "the provider takes a limited total of image data in a request, and newer images used it up";
    // Newest first, so the latest images are the ones kept.
    return messages
        .slice()
        .reverse()
        .map((m) => {
            if (m.role !== "user" || !hasImages(m)) return m;
            const content = m.content
                .slice()
                .reverse()
                .map((p): UserContent => {
                    if (p.type === "image") return fits(p) ? p : { type: "text", text: `[An image the user attached isn't included: ${why}.]` };
                    if (p.type === "tool_result" && p.images?.length) {
                        const kept = p.images.slice().reverse().filter(fits).reverse();
                        return kept.length === p.images.length ? p : lessImages(p, kept, why);
                    }
                    return p;
                })
                .reverse();
            return content.every((p, i) => p === m.content[i]) ? m : { ...m, content };
        })
        .reverse();
}

/** A tool's result with its images fitted (one that can't be is taken out, and the result says so). */
export async function fitToolImages<T extends { content: string; images?: ImagePart[] }>(r: T): Promise<T> {
    if (!r.images?.length) return r;
    const [p] = (await fitContent([{ type: "tool_result", toolCallId: "", toolName: "", content: r.content, images: r.images }])) as [ToolResultPart];
    return p.images === r.images ? r : { ...r, content: p.content, images: p.images };
}
