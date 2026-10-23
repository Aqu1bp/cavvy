import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import { ChevronLeft, ChevronRight } from "lucide-solid";
import { fromBase64 } from "../lib/attachments";
import { canZoom, fitSize, flipFrom, imageSize, stepKey, viewBox, zoomScroll, type Size } from "../lib/image-view";
import { replyUrls } from "../state/images";
import { setViewedImage, viewedImage, type ViewerImage } from "../state/ui";
import { motionMs } from "./LiveLine";
import { Dialog, inTopDialog } from "./ui/Dialog";

/** The opening move, from the thumbnail that was clicked. */
const OPEN_MS = 220;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** How far the pointer moves before a press on a 1:1 image is a drag, not a click. */
const DRAG_PX = 4;

/** An image as it's shown: a URL for the whole of it (an object URL this viewing made, `owned`), and its size where known. */
type Shown = { url: string; size?: Size; owned: boolean };

/**
 * An image full size over everything, fitted into most of the window and
 * never past its own size; a click shows a larger one at 1:1 (drag or scroll
 * to pan) and back. ‹ › and the arrow keys step through the others with it;
 * Escape or a click outside closes it.
 */
export function ImageViewer() {
    const captionId = createUniqueId();
    return (
        <Dialog open={Boolean(viewedImage())} onClose={() => setViewedImage(undefined)} bare class="image-viewer" labelledBy={captionId}>
            <Viewer captionId={captionId} />
        </Dialog>
    );
}

