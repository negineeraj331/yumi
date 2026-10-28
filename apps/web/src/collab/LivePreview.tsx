import { useEffect, useState } from "react";

/**
 * LivePreview — renders the current HTML in a sandboxed iframe, refreshing as
 * the code changes. `sandbox="allow-scripts"` isolates it from the parent app.
 */
export function LivePreview({ getHtml }: { getHtml: () => string | undefined }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let last = "";
    const tick = () => {
      const next = getHtml() ?? "";
      if (next !== last) { last = next; setHtml(next); }
    };
    tick();
    const id = setInterval(tick, 600);
    return () => clearInterval(id);
  }, [getHtml]);

  return (
    <div className="preview-col">
      <div className="pane-head meta">Live preview</div>
      <iframe
        className="live-preview"
        title="Live preview"
        sandbox="allow-scripts allow-modals allow-forms"
        srcDoc={html}
      />
    </div>
  );
}
