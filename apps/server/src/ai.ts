/**
 * AI assistant — Anthropic SDK. Uses claude-opus-4-8 with adaptive thinking,
 * streamed to the client. Degrades gracefully when no API key is configured.
 */
import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;

/** Only construct the client when a key is present, so the app runs without one. */
const client = apiKey ? new Anthropic({ apiKey }) : null;

export function isAIConfigured(): boolean {
  return client !== null;
}

const SYSTEM = `You are Yumi's built-in coding assistant, embedded in a collaborative workspace.
Help the team write, understand, debug, and improve code. Be concise and practical:
lead with the answer, show code when it helps, and explain only what matters. When given
code context, ground your answer in it. Prefer runnable, correct examples.`;

export interface AiTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Stream an assistant reply. Calls onChunk for each text delta; resolves with the
 * full text. `codeContext` is the current file's contents (optional).
 */
export async function streamAssistant(
  history: AiTurn[],
  codeContext: string | undefined,
  onChunk: (text: string) => void
): Promise<string> {
  if (!client) throw new Error("AI is not configured. Set ANTHROPIC_API_KEY on the server.");

  const messages: Anthropic.MessageParam[] = [];
  if (codeContext && codeContext.trim()) {
    messages.push({
      role: "user",
      content: `Here is the code I'm currently working on for context:\n\n\`\`\`\n${codeContext.slice(0, 40_000)}\n\`\`\``,
    });
    messages.push({ role: "assistant", content: "Got it — I have the code in context. What would you like help with?" });
  }
  for (const t of history) messages.push({ role: t.role, content: t.text });

  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages,
  });

  stream.on("text", (delta) => onChunk(delta));
  const final = await stream.finalMessage();
  const text = final.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text;
}

const COMPLETE_SYSTEM = `You are a code completion engine. Given the code before the cursor (PREFIX)
and after the cursor (SUFFIX), output ONLY the text to insert at the cursor to continue the code.
Rules: no explanations, no markdown, no code fences, no repetition of the surrounding code.
Keep it short — usually the rest of the current line or a few lines. If nothing sensible fits, output nothing.`;

function stripFences(s: string): string {
  const m = s.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : s);
}

/** Fast, short inline completion for the code editor. */
export async function completeCode(prefix: string, suffix: string, language: string): Promise<string> {
  if (!client) return "";
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 160,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: COMPLETE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Language: ${language}\n<PREFIX>\n${prefix.slice(-6000)}\n</PREFIX>\n<SUFFIX>\n${suffix.slice(0, 2000)}\n</SUFFIX>\n\nInsertion text only:`,
      },
    ],
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  return stripFences(text.trim());
}
