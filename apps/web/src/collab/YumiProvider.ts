/**
 * YumiProvider — binds a Yjs document to the Yumi realtime gateway over Socket.io.
 * Sends/receives Yjs updates + awareness (cursors) for one docId. See TRD.md §3.
 *
 * For an end-to-end encrypted project the provider is given a CryptoKey, and
 * every payload is encrypted before it leaves and decrypted after it arrives.
 * The gateway then has nothing to apply, so it stores and replays the update
 * log instead of merging it — which is why sync arrives as a list of updates
 * rather than one merged state. See e2ee.ts.
 */
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";
import type { Socket } from "socket.io-client";
import { SOCKET_EVENTS } from "@yumi/shared";
import { encryptBytes, decryptBytes } from "./e2ee";

export class YumiProvider {
  doc: Y.Doc;
  awareness: Awareness;
  private socket: Socket;
  private docId: string;
  private synced = false;
  private key: CryptoKey | null;
  /** Local edits made before the first sync completes must still reach the server in order. */
  private outbound: Promise<void> = Promise.resolve();

  constructor(socket: Socket, docId: string, doc = new Y.Doc(), key: CryptoKey | null = null) {
    this.socket = socket;
    this.docId = docId;
    this.doc = doc;
    this.key = key;
    this.awareness = new Awareness(doc);

    // Local doc changes → send to gateway (skip updates we applied from remote)
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);

    // Remote handlers
    socket.on(SOCKET_EVENTS.SYNC_STEP, this.onSyncStep);
    socket.on(SOCKET_EVENTS.DOC_UPDATE, this.onRemoteDocUpdate);
    socket.on(SOCKET_EVENTS.AWARENESS, this.onRemoteAwareness);

    // Request the current server state for this doc (late-join sync)
    socket.emit(SOCKET_EVENTS.SYNC_STEP, { docId });
  }

  /** True once the server's state for this doc has been applied. */
  get isSynced() { return this.synced; }

  /**
   * Payloads are sent in the order they were produced. Encryption is async, so
   * without a queue two quick keystrokes could race and arrive reversed —
   * harmless for a CRDT, but it would scramble the persisted log's order.
   */
  private send(event: string, payload: Uint8Array) {
    this.outbound = this.outbound.then(async () => {
      const body = this.key ? await encryptBytes(this.key, payload) : payload;
      this.socket.emit(event, { docId: this.docId, update: body });
    }).catch((err) => {
      console.error("[e2ee] failed to send an update:", (err as Error).message);
    });
  }

  private async open(payload: ArrayBuffer): Promise<Uint8Array | null> {
    const bytes = new Uint8Array(payload);
    if (!this.key) return bytes;
    return decryptBytes(this.key, bytes);
  }

  private onSyncStep = async ({ docId, update, updates }: {
    docId: string; update?: ArrayBuffer; updates?: ArrayBuffer[];
  }) => {
    if (docId !== this.docId) return;
    // Encrypted projects get the raw log; plaintext ones get one merged state.
    const frames = updates ?? (update ? [update] : []);
    let skipped = 0;
    const decoded: Uint8Array[] = [];
    for (const frame of frames) {
      const plain = await this.open(frame);
      if (plain?.length) decoded.push(plain);
      else if (plain === null) skipped++;
    }
    // One transaction, so a large history does not repaint the editor per frame.
    Y.transact(this.doc, () => {
      for (const plain of decoded) {
        try { Y.applyUpdate(this.doc, plain, "remote"); }
        catch { skipped++; }
      }
    }, "remote");
    if (skipped) {
      console.warn(`[e2ee] ${skipped} update(s) could not be read for ${docId} — wrong key, or written by a different one`);
    }
    this.synced = true;
    this.onSynced?.(skipped);
  };

  /** Called once the initial state is applied; `skipped` counts unreadable frames. */
  onSynced: ((skipped: number) => void) | null = null;

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return; // don't echo remote updates back
    this.send(SOCKET_EVENTS.DOC_UPDATE, update);
  };

  private onRemoteDocUpdate = async ({ docId, update }: { docId: string; update: ArrayBuffer }) => {
    if (docId !== this.docId) return;
    const plain = await this.open(update);
    if (!plain?.length) return;   // not ours to read; another key's project data
    try { Y.applyUpdate(this.doc, plain, "remote"); }
    catch (err) { console.error("[collab] discarding an unusable update:", (err as Error).message); }
  };

  private onAwarenessUpdate = ({ added, updated, removed }: any) => {
    const changed = [...added, ...updated, ...removed];
    // Cursor positions say something about the document, so they are encrypted
    // on the same terms as its contents.
    this.send(SOCKET_EVENTS.AWARENESS, encodeAwarenessUpdate(this.awareness, changed));
  };

  private onRemoteAwareness = async ({ docId, update }: { docId: string; update: ArrayBuffer }) => {
    if (docId !== this.docId) return;
    const plain = await this.open(update);
    if (!plain?.length) return;
    try { applyAwarenessUpdate(this.awareness, plain, "remote"); }
    catch { /* a stale or unreadable cursor frame is not worth reporting */ }
  };

  destroy() {
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.socket.off(SOCKET_EVENTS.SYNC_STEP, this.onSyncStep);
    this.socket.off(SOCKET_EVENTS.DOC_UPDATE, this.onRemoteDocUpdate);
    this.socket.off(SOCKET_EVENTS.AWARENESS, this.onRemoteAwareness);
    this.awareness.destroy();
  }
}
