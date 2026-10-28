/**
 * Keyboard shortcuts + layout snapshots for the session workspace. Shortcuts are
 * customizable (per-key rebind) and layout snapshots are named panel arrangements
 * — both persisted in localStorage, so they follow the user across sessions.
 */
import { useEffect, useRef, useState } from "react";

export interface ShortcutAction { id: string; label: string; defaultKey: string }

// The action set. `handlers` in useShortcuts is keyed by these ids.
export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "run", label: "Run file", defaultKey: "r" },
  { id: "test", label: "Run tests", defaultKey: "t" },
  { id: "perf", label: "Profile performance", defaultKey: "m" },
  { id: "terminal", label: "Toggle terminal", defaultKey: "j" },
  { id: "chat", label: "Chat panel", defaultKey: "1" },
  { id: "ai", label: "AI panel", defaultKey: "2" },
  { id: "activity", label: "Activity panel", defaultKey: "3" },
  { id: "debug", label: "Debug panel", defaultKey: "4" },
  { id: "sidebar", label: "Toggle file sidebar", defaultKey: "[" },
  { id: "rightPanel", label: "Toggle right panel", defaultKey: "]" },
  { id: "focus", label: "Focus mode (hide side panels)", defaultKey: "\\" },
  { id: "preview", label: "Toggle live preview", defaultKey: "p" },
  { id: "replay", label: "Open replay", defaultKey: "y" },
  { id: "github", label: "Open GitHub", defaultKey: "g" },
  { id: "figma", label: "Open Figma", defaultKey: "f" },
  { id: "slack", label: "Open Slack", defaultKey: "k" },
  { id: "help", label: "Shortcuts & layouts", defaultKey: "?" },
];

const KEYMAP_LS = "yumi.shortcuts";

export type Keymap = Record<string, string>; // actionId → key

export function defaultKeymap(): Keymap {
  return Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultKey]));
}

export function loadKeymap(): Keymap {
  const km = defaultKeymap();
  try {
    const saved = JSON.parse(localStorage.getItem(KEYMAP_LS) || "{}");
    for (const a of SHORTCUT_ACTIONS) if (typeof saved[a.id] === "string" && saved[a.id]) km[a.id] = saved[a.id];
  } catch { /* ignore malformed */ }
  return km;
}

export function saveKeymap(km: Keymap) {
  try { localStorage.setItem(KEYMAP_LS, JSON.stringify(km)); } catch { /* quota / disabled */ }
}

function isEditableTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n) return false;
  const tag = n.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || n.isContentEditable;
}

/**
 * Bind the keymap to `handlers`. A shortcut fires only when focus is NOT in an
 * editor/input and no ctrl/meta/alt modifier is held, so typing and browser
 * shortcuts are never intercepted.
 */
export function useShortcuts(handlers: Record<string, (() => void) | undefined>, keymap: Keymap) {
  const hRef = useRef(handlers); hRef.current = handlers;
  const kRef = useRef(keymap); kRef.current = keymap;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const key = e.key;
      for (const [actionId, k] of Object.entries(kRef.current)) {
        if (k === key) {
          const fn = hRef.current[actionId];
          if (fn) { e.preventDefault(); fn(); }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/* ------------------------------ Layout snapshots ------------------------- */

export interface LayoutSnapshot {
  name: string;
  layout: { sidebar: boolean; rightPanel: boolean };
  rightTab: "chat" | "ai" | "activity" | "debug";
  showTerminal: boolean;
}

const SNAPSHOTS_LS = "yumi.layouts";

export function loadSnapshots(): LayoutSnapshot[] {
  try { const v = JSON.parse(localStorage.getItem(SNAPSHOTS_LS) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
export function saveSnapshots(s: LayoutSnapshot[]) {
  try { localStorage.setItem(SNAPSHOTS_LS, JSON.stringify(s)); } catch { /* noop */ }
}

/* --------------------------------- Modal --------------------------------- */

function keyLabel(k: string): string {
  if (k === " ") return "Space";
  if (k === "\\") return "\\";
  return k.length === 1 ? k.toUpperCase() : k;
}

export function ShortcutsModal({ keymap, onChangeKeymap, currentSnapshot, onApplySnapshot, onClose }: {
  keymap: Keymap;
  onChangeKeymap: (km: Keymap) => void;
  currentSnapshot: Omit<LayoutSnapshot, "name">;
  onApplySnapshot: (s: LayoutSnapshot) => void;
  onClose: () => void;
}) {
  const [rebinding, setRebinding] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<LayoutSnapshot[]>(() => loadSnapshots());
  const [snapName, setSnapName] = useState("");

  // While rebinding, the next key press becomes that action's shortcut.
  useEffect(() => {
    if (!rebinding) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRebinding(null); return; }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const next = { ...keymap, [rebinding]: e.key };
      onChangeKeymap(next); saveKeymap(next);
      setRebinding(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rebinding, keymap, onChangeKeymap]);

  function resetKeys() { const d = defaultKeymap(); onChangeKeymap(d); saveKeymap(d); }

  function saveSnapshot() {
    const name = snapName.trim(); if (!name) return;
    const next = [{ name, ...currentSnapshot }, ...snapshots.filter((s) => s.name !== name)].slice(0, 12);
    setSnapshots(next); saveSnapshots(next); setSnapName("");
  }
  function deleteSnapshot(name: string) {
    const next = snapshots.filter((s) => s.name !== name);
    setSnapshots(next); saveSnapshots(next);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal replay-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>⌘ Shortcuts &amp; layouts</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: "16px 0 6px" }}>
          <span className="meta">Keyboard shortcuts</span>
          <button className="btn btn-secondary btn-sm" onClick={resetKeys}>Reset to defaults</button>
        </div>
        <div className="shortcut-grid">
          {SHORTCUT_ACTIONS.map((a) => (
            <div key={a.id} className="shortcut-row">
              <span>{a.label}</span>
              <button className={`kbd-btn ${rebinding === a.id ? "rebinding" : ""}`}
                onClick={() => setRebinding(a.id)}
                title="Click, then press a key to rebind">
                {rebinding === a.id ? "press a key…" : <kbd>{keyLabel(keymap[a.id])}</kbd>}
              </button>
            </div>
          ))}
        </div>
        <div className="meta" style={{ marginTop: 8 }}>Shortcuts fire only when you're not typing in the editor or a text field.</div>

        <div className="meta" style={{ margin: "18px 0 8px" }}>Layout snapshots</div>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input className="input" placeholder="snapshot name" value={snapName}
            onChange={(e) => setSnapName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveSnapshot(); }} />
          <button className="btn btn-primary btn-sm" onClick={saveSnapshot} disabled={!snapName.trim()}>Save current</button>
        </div>
        {snapshots.length === 0 && <div className="meta">No saved layouts yet. Arrange the panels, name it, and save.</div>}
        {snapshots.map((s) => (
          <div key={s.name} className="shortcut-row">
            <span>{s.name} <span className="meta">
              {[s.layout.sidebar && "sidebar", s.layout.rightPanel && `${s.rightTab}`, s.showTerminal && "terminal"].filter(Boolean).join(" · ") || "editor only"}
            </span></span>
            <span className="row" style={{ gap: 6 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => onApplySnapshot(s)}>Apply</button>
              <button className="btn btn-secondary btn-sm" onClick={() => deleteSnapshot(s.name)}>✕</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