function Viewer(p: { captionId: string }) {
    const opened = viewedImage()!;
    const images = opened.images;
    const close = () => setViewedImage(undefined);
    const [index, setIndex] = createSignal(Math.min(Math.max(0, opened.index), images.length - 1));
    const item = () => images[index()]!;

    // The whole image goes to the DOM as an object URL (made from the bytes in a millisecond or two),
    // never as a data: URL, which WebKit parses on the main thread each time one is set.
    const shown = new Map<ViewerImage, Shown>();
    const show = (i: ViewerImage): Shown => {
        let s = shown.get(i);
        if (!s) {
            if (typeof i.full === "string") s = { url: i.full, size: i.size, owned: false };
            else {
                const bytes = fromBase64(i.full.data);
                s = { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: i.full.mediaType })), size: i.size ?? imageSize(bytes), owned: true };
            }
            shown.set(i, s);
        }
        return s;
    };
    onCleanup(() => {
        for (const s of shown.values()) if (s.owned) URL.revokeObjectURL(s.url);
    });
    // A reply's images are its URLs (state/images.ts): kept while this shows them, should the reply go first.
    onCleanup(replyUrls.hold(images.flatMap((i) => [i.preview, i.full].filter((u): u is string => typeof u === "string" && u.startsWith("blob:")))));

    // Sizes found by decoding, where the header didn't say (or said otherwise: a rotated JPEG).
    const [decoded, setDecoded] = createSignal(new Map<ViewerImage, Size>());
    const natural = (): Size | undefined => decoded().get(item()) ?? show(item()).size;

    const [win, setWin] = createSignal({ width: innerWidth, height: innerHeight });
    const onResize = () => setWin({ width: innerWidth, height: innerHeight });
    addEventListener("resize", onResize);
    onCleanup(() => removeEventListener("resize", onResize));
    const box = () => viewBox(win());
    const zoomable = () => {
        const n = natural();
        return Boolean(n && canZoom(n, box()));
    };
    const [zoomed, setZoomed] = createSignal(false);
    const size = () => {
        const n = natural();
        if (!n) return undefined;
        return zoomed() ? n : fitSize(n, box());
    };

    let stage!: HTMLDivElement;
    let pic!: HTMLDivElement;

    /** Fit to 1:1, keeping the point at (x, y) (in the window) where it is; or back to fit. */
    const toggle = (x?: number, y?: number) => {
        if (zoomed()) return setZoomed(false);
        const n = natural();
        const fitted = size();
        if (!n || !fitted || !zoomable()) return;
        const r = pic.getBoundingClientRect();
        const v = stage.getBoundingClientRect();
        const at = x === undefined || y === undefined ? { x: r.width / 2, y: r.height / 2 } : { x: x - r.left, y: y - r.top };
        const cursor = x === undefined || y === undefined ? { x: v.width / 2, y: v.height / 2 } : { x: x - v.left, y: y - v.top };
        setZoomed(true);
        const to = zoomScroll(at, cursor, fitted, n, { width: stage.clientWidth, height: stage.clientHeight });
        stage.scrollLeft = to.left;
        stage.scrollTop = to.top;
    };

    const step = (d: number) => {
        const next = index() + d;
        if (next < 0 || next >= images.length) return;
        setZoomed(false);
        setIndex(next);
    };

    // At 1:1, a drag pans; the click that ends a drag doesn't toggle or close.
    const [grabbing, setGrabbing] = createSignal(false);
    let drag: { x: number; y: number; left: number; top: number } | undefined;
    let dragged = false;
    const onPointerDown = (e: PointerEvent) => {
        dragged = false;
        if (!zoomed() || e.button !== 0) return;
        e.preventDefault();
        drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
        try {
            pic.setPointerCapture(e.pointerId);
        } catch {
            // Not a pointer that's down (a synthetic event): it pans while over the image.
        }
    };
    const onPointerMove = (e: PointerEvent) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!dragged && Math.hypot(dx, dy) < DRAG_PX) return;
        dragged = true;
        setGrabbing(true);
        stage.scrollLeft = drag.left - dx;
        stage.scrollTop = drag.top - dy;
    };
    const onPointerUp = () => {
        drag = undefined;
        setGrabbing(false);
    };

    const onKey = (e: KeyboardEvent) => {
        const typing = Boolean((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]"));
        const d = stepKey(e.key, typing, inTopDialog(pic));
        if (!d) return;
        e.preventDefault();
        step(d);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));

    // Opens with a quick scale and fade from the thumbnail it was clicked on (or in place), as Settings → Motion has it.
    onMount(() => {
        const ms = motionMs(OPEN_MS);
        if (!ms || typeof pic.animate !== "function") return;
        const from = opened.from?.isConnected ? opened.from.getBoundingClientRect() : undefined;
        const move = from && from.width > 0 && from.height > 0 ? flipFrom(from, pic.getBoundingClientRect()) : undefined;
        const start = move ? `translate(${move.x}px, ${move.y}px) scale(${move.scale})` : "scale(0.96)";
        pic.animate([{ transform: start, opacity: move ? 0.5 : 0 }, { transform: "none", opacity: 1 }], { duration: ms, easing: EASE });
    });

    const caption = () => {
        const n = natural();
        return [item().name, n ? `${n.width} × ${n.height}` : undefined].filter(Boolean).join(" · ");
    };
    return (
        <div
            class={`iv ${zoomed() ? "zoomed" : ""} ${grabbing() ? "grabbing" : ""}`}
            // Focused when it opens, so no ring shows round the image until Tab gets there.
            tabIndex={-1}
            autofocus
            onClick={(e) => {
                if (dragged) return void (dragged = false);
                const t = e.target as HTMLElement;
                if (!t.closest(".iv-img, .iv-caption, .iv-step")) close();
            }}
        >
            <div class="iv-stage" ref={stage}>
                <div class="iv-frame">
                    <div
                        ref={pic}
                        class={`iv-img ${zoomable() ? "can-zoom" : ""}`}
                        tabIndex={0}
                        role={zoomable() ? "button" : "img"}
                        aria-label={zoomable() ? `${item().name}: ${zoomed() ? "fit to the window" : "view at actual size"}` : item().name}
                        style={size() ? { width: `${size()!.width}px`, height: `${size()!.height}px` } : undefined}
                        onClick={(e) => {
                            if (dragged) return;
                            toggle(e.clientX, e.clientY);
                        }}
                        onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            toggle();
                        }}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                    >
                        <Show when={item()} keyed>
                            {(i) => <Picture url={show(i).url} preview={i.preview} onSize={(n) => setDecoded((m) => new Map(m).set(i, n))} />}
                        </Show>
                    </div>
                    <div class="iv-caption" id={p.captionId}>
                        <span class="iv-name truncate">{caption()}</span>
                        <Show when={images.length > 1}>
                            <span class="iv-count">
                                {index() + 1} of {images.length}
                            </span>
                        </Show>
                    </div>
                </div>
            </div>
            <Show when={images.length > 1}>
                <button class="iv-step prev" aria-label="Previous image" title="Previous (←)" disabled={index() === 0} onClick={() => step(-1)}>
                    <ChevronLeft size={18} />
                </button>
                <button class="iv-step next" aria-label="Next image" title="Next (→)" disabled={index() === images.length - 1} onClick={() => step(1)}>
                    <ChevronRight size={18} />
                </button>
            </Show>
        </div>
    );
}

/**
 * One image: its preview at once, the whole image over it, and the preview
 * gone once the whole one is decoded. In WebKit (a 3000×2000 PNG) the whole
 * one decodes off the UI thread when it's first painted and shows when it's
 * done; asked to decode before that (img.decode()), or decoded first and put
 * in after, it held the UI thread for 15–40 ms.
 */
function Picture(p: { url: string; preview?: string; onSize: (natural: Size) => void }) {
    const [ready, setReady] = createSignal(!p.preview || p.preview === p.url);
    let whole!: HTMLImageElement;
    onMount(() => {
        let live = true;
        onCleanup(() => (live = false));
        const done = () => {
            if (!live) return;
            if (whole.naturalWidth) p.onSize({ width: whole.naturalWidth, height: whole.naturalHeight });
            setReady(true);
        };
        // After its first frame, decode() waits for the decode that frame started. Not decodable here:
        // the preview goes anyway, which says so better than one that never sharpens.
        requestAnimationFrame(() => setTimeout(() => live && whole.decode().then(done, done)));
    });
    return (
        <>
            <Show when={!ready()}>
                <img class="iv-preview" src={p.preview} alt="" draggable={false} />
            </Show>
            <img ref={whole} class="iv-whole" src={p.url} alt="" draggable={false} />
        </>
    );
}
