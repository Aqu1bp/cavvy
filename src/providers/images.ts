// Every image on its way to a model, from wherever it came (a prompt's
// attachments, a paste, the Read tool, an MCP tool, a resumed history):
// fitted to what providers take, or a note in its place.
//
// Anthropic's limits (https://platform.claude.com/docs/en/build-with-claude/vision,
// 2026-10): 8000px a side; in a request with more than 20 images, every image
// at most 2000px a side (resent and tool_result images count); 10 MB as base64
// on its API, 5 MB on Bedrock and Google Cloud (where OpenRouter may route a
// Claude model). The other providers document looser or no per-image limits,
// so one target serves them all: at most 2000px a side and 5 MB as base64.
// An image is fitted once, as it enters the conversation, so what's stored
// (and resent every turn) already fits, and the 20-image threshold never
// changes what an earlier image looks like (prompt caches match on prefix).
// The file it came from is never touched.

import type { ImagePart, Message, ToolResultPart, UserContent } from "./types";
import { imageSize } from "../ui/images";
import { sniffImage } from "../util/files";

/** The long side every image is brought within (Anthropic's limit for requests with more than 20 images). */
export const IMAGE_SIDE = 2000;
/** An image's base64 at most (Anthropic on Bedrock and Google Cloud). */
export const IMAGE_BASE64 = 5 * 1024 * 1024;

const ENCODINGS = ["png", "jpeg", "webp"] as const;
type Encoding = (typeof ENCODINGS)[number];

/** Whether an image goes as it is: its bytes are the type it says, its size is known, and it's within both limits. */
export function imageFits(p: ImagePart): boolean {
    if (p.data.length > IMAGE_BASE64) return false;
    const bytes = Buffer.from(p.data, "base64");
    const size = imageSize(bytes);
    return sniffImage(bytes) === p.mediaType && Boolean(size?.width && size.height) && Math.max(size!.width, size!.height) <= IMAGE_SIDE;
}

/**
 * The image as a model may be sent it: as it is when it fits; otherwise
 * decoded, scaled down to IMAGE_SIDE (aspect ratio kept) and re-encoded (as a
 * JPEG, then smaller, if it's still too heavy). Undefined when it can't be
 * decoded as a PNG, JPEG, GIF or WebP.
 */
export async function fitImage(p: ImagePart): Promise<ImagePart | undefined> {
    const bytes = Buffer.from(p.data, "base64");
    const type = sniffImage(bytes);
    if (!type) return undefined;
    const size = imageSize(bytes);
    // Within the limits, only labelled as something else (a .png that's a JPEG): the label is put right.
    if (size?.width && size.height && Math.max(size.width, size.height) <= IMAGE_SIDE && p.data.length <= IMAGE_BASE64) return type === p.mediaType ? p : { type: "image", mediaType: type, data: p.data };
    // GIFs are decoded to their first frame (all a model sees of one) and kept as PNG.
    const own = type.slice("image/".length);
    const first: Encoding = (ENCODINGS as readonly string[]).includes(own) ? (own as Encoding) : "png";
    const tries: [number, Encoding, number?][] = [
        [IMAGE_SIDE, first],
        [IMAGE_SIDE, "jpeg", 80],
        [1568, "jpeg", 70],
        [1000, "jpeg", 60],
    ];
    try {
        for (const [side, as, quality] of tries) {
            const img = new Bun.Image(bytes).resize(side, side, { fit: "inside", withoutEnlargement: true });
            const out = await (as === "jpeg" ? img.jpeg({ quality: quality ?? 85 }) : as === "webp" ? img.webp({ quality: 85 }) : img.png()).bytes();
            const data = Buffer.from(out).toString("base64");
            if (data.length <= IMAGE_BASE64) return { type: "image", mediaType: `image/${as}`, data };
        }
    } catch {
        // not decodable after all
    }
    return undefined;
}

const UNREADABLE = "it couldn't be read as a PNG, JPEG, GIF or WebP image";

/** A tool result with `images` in place of its own, and a line saying why for any taken out. */
function lessImages(p: ToolResultPart, images: ImagePart[], why: string): ToolResultPart {
    const gone = (p.images?.length ?? 0) - images.length;
    if (!gone) return { ...p, images };
    const note = `[${gone === 1 ? "An image" : `${gone} images`} this returned ${gone === 1 ? "isn't" : "aren't"} included: ${why}.]`;
    const { images: _, ...rest } = p;
    return { ...rest, ...(images.length ? { images } : {}), content: p.content ? `${p.content}\n${note}` : note };
}

/** A prompt's parts, or a tool's results, with every image fitted (one that can't be becomes a note). */
export async function fitContent(content: UserContent[], fit: (p: ImagePart) => Promise<ImagePart | undefined> = fitImage): Promise<UserContent[]> {
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

/** Each stored image fitted once: a history is checked again on every request. */
const fitted = new WeakMap<ImagePart, ImagePart | null>();
async function fitOnce(p: ImagePart): Promise<ImagePart | undefined> {
    let f = fitted.get(p);
    if (f === undefined) fitted.set(p, (f = imageFits(p) ? p : ((await fitImage(p)) ?? null)));
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
 * each. Messages in `rejected` (a provider refused a request for its images)
 * lose theirs. Any other image that doesn't fit (stored before images were
 * fitted on the way in) is fitted now. Only what's sent changes, never the
 * transcript; the same conversation always comes out the same.
 */
export async function imagesFor(messages: Message[], o: { readsImages: boolean; rejected?: WeakSet<Message> }): Promise<Message[]> {
    if (!messages.some(hasImages)) return messages;
    return Promise.all(
        messages.map(async (m) => {
            if (m.role !== "user" || !hasImages(m)) return m;
            if (!o.readsImages) return withoutImages(m, "[The user attached an image, but this model can't read images, so it isn't included.]", "this model can't read images");
            if (o.rejected?.has(m)) return withoutImages(m, "[An image the user attached isn't included any more: the provider rejected a request carrying it.]", "the provider rejected a request carrying it");
            const content = await fitContent(m.content, fitOnce);
            return content.every((p, i) => p === m.content[i]) ? m : { ...m, content };
        }),
    );
}

/** A tool's result with its images fitted (one that can't be is taken out, and the result says so). */
export async function fitToolImages<T extends { content: string; images?: ImagePart[] }>(r: T): Promise<T> {
    if (!r.images?.length) return r;
    const [p] = (await fitContent([{ type: "tool_result", toolCallId: "", toolName: "", content: r.content, images: r.images }])) as [ToolResultPart];
    return p.images === r.images ? r : { ...r, content: p.content, images: p.images };
}
