/**
 * Slack notifications via an incoming webhook.
 *
 * The webhook URL is itself the credential (anyone holding it can post to the
 * channel), so it is stored server-side and never returned to clients — same
 * rule as the GitHub/Figma tokens.
 *
 * Everything here is fail-soft: a Slack outage, a revoked webhook or a slow
 * response must never break a live session, so notify() resolves to a boolean
 * and never throws. See rules.md §3.7 (a dependency must not take the app down).
 */
import type { SlackEvent } from "@yumi/shared";

const TIMEOUT_MS = 5_000;

/** Slack's own limit is 4000 chars per text block; stay well under it. */
const MAX_TEXT = 2_800;

export interface SlackMessage {
  text: string;              // fallback / notification text
  context?: string[];        // small grey lines under the message
  detail?: string;           // fenced block (e.g. failing test output)
}

const trunc = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + "\n…[truncated]" : s);

/** Build Block Kit blocks. `text` stays as the fallback so notifications read well. */
function toBlocks(msg: SlackMessage): any[] {
  const blocks: any[] = [{ type: "section", text: { type: "mrkdwn", text: trunc(msg.text) } }];
  if (msg.detail?.trim()) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "```" + trunc(msg.detail.trim(), 2_500) + "```" } });
  }
  if (msg.context?.length) {
    blocks.push({ type: "context", elements: msg.context.slice(0, 8).map((t) => ({ type: "mrkdwn", text: trunc(t, 300) })) });
  }
  return blocks;
}

/**
 * POST to an incoming webhook. Returns true on success; never throws.
 * `reason` is surfaced by the "send test message" route so a user linking a
 * webhook finds out immediately that it's wrong.
 */
export async function postWebhook(webhookUrl: string, msg: SlackMessage): Promise<{ ok: boolean; reason?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: trunc(msg.text), blocks: toBlocks(msg) }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      // Slack answers "invalid_token"/"no_service" in the body, not the status.
      return { ok: false, reason: `Slack responded ${res.status}${body ? `: ${body}` : ""}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.name === "AbortError" ? "Slack request timed out" : (e?.message ?? "Slack request failed") };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- Message builders --------------------------- */

interface Ctx { projectName: string; actor?: string; fileName?: string }

export function buildMessage(event: SlackEvent, ctx: Ctx, data: any = {}): SlackMessage {
  const where = `*${ctx.projectName}*`;
  switch (event) {
    case "run.failed":
      return {
        text: `:x: Run failed in ${where}${ctx.fileName ? ` — \`${ctx.fileName}\`` : ""}`,
        context: [ctx.actor ? `run by ${ctx.actor}` : "", data.exitCode != null ? `exit ${data.exitCode}` : ""].filter(Boolean),
        detail: data.timedOut ? "Timed out" : (data.stderr || data.error || ""),
      };
    case "tests.failed":
      return {
        text: `:rotating_light: Tests failed in ${where}${ctx.fileName ? ` — \`${ctx.fileName}\`` : ""}`,
        context: [
          ctx.actor ? `run by ${ctx.actor}` : "",
          data.total > 0 ? `${data.passed}/${data.total} passed, ${data.failed} failed` : "",
        ].filter(Boolean),
        detail: data.stderr || data.error || "",
      };
    case "member.joined":
      return {
        text: `:wave: ${ctx.actor ?? "Someone"} joined the session in ${where}`,
        context: data.participants ? [`${data.participants} in the session`] : [],
      };
    case "session.ended": {
      const mins = Math.max(1, Math.round((data.durationSec ?? 0) / 60));
      return {
        text: `:white_check_mark: Session ended in ${where}`,
        context: [
          `${mins} min`,
          `${data.participantCount ?? 0} participant${data.participantCount === 1 ? "" : "s"}`,
          `${data.messages ?? 0} message${data.messages === 1 ? "" : "s"}`,
        ],
      };
    }
  }
}

/** Send `event` for a project if that project has Slack linked and the event enabled. */
export async function notify(
  slack: { webhookUrl?: string; events?: string[] } | null | undefined,
  event: SlackEvent, ctx: Ctx, data: any = {},
): Promise<boolean> {
  if (!slack?.webhookUrl) return false;
  if (!slack.events?.includes(event)) return false;
  const r = await postWebhook(slack.webhookUrl, buildMessage(event, ctx, data));
  if (!r.ok) console.warn(`[slack] ${event} not delivered: ${r.reason}`);
  return r.ok;
}
