// JSON with comments, as settings files allow.

/** Allow // and /* *\/ comments and trailing commas in settings files. Strings are respected. */
export function stripJsonComments(text: string): string {
    return stripTrailingCommas(stripComments(text));
}

function stripTrailingCommas(text: string): string {
    let out = "";
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (inStr) {
            out += c;
            if (c === "\\") out += text[++i] ?? "";
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        if (c === ",") {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j]!)) j++;
            if (text[j] === "}" || text[j] === "]") continue;
        }
        out += c;
    }
    return out;
}

function stripComments(text: string): string {
    let out = "";
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        const n = text[i + 1];
        if (inStr) {
            out += c;
            if (c === "\\") {
                out += n ?? "";
                i++;
            } else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
        } else if (c === "/" && n === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (c === "/" && n === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i++;
        } else out += c;
    }
    return out;
}
