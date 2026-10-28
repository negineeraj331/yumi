/**
 * CodeMirror pieces for the shared debugger: a clickable breakpoint gutter and
 * a highlight on the line the debugger is currently stopped at.
 *
 * Both are driven by StateEffects rather than props, so breakpoint and location
 * changes never force the editor (and its Yjs binding) to be rebuilt.
 */
import { StateField, StateEffect, RangeSet } from "@codemirror/state";
import { gutter, GutterMarker, EditorView, Decoration, type DecorationSet } from "@codemirror/view";

/** Replace the whole breakpoint set (1-based line numbers). */
export const setBreakpointsEffect = StateEffect.define<number[]>();
/** Line the debugger is paused on, or null when not paused. */
export const setDebugLineEffect = StateEffect.define<number | null>();

export const breakpointsField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBreakpointsEffect)) return e.value;
    return value;
  },
});

export const debugLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDebugLineEffect)) return e.value;
    return value;
  },
});

class BreakpointMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-breakpoint";
    el.textContent = "●";
    return el;
  }
}
const breakpointMarker = new BreakpointMarker();

/** Highlight for the paused line. */
const debugLineDeco = Decoration.line({ class: "cm-debug-line" });

const debugLineDecorations = EditorView.decorations.compute([debugLineField], (state) => {
  const line = state.field(debugLineField);
  if (!line || line < 1 || line > state.doc.lines) return Decoration.none;
  const l = state.doc.line(line);
  return Decoration.set([debugLineDeco.range(l.from)]) as DecorationSet;
});

/**
 * The gutter itself. `onToggle` receives a 1-based line number; the caller owns
 * the breakpoint set (it lives on the server and is shared by the room), so
 * clicking only requests a change rather than applying one locally.
 */
export function debugGutter(onToggle: (line: number) => void) {
  return [
    breakpointsField,
    debugLineField,
    debugLineDecorations,
    gutter({
      class: "cm-breakpoint-gutter",
      lineMarker(view, block) {
        const line = view.state.doc.lineAt(block.from).number;
        return view.state.field(breakpointsField).includes(line) ? breakpointMarker : null;
      },
      // Recompute markers whenever the breakpoint set changes.
      lineMarkerChange: (update) =>
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setBreakpointsEffect))),
      initialSpacer: () => breakpointMarker,
      domEventHandlers: {
        mousedown(view, block) {
          onToggle(view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
    EditorView.baseTheme({
      ".cm-breakpoint-gutter": { width: "14px", cursor: "pointer" },
      ".cm-breakpoint": { color: "#E05252", fontSize: "13px", lineHeight: "1" },
    }),
  ];
}

export { RangeSet };
