// Review comments sent from the GUI's diff pane quote the lines they're on.

const REVIEW_BLOCK = /<review_comment file="[^"]*" lines="[^"]*">\n([\s\S]*?)\n<\/review_comment>/g;
/**
 * The text without each review comment's quoted diff lines (gui/src/lib/review-comments): the
 * repository's code, not something the user named, so @path and $skill mentions aren't looked
 * for there. What the user wrote above it still counts, a diff of their own in it too. The
 * quote is found from the block's end, as the GUI reads it back: its fence is longer than any
 * run of backticks inside it, and a closing tag inside is escaped.
 */
export function withoutReviewQuotes(text: string): string {
    if (!text.includes("<review_comment ")) return text;
    return text.replace(REVIEW_BLOCK, (block, body: string) => {
        const closing = body.lastIndexOf("\n");
        const fence = body.slice(closing + 1);
        if (!/^`{3,}$/.test(fence)) return block;
        const open = body.lastIndexOf(`\n\n${fence}diff\n`, closing);
        return open < 0 ? block : block.slice(0, block.indexOf(">\n") + 2) + body.slice(0, open) + "\n</review_comment>";
    });
}
