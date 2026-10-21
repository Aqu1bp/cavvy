// Dragging an edge to resize a part of the window (the rail, the inspector, the diff reader, the
// terminal). The pointer can report several moves a frame, and each new size lays the window out
// again, so a drag shows its latest size at most once a frame, and saves it once, on release.

/** When the next frame comes: requestAnimationFrame, or a stand-in in tests. */
export interface Frames {
    request(run: () => void): number;
    cancel(id: number): void;
}

const animationFrames: Frames = {
    request: (run) => requestAnimationFrame(run),
    cancel: (id) => cancelAnimationFrame(id),
};

export interface FrameDrag {
    /** The size the pointer asks for now; shown on the next frame. */
    move(size: number): void;
    /** The release: saves the last size asked for, at once. Later calls, and moves, do nothing. */
    end(): void;
}

/**
 * `show` gets the latest size once a frame while it changes (the window shows it, without saving
 * it). `commit` runs once, on release, with the last size asked for, or undefined if the pointer
 * never moved; it saves the size and stops showing the dragged one.
 */
export function frameDrag(o: { show: (size: number) => void; commit: (size: number | undefined) => void; frames?: Frames }): FrameDrag {
    const frames = o.frames ?? animationFrames;
    let latest: number | undefined;
    let shown: number | undefined;
    let frame: number | undefined;
    let ended = false;
    return {
        move(size) {
            if (ended) return;
            latest = size;
            if (frame !== undefined) return;
            frame = frames.request(() => {
                frame = undefined;
                if (ended || latest === undefined || latest === shown) return;
                shown = latest;
                o.show(latest);
            });
        },
        end() {
            if (ended) return;
            ended = true;
            if (frame !== undefined) frames.cancel(frame);
            frame = undefined;
            o.commit(latest);
        },
    };
}
