export interface LinkRequest {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body?: Buffer;
}
export interface LinkResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export interface LinkStream {
  send(data: Buffer | string, binary: boolean): void;
  onMessage(cb: (data: Buffer, binary: boolean) => void): void;
  close(code?: number, reason?: string): void;
  onClose(cb: (code: number, reason: string) => void): void;
  /**
   * Names the backlog of the sink that the stream's messages go to, such as
   * a relayed client socket's unsent bytes. A stream with flow control then
   * grants the sender more credit only while that backlog is under half a
   * window, so a slow sink holds the sender back instead of filling memory.
   */
  setSinkBacklog?(backlog: () => number): void;
}
export interface NodeLink {
  readonly machineId: string;
  /** Sends a request. `timeoutMs` replaces the link's default wait for the answer. */
  request(req: LinkRequest, options?: { timeoutMs?: number }): Promise<LinkResponse>;
  openStream(req: Omit<LinkRequest, "body" | "method">): Promise<LinkStream>;
  onClose(cb: () => void): void;
}
/** On the hub: links to connected nodes. On a plain node: one entry, the hub, under id "hub". */
export interface LinkRegistry {
  get(machineId: string): NodeLink | undefined;
  list(): string[];
}
