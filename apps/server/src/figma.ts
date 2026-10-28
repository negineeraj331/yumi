/**
 * Thin Figma REST API wrapper (read-only). Figma has no anonymous API, so a
 * personal access token is always required; it lives server-side only and is
 * never returned to clients — same rule as the GitHub PAT.
 *
 * Frame images are proxied through the server rather than handed to the browser
 * as Figma's S3 URLs: those URLs expire, and proxying sidesteps CORS entirely.
 * The proxy returns a data URL, which is what canvas image shapes already store.
 */
const API = process.env.FIGMA_API_BASE || "https://api.figma.com";

/** Cap on a proxied image so one insert can't blow up the Yjs doc. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function figmaHeaders(token: string): Record<string, string> {
  return { "X-Figma-Token": token, "User-Agent": "Yumi" };
}

async function figma(path: string, token: string): Promise<any> {
  const res = await fetch(API + path, { headers: figmaHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: any = new Error(
      res.status === 404 ? "Figma file not found (check the URL, and that your token can see it)"
      : res.status === 403 ? "Figma denied access — the token may be invalid or lack access to this file."
      : res.status === 429 ? "Figma rate limit reached — try again shortly."
      : `Figma error ${res.status}: ${body.slice(0, 160)}`
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export interface FigmaFrame {
  id: string;
  name: string;
  type: string;
  width: number | null;
  height: number | null;
}
export interface FigmaPage { id: string; name: string; frames: FigmaFrame[] }
export interface FigmaFileMeta { fileKey: string; name: string; lastModified: string | null; pages: FigmaPage[] }

const box = (n: any) => ({
  width: typeof n?.absoluteBoundingBox?.width === "number" ? Math.round(n.absoluteBoundingBox.width) : null,
  height: typeof n?.absoluteBoundingBox?.height === "number" ? Math.round(n.absoluteBoundingBox.height) : null,
});

/** Top-level renderable children of each page — what a user would actually export. */
const RENDERABLE = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "SECTION"]);

/**
 * File metadata + one level of frames per page. `depth=2` keeps the response
 * small: a full Figma document tree can be tens of MB.
 */
export async function getFile(fileKey: string, token: string): Promise<FigmaFileMeta> {
  const f = await figma(`/v1/files/${encodeURIComponent(fileKey)}?depth=2`, token);
  const pages: FigmaPage[] = (f.document?.children ?? [])
    .filter((p: any) => p?.type === "CANVAS")
    .map((p: any) => ({
      id: p.id,
      name: p.name,
      frames: (p.children ?? [])
        .filter((n: any) => RENDERABLE.has(n?.type))
        .map((n: any) => ({ id: n.id, name: n.name, type: n.type, ...box(n) })),
    }));
  return { fileKey, name: f.name ?? fileKey, lastModified: f.lastModified ?? null, pages };
}

/** Ask Figma to render nodes to PNGs. Returns nodeId → temporary URL. */
export async function renderImages(
  fileKey: string, nodeIds: string[], token: string, scale = 2,
): Promise<Record<string, string | null>> {
  if (nodeIds.length === 0) return {};
  const q = new URLSearchParams({ ids: nodeIds.join(","), format: "png", scale: String(scale) });
  const r = await figma(`/v1/images/${encodeURIComponent(fileKey)}?${q}`, token);
  if (r.err) {
    const err: any = new Error(`Figma could not render that frame: ${r.err}`);
    err.status = 502;
    throw err;
  }
  return r.images ?? {};
}

/**
 * Fetch a rendered PNG and return it as a data URL. Figma's render URLs are
 * short-lived and cross-origin, so the browser must not fetch them directly.
 */
export async function fetchImageAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    const err: any = new Error(`Could not download the rendered image (${res.status})`);
    err.status = 502;
    throw err;
  }
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_IMAGE_BYTES) {
    const err: any = new Error("Rendered image is too large — try a smaller scale.");
    err.status = 413;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    const err: any = new Error("Rendered image is too large — try a smaller scale.");
    err.status = 413;
    throw err;
  }
  const mime = res.headers.get("content-type")?.split(";")[0] || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Render one node and return it inline, ready to drop onto the canvas. */
export async function renderNodeDataUrl(
  fileKey: string, nodeId: string, token: string, scale = 2,
): Promise<{ nodeId: string; dataUrl: string }> {
  const images = await renderImages(fileKey, [nodeId], token, scale);
  const url = images[nodeId];
  if (!url) {
    const err: any = new Error("Figma returned no image for that frame.");
    err.status = 404;
    throw err;
  }
  return { nodeId, dataUrl: await fetchImageAsDataUrl(url) };
}
