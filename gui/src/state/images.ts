// Images the transcript shows (see lib/imagecache.ts). The CSP allows data:
// and blob: images, nothing remote. A prompt's images come from the session
// by the turn's position; a reply's from local files it links to, which the
// server reads and checks are really images. Whole images never go to the DOM
// as data: URLs: WebKit spends ~2 ms per MB on the main thread each time one
// is set or read, so a reply's are object URLs and a prompt's stay base64
// until the viewer shows one.

import type { Turn } from "@shared/protocol";
import { ImageCache, imagesKeyOf, promptKey } from "../lib/imagecache";
import { RpcError } from "../lib/rpc";
import { thumbnail } from "../lib/thumbnail";
import { fromBase64, previewOf, type ImageAttachment } from "../lib/attachments";
import { UrlLeases } from "../lib/object-urls";
import { handleFor, rpc } from "./app";
import { sessionReadReady } from "./changes";

/** The session can be asked: connected, and reopened after a reconnect (asking before that is refused with not_open). */
export function imagesReady(sessionId: string): boolean {
    const h = handleFor(sessionId);
    return Boolean(h && sessionReadReady(h));
}

/** A failure that's down to the connection, not the image: asked again once the session is back. */
export function transient(e: unknown): boolean {
    return e instanceof RpcError && (e.code === "disconnected" || e.code === "not_open");
}

const toUrl = (i: { mediaType: string; data: string }) => `data:${i.mediaType};base64,${i.data}`;

/** An image whole, as the session has it (base64): for the viewer. */
export type WholeImage = { mediaType: string; data: string };

/** A prompt's image as the transcript shows it: a thumbnail, or the image itself where none can be made. */
export type PromptImage = { mediaType: string; thumb: string };

/**
 * Prompts' images as the transcript shows them. Their thumbnails only: a screenshot is a few MB of base64, and
 * the most recent few dozen prompts' held whole came to 34 MB of the window's 60 MB of script memory after
 * reading back through three real sessions (measured). The viewer asks for them whole (wholePromptImages).
 * 16 MB in all: a thumbnail is the image itself where none could be made.
 */
const prompts = new ImageCache<PromptImage>(32, 16_000_000, (i) => i.thumb.length);
/** Prompts' images whole: those of the last few opened in the viewer or sent, to open again at once. Up to 20 MB each. */
const promptWholes = new ImageCache<WholeImage>(4, 64_000_000, (i) => i.data.length);

async function withThumb(i: WholeImage): Promise<PromptImage & WholeImage> {
    return { mediaType: i.mediaType, data: i.data, thumb: (await thumbnail(i)) ?? toUrl(i) };
}
const thumbOnly = (i: PromptImage): PromptImage => ({ mediaType: i.mediaType, thumb: i.thumb });

/** Replies' image URLs: the image viewer holds those it shows, past the reply going. */
export const replyUrls = new UrlLeases();

/** An image as an object URL, to be revoked when it's no longer shown. */
function objectUrl(i: { mediaType: string; data: string }): string {
    return URL.createObjectURL(new Blob([fromBase64(i.data) as BlobPart], { type: i.mediaType }));
}

/** Images calls' results brought (session.toolImage), by their key: what the model looked at. Whole, for the viewer: the last few it opened. */
const tools = new ImageCache<PromptImage & WholeImage>(4, 32_000_000, (i) => i.data.length + i.thumb.length);
/**
 * Their thumbnails, for the rows: a run of 200 screenshots shows 200 of these, and holds none of the images
 * themselves, which only the viewer asks for (again, past `tools`).
 */
const toolThumbs = new ImageCache<string>(400, 16_000_000, (thumb) => thumb.length);

/** A call's result image, with its thumbnail. Rejects when it's gone. */
export function toolImage(sessionId: string, key: string): Promise<PromptImage & WholeImage> {
    const k = `${sessionId}\0${key}`;
    return tools
        .get(k, () =>
            rpc.call("session.toolImage", { id: sessionId, key }).then(async (i) => {
                const thumb = await toolThumbs.peek(k)?.then((a) => a[0], () => undefined);
                return [thumb ? { mediaType: i.mediaType, data: i.data, thumb } : await withThumb(i)];
            }),
        )
        .then((a) => a[0]!);
}

/** A call's result image as its row shows it: the thumbnail alone. Rejects when it's gone. */
export function toolThumb(sessionId: string, key: string): Promise<string> {
    const k = `${sessionId}\0${key}`;
    const whole = tools.peek(k);
    return toolThumbs.get(k, () => (whole ?? rpc.call("session.toolImage", { id: sessionId, key }).then(async (i) => [await withThumb(i)])).then((a) => [a[0]!.thumb])).then((a) => a[0]!);
}

