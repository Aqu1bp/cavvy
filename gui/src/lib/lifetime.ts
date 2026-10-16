import { onCleanup } from "solid-js";

/** Delayed callbacks must stop owning shared state when their component goes away. */
export function createLifetimeGuard() {
    let active = true;
    onCleanup(() => {
        active = false;
    });
    return <Args extends unknown[]>(callback: (...args: Args) => void) => (...args: Args): void => {
        if (active) callback(...args);
    };
}
