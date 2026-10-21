// Copies the provider marks the GUI already ships (ProviderIcon.tsx, from Lobe Icons, MIT) into providers.js.
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(new URL("../../../gui/src/components/ui/ProviderIcon.tsx", import.meta.url), "utf8");
const start = src.indexOf("{", src.indexOf("MARKS"));
const end = src.indexOf("\n};", start);
const marks = new Function(`return ${src.slice(start, end + 2)}`)();
writeFileSync(new URL("../providers.js", import.meta.url), `window.PROVIDERS=${JSON.stringify(marks)};\n`);
console.log(Object.keys(marks).join(" "));
