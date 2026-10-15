import { render } from "solid-js/web";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/transcript.css";
import "./styles/composer.css";
import "./styles/overlays.css";
import "./styles/markdown.css";
import "./state/prefs";
import { start } from "./state/app";
import { App } from "./App";

start();
render(() => <App />, document.getElementById("root")!);
