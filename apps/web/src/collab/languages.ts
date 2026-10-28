import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";

/** Map a stored language id → CodeMirror language extension. */
export function languageExtension(lang: string): Extension[] {
  switch (lang) {
    case "javascript": return [javascript()];
    case "typescript": return [javascript({ typescript: true })];
    case "python": return [python()];
    case "java": return [java()];
    case "cpp": return [cpp()];
    case "html": return [html()];
    case "css": return [css()];
    case "json": return [json()];
    case "markdown": return [markdown()];
    case "go": return [go()];
    case "rust": return [rust()];
    default: return [];
  }
}
