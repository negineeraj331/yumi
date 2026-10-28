/**
 * SlackModal — connect the project to a Slack channel via an incoming webhook
 * and choose which events notify it.
 *
 * The webhook URL is the credential (anyone holding it can post to the channel),
 * so it is stored server-side and never returned — this UI only knows whether
 * one is set (hasWebhook). Linking posts a confirmation message, so a bad URL
 * fails immediately rather than silently never delivering.
 */
import { useEffect, useState } from "react";
import { SLACK_EVENTS } from "@yumi/shared";
import { api, type SlackLink } from "../api";
import { useToast } from "../toast";

export function SlackModal({ projectId, editable, onClose }: {
  projectId: string; editable: boolean; onClose: () => void;
}) {
  const { notify } = useToast();
  const [link, setLink] = useState<SlackLink | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSlack(projectId)
      .then(({ slack }) => setLink(slack))
      .catch((e) => setError(String(e.message ?? e)));
  }, [projectId]);

  async function unlink() {
    if (!window.confirm("Disconnect Slack? Notifications for this project will stop.")) return;
    try { await api.unlinkSlack(projectId); setLink(null); notify("Slack disconnected", "info"); }
    catch (e: any) { notify(e.message, "error"); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal replay-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>
            ✳ Slack {link?.channelLabel && <span className="mono" style={{ fontSize: 13, color: "var(--ink-muted)" }}>· {link.channelLabel}</span>}
          </h3>
          <div className="row" style={{ gap: 8 }}>
            {link && editable && <button className="btn btn-secondary btn-sm" onClick={unlink}>Disconnect</button>}
            <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>

        {error && <div className="meta" style={{ color: "var(--error)", marginTop: 12 }}>{error}</div>}
        {link === undefined && !error && <div className="meta" style={{ marginTop: 12 }}>Loading…</div>}
        {link === null && !error && <LinkForm projectId={projectId} editable={editable} onLinked={setLink} />}
        {link && <Settings projectId={projectId} link={link} editable={editable} onChange={setLink} />}
      </div>
    </div>
  );
}

/* ---------------------------------- Link ---------------------------------- */

function LinkForm({ projectId, editable, onLinked }: {
  projectId: string; editable: boolean; onLinked: (l: SlackLink) => void;
}) {
  const { notify } = useToast();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [channelLabel, setChannelLabel] = useState("");
  // Default to the failure-biased events: quiet unless something needs attention.
  const [events, setEvents] = useState<string[]>(["run.failed", "tests.failed"]);
  const [busy, setBusy] = useState(false);

  if (!editable) return <div className="meta" style={{ marginTop: 16 }}>Slack is not connected. An editor can connect it.</div>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!webhookUrl.trim()) { notify("Paste a Slack incoming webhook URL", "error"); return; }
    setBusy(true);
    try {
      const { slack } = await api.linkSlack(projectId, {
        webhookUrl: webhookUrl.trim(),
        channelLabel: channelLabel.trim() || undefined,
        events,
      });
      notify("Slack connected — check the channel for a confirmation", "success");
      onLinked(slack);
    } catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="field">
        <label className="label">Incoming webhook URL</label>
        <input className="input" type="password" placeholder="https://hooks.slack.com/services/…"
          value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} autoComplete="off" autoFocus />
      </div>
      <div className="field">
        <label className="label">Channel label <span className="meta">(optional, for display)</span></label>
        <input className="input" placeholder="#eng-standup" value={channelLabel} onChange={(e) => setChannelLabel(e.target.value)} />
      </div>
      <EventPicker events={events} onChange={setEvents} disabled={busy} />
      <div className="meta">
        Create a webhook in Slack under Apps → Incoming Webhooks. The URL is a credential —
        it is stored server-side, never shown again, and anyone with it can post to that channel.
      </div>
      <button className="btn btn-primary" disabled={busy}>{busy ? "Connecting…" : "Connect Slack"}</button>
    </form>
  );
}

/* -------------------------------- Settings -------------------------------- */

function Settings({ projectId, link, editable, onChange }: {
  projectId: string; link: SlackLink; editable: boolean; onChange: (l: SlackLink) => void;
}) {
  const { notify } = useToast();
  const [events, setEvents] = useState<string[]>(link.events);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const dirty = JSON.stringify([...events].sort()) !== JSON.stringify([...link.events].sort());

  async function save() {
    setBusy(true);
    try { const { slack } = await api.updateSlackEvents(projectId, events); onChange(slack); notify("Notifications updated", "success"); }
    catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(false); }
  }

  async function sendTest() {
    setTesting(true);
    try { await api.testSlack(projectId); notify("Test message sent", "success"); }
    catch (e: any) { notify(e.message, "error"); }
    finally { setTesting(false); }
  }

  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="meta">
        Connected{link.linkedAt ? ` ${new Date(link.linkedAt).toLocaleDateString()}` : ""}. The webhook URL is stored
        server-side and is never shown again — reconnect to change it.
      </div>
      <EventPicker events={events} onChange={setEvents} disabled={!editable || busy} />
      <div className="row" style={{ gap: 8 }}>
        {editable && <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || !dirty}>
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>}
        {editable && <button className="btn btn-secondary btn-sm" onClick={sendTest} disabled={testing}>
          {testing ? "Sending…" : "Send test message"}
        </button>}
      </div>
    </div>
  );
}

function EventPicker({ events, onChange, disabled }: {
  events: string[]; onChange: (e: string[]) => void; disabled?: boolean;
}) {
  const toggle = (id: string) =>
    onChange(events.includes(id) ? events.filter((e) => e !== id) : [...events, id]);

  return (
    <div className="field">
      <label className="label">Notify when</label>
      <div className="shortcut-grid">
        {SLACK_EVENTS.map((e) => (
          <label key={e.id} className="shortcut-row" style={{ cursor: disabled ? "default" : "pointer" }}>
            <span>{e.label}</span>
            <input type="checkbox" checked={events.includes(e.id)} disabled={disabled}
              onChange={() => toggle(e.id)} />
          </label>
        ))}
      </div>
    </div>
  );
}
