// The HTML spec's character references, for Find's text where there's no page to read them (the server: find-text.ts
// setEntityDecoder). Not imported by the window: it reads them with its own parser.
export { decodeHTML } from "entities";
