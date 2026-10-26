// The Browser pane's rules, apart from the component: where a frame of the page is drawn in its box and how a
// point in the box maps back to the page, what a person's mouse and keyboard become as inputs for the server, and
// how the pane describes who is driving. Pure: the component (BrowserPane.tsx) feeds them events and sizes.

import { BROWSER_MODIFIERS, type BrowserInput, type BrowserState, type BrowserTabInfo } from "@shared/protocol";

export interface Size {
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

/** Where a frame is drawn in the box, in the box's CSS pixels. */
export interface Placement extends Point, Size {}

/**
 * Where a frame of the page is drawn: as large as fits the box, centred. The page takes the pane's size, so
 * the frame fills the box; a frame from before the pane was resized is a little off its shape, and is drawn whole
 * with bars at its sides rather than stretched.
 */
export function placeFrame(box: Size, frame: Size): Placement {
    if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
    const scale = Math.min(box.width / frame.width, box.height / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;
    return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** The page's CSS pixel under a point of the box, or undefined where no page is drawn (a bar at the frame's side). */
export function pagePoint(at: Point, place: Placement, frame: Size): Point | undefined {
    if (place.width <= 0 || place.height <= 0) return undefined;
    const x = (at.x - place.x) / place.width;
    const y = (at.y - place.y) / place.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
    return { x: Math.min(x * frame.width, frame.width - 1), y: Math.min(y * frame.height, frame.height - 1) };
}

/** The size to ask the page for: the box's, in whole pixels. */
export function paneSize(box: Size): Size {
    return { width: Math.floor(box.width), height: Math.floor(box.height) };
}

/** Whether a new size is a change worth telling the server of (a pixel of rounding isn't). */
export function resized(from: Size | undefined, to: Size): boolean {
    return !from || Math.abs(from.width - to.width) >= 2 || Math.abs(from.height - to.height) >= 2;
}

export interface Modifiers {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

export function modifiersOf(e: Modifiers): number {
    return (e.altKey ? BROWSER_MODIFIERS.Alt : 0) | (e.ctrlKey ? BROWSER_MODIFIERS.Control : 0) | (e.metaKey ? BROWSER_MODIFIERS.Meta : 0) | (e.shiftKey ? BROWSER_MODIFIERS.Shift : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

export interface MouseLike extends Modifiers {
    button: number;
    buttons: number;
    /** The number of clicks in a row, as the browser counts them (a double-click is 2). */
    detail: number;
}

/** A mouse event at a page point, as an input. */
export function mouseInput(type: "move" | "down" | "up", at: Point, e: MouseLike): BrowserInput {
    const button = BUTTONS[e.button];
    return { kind: "mouse", type, x: at.x, y: at.y, ...(button ? { button } : {}), buttons: e.buttons, clickCount: Math.max(1, e.detail), modifiers: modifiersOf(e) };
}

export interface WheelLike extends Modifiers {
    deltaX: number;
    deltaY: number;
    /** 0: pixels, 1: lines, 2: pages. */
    deltaMode: number;
}

/** What one line and one page of a wheel's scrolling are in pixels, as browsers have them. */
const LINE_PX = 16;

/** A wheel turn in pixels, whatever unit the wheel counts in. */
export function wheelPixels(e: Pick<WheelLike, "deltaX" | "deltaY" | "deltaMode">, pageHeight: number): { x: number; y: number } {
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pageHeight : 1;
    return { x: e.deltaX * unit, y: e.deltaY * unit };
}

/** A wheel event at a page point, with the pixels it scrolled (wheelPixels, summed over the turns since the last one sent). */
export function wheelInput(at: Point, pixels: { x: number; y: number }, e: Modifiers): BrowserInput {
    return { kind: "wheel", x: at.x, y: at.y, deltaX: pixels.x, deltaY: pixels.y, modifiers: modifiersOf(e) };
}

export interface KeyLike extends Modifiers {
    key: string;
    code: string;
    /** An input method is composing: its keys aren't the page's. */
    isComposing?: boolean;
    repeat?: boolean;
}

/** Keys that aren't keys: dead keys and an input method's. */
const NOT_KEYS = new Set(["Dead", "Process", "Unidentified", "Compose"]);

/** The key that hands the keyboard back to the app (Shift+Escape): everything else goes to the page, so a person can type in it as in a browser. */
export function isReleaseKey(e: Pick<KeyLike, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">): boolean {
    return e.key === "Escape" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** A key event as an input; undefined for what the page shouldn't be told (an input method's keys). */
export function keyInput(type: "down" | "up", e: KeyLike): BrowserInput | undefined {
    if (e.isComposing || NOT_KEYS.has(e.key) || !e.key) return undefined;
    return { kind: "key", type, key: e.key, code: e.code, modifiers: modifiersOf(e) };
}

/** Pasting is text for the page, not keys: the paste shortcut itself isn't sent, the paste event is. */
export function isPasteKey(e: Pick<KeyLike, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
    return e.key.toLowerCase() === "v" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}

/** The text of a tab for the strip: its title, or where it is. */
export function tabLabel(t: Pick<BrowserTabInfo, "title" | "url">): string {
    if (t.title) return t.title;
    if (!t.url || t.url === "about:blank") return "New tab";
    try {
        return new URL(t.url).host || t.url;
    } catch {
        return t.url;
    }
}

/** What the address bar shows for a page: its address (nothing for a blank page). */
export function addressOf(url: string): string {
    return url === "about:blank" ? "" : url;
}

export type PaneStatus = "unavailable" | "idle" | "starting" | "crashed" | "agent" | "human" | "free";

/** What the pane has to say about the browser and the current tab, by what to show. */
export function paneStatus(state: BrowserState | undefined): PaneStatus {
    if (!state) return "idle";
    if (state.status === "unavailable") return "unavailable";
    const tab = state.tabs.find((t) => t.id === state.active);
    if (!tab) return state.status === "starting" ? "starting" : state.status === "crashed" ? "crashed" : "idle";
    return tab.owner === "human" ? "human" : tab.owner === "agent" ? "agent" : "free";
}

/** The current tab. */
export function currentTab(state: BrowserState | undefined): BrowserTabInfo | undefined {
    return state?.tabs.find((t) => t.id === state.active);
}

/** Whether a state is the agent starting to use a browser it hadn't used: a first tab appearing. */
export function agentOpened(before: BrowserState | undefined, after: BrowserState): boolean {
    return !before?.tabs.length && after.tabs.some((t) => t.owner === "agent");
}
