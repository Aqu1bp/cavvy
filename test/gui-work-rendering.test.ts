import { afterEach, expect, test } from "bun:test";
import { observeWorkRendering } from "../gui/src/lib/work-rendering";

let scans = 0;

// Browser boundary only: callbacks run the real registration, sizing, reveal and disposal logic.
class Box {
    nodeType = 1;
    children: Box[] = [];
    parentElement?: Box;
    attributes = new Set<string>();
    style = { containIntrinsicBlockSize: "" };
    top = -300;
    height = 31;
    natural = 31;
    constructor(public row = false) {}
    append(child: Box) { child.parentElement = this; this.children.push(child); }
    contains(child: Box): boolean { return this === child || this.children.some((c) => c.contains(child)); }
    matches(selector: string) { return selector.startsWith("[") ? this.attributes.has(selector.slice(1, -1)) : this.row; }
    closest(selector: string): Box | undefined { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    querySelectorAll(selector: string): Box[] { scans++; return this.children.flatMap((c) => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
    setAttribute(name: string) { this.attributes.add(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    hasAttribute(name: string) { return this.attributes.has(name); }
    getBoundingClientRect() { const height = this.hasAttribute("data-work-far") ? this.height : this.natural; return { top: this.top, bottom: this.top + height, height }; }
}
let io: Observer, ro: Observer, mo: Observer;
class Observer {
    targets = new Set<Box>();
    constructor(public callback: (entries: any[], observer: Observer) => void) {}
    observe(el: Box) { this.targets.add(el); }
    unobserve(el: Box) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); }
    emit(entries: any[]) { this.callback(entries, this); }
}
const names = ["IntersectionObserver", "ResizeObserver", "MutationObserver"] as const;
const original = names.map((name) => globalThis[name]);
afterEach(() => names.forEach((name, i) => { (globalThis as any)[name] = original[i]; }));
function fixture(count = 80, parkFar = () => true) {
    (globalThis as any).IntersectionObserver = class extends Observer { constructor(cb: any) { super(cb); io = this; } };
    (globalThis as any).ResizeObserver = class extends Observer { constructor(cb: any) { super(cb); ro = this; } };
    (globalThis as any).MutationObserver = class extends Observer { constructor(cb: any) { super(cb); mo = this; } };
    io = ro = undefined as any;
    const root = new Box(); root.top = 0;
    const content = new Box(); root.append(content);
    const rows = Array.from({ length: count }, () => new Box(true)); rows.forEach((row) => content.append(row));
    const shifts: number[] = [];
    const dispose = observeWorkRendering(root as any, content as any, (by) => shifts.push(by), parkFar);
    const measure = (row: Box, height = row.natural) => ro.emit([{ target: row, contentRect: { height } }]);
    const near = (row: Box, isIntersecting: boolean) => io.emit([{ target: row, isIntersecting }]);
    return { root, content, rows, shifts, dispose, measure, near };
}

test("short work logs do not start layout observers; appended work activates them at the threshold", () => {
    const f = fixture(79);
    expect(io).toBeUndefined(); expect(ro).toBeUndefined();
    const row = new Box(true); f.content.append(row);
    mo.emit([{ addedNodes: [row], removedNodes: [] }]);
    expect(io.targets.size).toBe(80); expect(ro.targets.size).toBe(80);
    f.dispose();
});

test("offscreen rows retain their measured content height, never an estimated initial height", () => {
    const f = fixture(); const row = f.rows[0]!;
    f.near(row, false);
    expect(row.hasAttribute("data-work-far")).toBe(false);
    f.measure(row, 42.5);
    expect(row.hasAttribute("data-work-far")).toBe(true);
    expect(row.style.containIntrinsicBlockSize).toBe("auto 42.5px");
    // Placeholder notifications must not overwrite the remembered natural size.
    f.measure(row, 999);
    expect(row.style.containIntrinsicBlockSize).toBe("auto 42.5px");
    f.dispose();
});

test("near rows stay natural; hidden zero-height rows are not given a placeholder", () => {
    const f = fixture(); const row = f.rows[0]!;
    f.measure(row);
    expect(row.hasAttribute("data-work-far")).toBe(false);
    f.measure(row, 0); f.near(row, false);
    expect(row.hasAttribute("data-work-far")).toBe(false);
    f.measure(row, 60);
    expect(row.style.containIntrinsicBlockSize).toBe("auto 60px");
    f.near(row, true);
    expect(row.hasAttribute("data-work-far")).toBe(false);
    f.dispose();
});

test("revealing resized rows above the reader compensates their height change once", () => {
    const f = fixture(); const [a, b] = f.rows;
    f.measure(a!); f.measure(b!); f.near(a!, false); f.near(b!, false);
    a!.natural = 51; b!.natural = 26;
    io.emit([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }]);
    expect(f.shifts).toEqual([15]);
    io.emit([{ target: a, isIntersecting: true }]);
    expect(f.shifts).toEqual([15]);
    f.measure(a!); f.near(a!, false);
    expect(a!.style.containIntrinsicBlockSize).toBe("auto 51px");
    f.dispose();
});

test("reveals below the reader do not adjust scrolling, and nested regions are not observed twice", () => {
    const f = fixture(); const row = f.rows[0]!; row.top = 100;
    f.measure(row); f.near(row, false); row.natural = 81; f.near(row, true);
    expect(f.shifts).toEqual([]);
    const nested = new Box(true); row.append(nested);
    mo.emit([{ addedNodes: [nested], removedNodes: [] }]);
    expect(io.targets.has(nested)).toBe(false);
    f.dispose();
});

test("removed rows are released, moved rows stay registered, and late callbacks after disposal are inert", () => {
    const f = fixture(); const row = f.rows[0]!;
    f.measure(row); f.near(row, false);
    mo.emit([{ addedNodes: [row], removedNodes: [row] }]);
    expect(io.targets.has(row)).toBe(true);
    f.content.children.splice(0, 1); row.parentElement = undefined;
    mo.emit([{ addedNodes: [], removedNodes: [row] }]);
    expect(io.targets.has(row)).toBe(false); expect(ro.targets.has(row)).toBe(false);
    expect(row.attributes.size).toBe(0); expect(row.style.containIntrinsicBlockSize).toBe("");
    const late = f.rows[1]!; f.dispose();
    expect(io.targets.size).toBe(0); expect(ro.targets.size).toBe(0); expect(mo.targets.size).toBe(0);
    io.emit([{ target: late, isIntersecting: false }]);
    ro.emit([{ target: late, contentRect: { height: 100 } }]);
    mo.emit([{ addedNodes: [late], removedNodes: [] }]);
    expect(late.attributes.size).toBe(0);
});


test("updates inside an existing row do not rescan highlighted output descendants", () => {
    const f = fixture(); const output = new Box(); f.rows[0]!.append(output);
    for (let i = 0; i < 2000; i++) output.append(new Box());
    const before = scans;
    mo.emit([{ addedNodes: [output], removedNodes: [] }]);
    expect(scans).toBe(before);
    expect(io.targets.size).toBe(80);
    f.dispose();
});

test("mutations inside an already removed subtree do not retain detached rows", () => {
    const f = fixture();
    const removed = new Box(); const row = new Box(true); removed.append(row);
    mo.emit([{ removedNodes: [removed], addedNodes: [] }, { removedNodes: [], addedNodes: [row] }]);
    expect(io.targets.has(row)).toBe(false);
    expect(ro.targets.has(row)).toBe(false);
    expect(row.attributes.size).toBe(0);
    f.dispose();
});

test("rows in a turn gone far aren't watched, and are again once it comes near", () => {
    const f = fixture();
    const turn = new Box(); f.content.append(turn);
    const rows = Array.from({ length: 3 }, () => new Box(true)); rows.forEach((row) => turn.append(row));
    mo.emit([{ addedNodes: [turn], removedNodes: [] }]);
    expect(rows.every((row) => io.targets.has(row) && ro.targets.has(row))).toBe(true);
    f.measure(rows[0]!); f.near(rows[0]!, false);
    turn.setAttribute("data-far");
    mo.emit([{ type: "attributes", target: turn, addedNodes: [], removedNodes: [] }]);
    expect(rows.some((row) => io.targets.has(row) || ro.targets.has(row))).toBe(false);
    // Skipped with the turn, not on its own, and with the size it was measured at.
    expect(rows[0]!.hasAttribute("data-work-far")).toBe(false);
    expect(rows[0]!.style.containIntrinsicBlockSize).toBe("auto 31px");
    const late = new Box(true); turn.append(late);
    mo.emit([{ addedNodes: [late], removedNodes: [] }]);
    expect(io.targets.has(late)).toBe(false);
    turn.removeAttribute("data-far");
    mo.emit([{ type: "attributes", target: turn, addedNodes: [], removedNodes: [] }]);
    expect([...rows, late].every((row) => io.targets.has(row) && ro.targets.has(row))).toBe(true);
    // Skipped on its own again as it was, until the observer says where it is now.
    expect(rows.map((row) => row.hasAttribute("data-work-far"))).toEqual([true, false, false]);
    // The rows outside it were watched all along.
    expect(io.targets.size).toBe(84);
    f.dispose();
});

test("rows of far turns are let go of only while parkFar says so (many turns drawn), and taken back after", () => {
    let many = false;
    const f = fixture(80, () => many);
    const turn = new Box(); f.content.append(turn);
    const rows = Array.from({ length: 3 }, () => new Box(true)); rows.forEach((row) => turn.append(row));
    mo.emit([{ addedNodes: [turn], removedNodes: [] }]);
    f.measure(rows[0]!); f.near(rows[0]!, false);
    turn.setAttribute("data-far");
    mo.emit([{ type: "attributes", target: turn, addedNodes: [], removedNodes: [] }]);
    // A session as it opens: nothing let go of.
    expect(rows.every((row) => io.targets.has(row))).toBe(true);
    expect(rows[0]!.hasAttribute("data-work-far")).toBe(true);
    // More turns drawn: the far turn's rows are let go of with the next change.
    many = true;
    const more = new Box(); f.content.append(more);
    mo.emit([{ addedNodes: [more], removedNodes: [] }]);
    expect(rows.some((row) => io.targets.has(row))).toBe(false);
    expect(rows[0]!.hasAttribute("data-work-far")).toBe(false);
    // Fewer again: taken back as they were.
    many = false;
    mo.emit([{ addedNodes: [], removedNodes: [more] }]);
    expect(rows.every((row) => io.targets.has(row) && ro.targets.has(row))).toBe(true);
    expect(rows[0]!.hasAttribute("data-work-far")).toBe(true);
    f.dispose();
});
