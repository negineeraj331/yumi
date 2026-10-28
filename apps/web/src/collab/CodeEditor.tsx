/**
 * CodeEditor — CodeMirror 6 bound to a Yjs doc via YumiProvider.
 * Multi-cursor editing with remote cursors/selections + name labels (yCollab).
 */
import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { yCollab } from "y-codemirror.next";
import type { Socket } from "socket.io-client";
import type { PublicUser } from "@yumi/shared";
import * as Y from "yjs";
import { YumiProvider } from "./YumiProvider";
import { languageExtension } from "./languages";
import { inlineComplete } from "./inlineComplete";
import { debugGutter, setBreakpointsEffect, setDebugLineEffect } from "./debugGutter";
import { SOCKET_EVENTS } from "@yumi/shared";

/** Bridge one inline-completion request over Socket.io, resolving on the matching id. */
function makeCompleter(socket: Socket, language: string) {
  let counter = 0;
  return (prefix: string, suffix: string): Promise<string> =>
    new Promise((resolve) => {
      const id = `cmpl-${++counter}`;
      let done = false;
      const finish = (text: string) => {
        if (done) return;
        done = true;
        socket.off(SOCKET_EVENTS.AI_COMPLETION, onCompletion);
        clearTimeout(timer);
        resolve(text);
      };
      const onCompletion = (data: { id: string; text: string }) => {
        if (data.id === id) finish(typeof data.text === "string" ? data.text : "");
      };
      const timer = setTimeout(() => finish(""), 8000);
      socket.on(SOCKET_EVENTS.AI_COMPLETION, onCompletion);
      socket.emit(SOCKET_EVENTS.AI_COMPLETE, { id, prefix, suffix, language });
    });
}

interface Props {
  socket: Socket;
  docId: string;
  user: PublicUser;
  editable: boolean;
  language: string;
  /** Populated with a getter that returns the current document text (for Run). */
  contentRef?: React.MutableRefObject<(() => string) | null>;
  /** Present when the project is end-to-end encrypted; payloads are sealed with it. */
  cryptoKey?: CryptoKey | null;
  /** Shared debugger: breakpoint lines, the paused line, and a toggle request. */
  debuggable?: boolean;
  breakpoints?: number[];
  debugLine?: number | null;
  onToggleBreakpoint?: (line: number) => void;
}

export function CodeEditor({
  socket, docId, user, editable, language, contentRef, cryptoKey = null,
  debuggable = false, breakpoints, debugLine = null, onToggleBreakpoint,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Kept in a ref so the gutter handler always calls the latest callback
  // without the editor having to be rebuilt.
  const toggleRef = useRef(onToggleBreakpoint);
  toggleRef.current = onToggleBreakpoint;

  useEffect(() => {
    if (!hostRef.current) return;
    const provider = new YumiProvider(socket, docId, undefined, cryptoKey);
    const ytext = provider.doc.getText("codemirror");
    if (contentRef) contentRef.current = () => ytext.toString();

    provider.awareness.setLocalStateField("user", {
      name: user.displayName,
      color: user.avatarColor,
      colorLight: user.avatarColor + "33",
    });

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        bracketMatching(),
        indentOnInput(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...languageExtension(language),
        yCollab(ytext, provider.awareness, { undoManager: new Y.UndoManager(ytext) }),
        ...(editable ? [inlineComplete(makeCompleter(socket, language))] : []),
        ...(debuggable ? debugGutter((line) => toggleRef.current?.(line)) : []),
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      if (contentRef) contentRef.current = null;
      viewRef.current = null;
      view.destroy();
      provider.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, editable, language, debuggable]);

  // Push debugger state into the editor without rebuilding it.
  useEffect(() => {
    if (!debuggable || !viewRef.current) return;
    viewRef.current.dispatch({ effects: setBreakpointsEffect.of(breakpoints ?? []) });
  }, [breakpoints, debuggable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!debuggable || !view) return;
    view.dispatch({ effects: setDebugLineEffect.of(debugLine) });
    // Scroll the paused line into view so everyone follows the same spot.
    if (debugLine && debugLine >= 1 && debugLine <= view.state.doc.lines) {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(debugLine).from, { y: "center" }) });
    }
  }, [debugLine, debuggable]);

  return <div ref={hostRef} className="editor-host" />;
}
