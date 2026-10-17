import { createSignal } from "solid-js";

/** Published by the mounted sidebar after paging and interaction holds. */
export const [sidebarOrder, setSidebarOrder] = createSignal<string[] | undefined>();
