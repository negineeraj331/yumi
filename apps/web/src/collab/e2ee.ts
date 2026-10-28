/**
 * End-to-end encryption for sensitive projects.
 *
 * Everything here runs in the browser and uses only WebCrypto, so there is no
 * dependency to trust and no code path by which a key can reach the server.
 * The server stores and relays ciphertext it cannot read; see gateway.ts for
 * the other side of that contract.
 *
 * What is protected: document content (code and canvas), cursor/awareness
 * payloads, and chat message bodies.
 *
 * What is NOT, and is stated plainly in the UI rather than implied away:
 *   - Metadata. File names, member lists, timestamps, message authors and
 *     activity all remain server-side in the clear; they are what makes the
 *     product work at all.
 *   - Anything you run. Executing, testing, profiling or debugging a file
 *     sends that file to the sandbox in the clear, because a runtime cannot
 *     execute ciphertext. The encryption protects data at rest and in transit
 *     through the server, not a file you deliberately hand to an interpreter.
 *
 * Format: [1 byte version][12 byte IV][AES-256-GCM ciphertext+tag].
 */

export const E2EE_VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;

const subtle = () => {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error("This browser does not support WebCrypto, which end-to-end encryption requires");
  return c;
};

/* ------------------------------- key material ---------------------------- */

const b64urlEncode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (s: string): Uint8Array => {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm.padEnd(Math.ceil(norm.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** A fresh project key. 256 bits of randomness — never derived from a password. */
export function generateProjectKey(): string {
  const raw = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(raw);
  return b64urlEncode(raw);
}

export function isWellFormedKey(key: string): boolean {
  try { return b64urlDecode(key.trim()).length === KEY_BYTES; } catch { return false; }
}

export async function importProjectKey(key: string): Promise<CryptoKey> {
  const raw = b64urlDecode(key.trim());
  if (raw.length !== KEY_BYTES) throw new Error("That does not look like a project key");
  return subtle().importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * A value the server can hold to tell whether a pasted key is the right one,
 * without being able to derive the key from it.
 *
 * Safe because the key is 256 bits of randomness rather than a password: there
 * is no candidate list to hash through. The prefix keeps this digest from
 * colliding with any other use of the same key.
 */
export async function keyCheck(key: string): Promise<string> {
  const raw = b64urlDecode(key.trim());
  const salted = new Uint8Array(raw.length + 16);
  salted.set(new TextEncoder().encode("yumi-e2ee-check"), 0);
  salted.set(raw, 16);
  const digest = await subtle().digest("SHA-256", salted as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* -------------------------------- payloads -------------------------------- */

export async function encryptBytes(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource));
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = E2EE_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

/**
 * Returns null rather than throwing when the payload cannot be read: a wrong
 * key, a corrupt frame and a frame from a future format version all mean the
 * same thing to a caller — skip it — and one undecryptable update must never
 * take down the whole document.
 */
export async function decryptBytes(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array | null> {
  if (payload.length <= 1 + IV_BYTES) return null;
  if (payload[0] !== E2EE_VERSION) return null;
  const iv = payload.slice(1, 1 + IV_BYTES);
  const body = payload.slice(1 + IV_BYTES);
  try {
    const plain = await subtle().decrypt({ name: "AES-GCM", iv }, key, body as BufferSource);
    return new Uint8Array(plain);
  } catch {
    return null;   // authentication failed — wrong key, or tampered ciphertext
  }
}

export async function encryptText(key: CryptoKey, text: string): Promise<string> {
  return b64urlEncode(await encryptBytes(key, new TextEncoder().encode(text)));
}

export async function decryptText(key: CryptoKey, payload: string): Promise<string | null> {
  let bytes: Uint8Array;
  try { bytes = b64urlDecode(payload); } catch { return null; }
  const plain = await decryptBytes(key, bytes);
  return plain ? new TextDecoder().decode(plain) : null;
}

/* ------------------------------- local storage --------------------------- */

/**
 * The key lives only in this browser. There is deliberately no recovery path:
 * a key the server could restore is not a key the server does not have.
 */
const storageKey = (projectId: string) => `yumi:e2ee:${projectId}`;

export function loadStoredKey(projectId: string): string | null {
  try { return localStorage.getItem(storageKey(projectId)); } catch { return null; }
}

export function storeKey(projectId: string, key: string): void {
  try { localStorage.setItem(storageKey(projectId), key.trim()); } catch { /* private mode */ }
}

export function forgetKey(projectId: string): void {
  try { localStorage.removeItem(storageKey(projectId)); } catch { /* nothing to do */ }
}
