// Settings loads when it's first opened: its pages and their styles aren't part of what startup fetches.
// The gear warms it on hover, so the page is there by the click.
export const loadSettings = () => import("../components/Settings");
