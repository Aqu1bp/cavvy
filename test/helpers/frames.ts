// A stand-in for requestAnimationFrame (lib/drag.ts's Frames): frames run when the test says.
export function fakeFrames() {
    let next = 1;
    const queue = new Map<number, () => void>();
    return {
        request: (run: () => void) => (queue.set(next, run), next++),
        cancel: (id: number) => void queue.delete(id),
        /** Runs the frame: what was asked for before it. */
        run() {
            const runs = [...queue.values()];
            queue.clear();
            for (const run of runs) run();
        },
        pending: () => queue.size,
    };
}