/** A prompt's images as thumbnails, fetched by where it is and kept by what they are. Rejects when they're gone. */
export function promptImages(sessionId: string, pos: NonNullable<Turn["pos"]>, imagesKey: string): Promise<PromptImage[]> {
    return prompts.get(promptKey(sessionId, imagesKey), () =>
        rpc.call("session.promptImages", { id: sessionId, seg: pos.seg, index: pos.index }).then(async (r) => (await Promise.all(r.images.map(withThumb))).map(thumbOnly)),
    );
}

/** A prompt's images whole, for the viewer: asked for again (a few ms a MB), unless it was one of the last few. Rejects when they're gone. */
export function wholePromptImages(sessionId: string, pos: NonNullable<Turn["pos"]>, imagesKey: string): Promise<WholeImage[]> {
    return promptWholes.get(promptKey(sessionId, imagesKey), () =>
        rpc.call("session.promptImages", { id: sessionId, seg: pos.seg, index: pos.index }).then((r) => {
            // Gone since their thumbnails came: a failure (not kept), as one that couldn't be asked.
            if (!r.images.length) throw new Error("no images");
            return r.images;
        }),
    );
}

/**
 * Keeps the images being sent as that prompt's, with the composer's
 * thumbnails, so the turn shows them without asking the server for the bytes
 * it was just sent. Kept under the server's key for them: images an @mention
 * adds change that key, and then the turn asks as before.
 */
export async function keepSentImages(sessionId: string, images: readonly ImageAttachment[]): Promise<void> {
    const key = await imagesKeyOf(images);
    if (!key) return;
    void prompts.get(promptKey(sessionId, key), () => Promise.all(images.map(async (i) => ({ mediaType: i.mediaType, thumb: await previewOf(i) }))));
    void promptWholes.get(promptKey(sessionId, key), () => Promise.resolve(images.map((i) => ({ mediaType: i.mediaType, data: i.data }))));
}

/** A reply's image kept past the reply (replyImages): its URL, and how many replies shown hold it. */
type Kept = { url: Promise<string>; users: number };
/** By session, reply and path, the most recent last. */
const kept = new Map<string, Kept>();
/** Kept that no reply shows: the most recent ones. */
const KEEP_REPLY_IMAGES = 16;

/** Lets go of the least recent past the limit that no reply shows (revoked once the viewer doesn't show them either). */
function trimKept() {
    for (const [key, k] of kept) {
        if (kept.size <= KEEP_REPLY_IMAGES) return;
        if (k.users) continue;
        kept.delete(key);
        void k.url.then((url) => replyUrls.drop(url), () => undefined);
    }
}

/**
 * One reply's file images, as object URLs: the bytes it was shown with stay
 * while it streams; a later reply reads the file again. With `replyId`, they're
 * kept past the reply for a while: drawn again (its session switched back to),
 * it shows them at once, the same images still decoded, rather than reading
 * them again and laying out around a placeholder until they come. `dispose`
 * lets go of them when the reply is no longer shown (revoked once the viewer
 * showing one closes).
 */
export function replyImages(sessionId: string, replyId?: string): { load: (path: string) => Promise<string>; dispose: () => void } {
    const files = new ImageCache(16);
    const urls = new Set<string>();
    const using = new Set<Kept>();
    let disposed = false;
    const read = (path: string) => rpc.call("fs.image", { sessionId, path }).then(objectUrl);
    const own = (url: string) => {
        if (disposed) replyUrls.drop(url);
        else urls.add(url);
        return [url];
    };
    const keep = (path: string) => {
        const key = `${sessionId}\0${replyId}\0${path}`;
        let k = kept.get(key);
        if (k) kept.delete(key);
        else {
            const made: Kept = { url: read(path), users: 0 };
            // A failed read isn't kept: asked again next time.
            made.url.catch(() => kept.get(key) === made && kept.delete(key));
            k = made;
        }
        kept.set(key, k);
        if (!disposed && !using.has(k)) {
            using.add(k);
            k.users++;
        }
        trimKept();
        return k.url;
    };
    return {
        load: (path) => (replyId ? keep(path) : files.get(path, () => read(path).then(own)).then((u) => u[0]!)),
        dispose: () => {
            disposed = true;
            for (const url of urls) replyUrls.drop(url);
            urls.clear();
            for (const k of using) k.users--;
            using.clear();
            trimKept();
        },
    };
}
