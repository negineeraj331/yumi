/**
 * inlineComplete — CodeMirror 6 ghost-text AI completion.
 * Debounces on typing, requests a completion, renders it as dim ghost text at
 * the cursor, and accepts it on Tab. Esc dismisses.
 */
import { StateField, StateEffect, Prec } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, ViewPlugin, type DecorationSet } from "@codemirror/view";

type Suggestion = { text: string; pos: number };

const setSuggestion = StateEffect.define<Suggestion | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: GhostWidget) { return o.text === this.text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.textContent = this.text;
    return span;
  }
}

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setSuggestion)) return e.value;
    if (tr.docChanged || tr.selection) return null; // any edit/cursor move clears it
    return val;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (val): DecorationSet => {
      if (!val || !val.text) return Decoration.none;
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(val.text), side: 1 }).range(val.pos),
      ]);
    }),
});

export function currentSuggestion(view: EditorView): Suggestion | null {
  return view.state.field(suggestionField, false) ?? null;
}

export function inlineComplete(request: (prefix: string, suffix: string) => Promise<string>) {
  let timer: number | undefined;
  let seq = 0;

  const requester = ViewPlugin.fromClass(
    class {
      update(u: any) {
        if (!u.docChanged) return;
        window.clearTimeout(timer);
        const view: EditorView = u.view;
        const mySeq = ++seq;
        timer = window.setTimeout(async () => {
          const state = view.state;
          const pos = state.selection.main.head;
          if (state.selection.main.empty === false) return;
          const prefix = state.doc.sliceString(0, pos);
          const suffix = state.doc.sliceString(pos);
          if (!prefix.trim()) return;
          const text = await request(prefix, suffix);
          // Only apply if nothing changed since the request fired.
          if (mySeq !== seq) return;
          if (view.state.selection.main.head !== pos || !text) return;
          view.dispatch({ effects: setSuggestion.of({ text, pos }) });
        }, 500);
      }
      destroy() { window.clearTimeout(timer); }
    }
  );

  const accept = Prec.highest(
    keymap.of([
      {
        key: "Tab",
        run: (view) => {
          const s = currentSuggestion(view);
          if (!s || !s.text) return false;
          view.dispatch({
            changes: { from: s.pos, insert: s.text },
            selection: { anchor: s.pos + s.text.length },
            effects: setSuggestion.of(null),
          });
          return true;
        },
      },
      {
        key: "Escape",
        run: (view) => {
          if (!currentSuggestion(view)) return false;
          view.dispatch({ effects: setSuggestion.of(null) });
          return true;
        },
      },
    ])
  );

  return [suggestionField, requester, accept];
}
