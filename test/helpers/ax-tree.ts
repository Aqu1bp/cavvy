// An accessibility tree as Accessibility.getFullAXTree answers it (a flat list; nodes name their parent and children),
// written as nested specs. The shop below is the page test/helpers/browser-fixture.ts serves, as Chrome describes it.
import type { AxNode } from "../../src/browser/ax";

export interface AxSpec {
    id: string;
    role: string;
    name?: string;
    value?: string;
    ignored?: boolean;
    /** The DOM node it stands for. */
    node?: number;
    props?: Record<string, unknown>;
    kids?: AxSpec[];
}

export function axTree(root: AxSpec): AxNode[] {
    const nodes: AxNode[] = [];
    const walk = (s: AxSpec, parentId?: string) => {
        nodes.push({
            nodeId: s.id,
            ...(parentId ? { parentId } : {}),
            ...(s.ignored ? { ignored: true } : {}),
            role: { value: s.role },
            ...(s.name !== undefined ? { name: { value: s.name } } : {}),
            ...(s.value !== undefined ? { value: { value: s.value } } : {}),
            properties: Object.entries(s.props ?? {}).map(([name, value]) => ({ name, value: { value } })),
            childIds: (s.kids ?? []).map((k) => k.id),
            ...(s.node !== undefined ? { backendDOMNodeId: s.node } : {}),
        });
        for (const k of s.kids ?? []) walk(k, s.id);
    };
    walk(root);
    return nodes;
}

/** Text as Chrome gives it: a StaticText with its InlineTextBox. */
export const text = (id: string, words: string): AxSpec => ({ id, role: "StaticText", name: words, kids: [{ id: `${id}-box`, role: "InlineTextBox", name: words }] });

export const SHOP: AxSpec = {
    id: "1",
    role: "RootWebArea",
    name: "Fixture shop",
    node: 1,
    kids: [
        {
            id: "2",
            role: "banner",
            node: 2,
            kids: [
                {
                    id: "3",
                    role: "navigation",
                    name: "Main",
                    node: 3,
                    kids: [
                        { id: "4", role: "link", name: "Other page", node: 4, props: { focusable: true }, kids: [text("5", "Other page")] },
                        { id: "6", role: "link", name: "Jump", node: 6, kids: [text("7", "Jump")] },
                    ],
                },
            ],
        },
        {
            id: "8",
            role: "main",
            node: 8,
            kids: [
                { id: "9", role: "heading", name: "Fixture shop", node: 9, props: { level: 1 }, kids: [text("10", "Fixture shop")] },
                {
                    id: "11",
                    role: "paragraph",
                    node: 11,
                    kids: [text("12", "Welcome to the "), { id: "13", role: "strong", node: 13, kids: [text("14", "shop")] }, text("15", ". Everything is "), { id: "16", role: "emphasis", node: 16, kids: [text("17", "fake")] }, text("18", ".")],
                },
                { id: "19", role: "button", name: "Click me", node: 19, kids: [text("20", "Click me")] },
                {
                    id: "21",
                    role: "form",
                    node: 21,
                    kids: [
                        { id: "22", role: "LabelText", node: 22, kids: [text("23", "Search")] },
                        { id: "24", role: "textbox", name: "Search", value: "shoes", node: 24, props: { required: true } },
                        { id: "25", role: "textbox", name: "Password", value: "hunter2hunter2", node: 25 },
                        { id: "26", role: "checkbox", name: "I agree", node: 26, props: { checked: "false" } },
                        { id: "27", role: "combobox", name: "Size", value: "Small", node: 27, props: { expanded: false }, kids: [{ id: "28", role: "MenuListPopup", node: 28, kids: [{ id: "29", role: "option", name: "Small", node: 29, props: { selected: true } }] }] },
                        { id: "30", role: "button", name: "Go", node: 30, props: { disabled: true } },
                    ],
                },
                { id: "31", role: "status", node: 31 },
                { id: "32", role: "generic", ignored: true, node: 32, kids: [{ id: "33", role: "list", node: 33, kids: [{ id: "34", role: "listitem", node: 34, kids: [{ id: "35", role: "ListMarker", name: "• " }, text("36", "One")] }, { id: "37", role: "listitem", node: 37, kids: [text("38", "Two")] }] }] },
                { id: "39", role: "generic", node: 39, kids: [{ id: "40", role: "generic", node: 40 }] },
            ],
        },
    ],
};

/** What DOMSnapshot.captureSnapshot says of the shop: its links' targets, and the password field. */
export const SHOP_DOM = {
    strings: ["", "A", "href", "/other", "http://127.0.0.1:1234/", "INPUT", "type", "password", "#frag", "DIV"],
    documents: [{ baseURL: 4, nodes: { nodeName: [1, 5, 1, 9], backendNodeId: [4, 25, 6, 8], attributes: [[2, 3], [6, 7], [2, 8], []] } }],
};
