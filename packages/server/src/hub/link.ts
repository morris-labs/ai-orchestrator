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
}
export interface NodeLink {
  readonly machineId: string;
  request(req: LinkRequest): Promise<LinkResponse>;
  openStream(req: Omit<LinkRequest, "body" | "method">): Promise<LinkStream>;
  onClose(cb: () => void): void;
}
/** On the hub: links to connected nodes. On a plain node: one entry, the hub, under id "hub". */
export interface LinkRegistry {
  get(machineId: string): NodeLink | undefined;
  list(): string[];
}
