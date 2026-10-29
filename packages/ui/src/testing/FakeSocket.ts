// A WebSocket stand-in that a test drives from the server side.

type Listener = (ev: unknown) => void;

export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  /** Headers given to the constructor, as `ws` in Node takes them; a browser sends none. */
  headers: Record<string, string> = {};
  readyState = 0;
  binaryType: "blob" | "arraybuffer" = "blob";
  /** Frames the client sent: strings for JSON, `Uint8Array` for binary. */
  readonly sent: (string | Uint8Array)[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Called with each frame the client sends. */
  onClientMessage: ((data: string | Uint8Array) => void) | null = null;

  constructor(url: string, autoOpen = true) {
    this.url = url;
    if (autoOpen) queueMicrotask(() => this.serverOpen());
  }

  get query(): URLSearchParams {
    return new URL(this.url).searchParams;
  }

  get path(): string {
    return new URL(this.url).pathname;
  }

  addEventListener(type: string, fn: Listener) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }

  private fire(type: string, ev: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error("FakeSocket is not open.");
    const frame =
      typeof data === "string"
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
    this.sent.push(frame);
    this.onClientMessage?.(frame);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const ev = { code: 1000 };
    this.onclose?.(ev);
    this.fire("close", ev);
  }

  /** JSON frames the client sent, parsed. */
  get sentJson(): unknown[] {
    return this.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => JSON.parse(f) as unknown);
  }

  serverOpen() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
    this.fire("open", {});
  }

  /** Sends a frame to the client: an object as JSON text, bytes as binary. */
  serverSend(data: unknown) {
    let payload: unknown;
    if (typeof data === "string") payload = data;
    else if (data instanceof Uint8Array)
      payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    else payload = JSON.stringify(data);
    const ev = { data: payload };
    this.onmessage?.(ev);
    this.fire("message", ev);
  }

  serverClose() {
    this.close();
  }
}
