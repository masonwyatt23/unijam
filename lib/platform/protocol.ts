export const ROOM_PROTOCOL_VERSION = 1 as const;
export const ROOM_EVENT_RETENTION = 2_000;

export type RoomActor = {
  participantId: string;
  role: "host" | "cohost" | "guest" | "viewer";
  nickname: string;
};

export type RoomCommandEnvelope = {
  commandId: string;
  expectedSeq?: number;
  action: string;
  payload: Record<string, unknown>;
};

export type RoomEvent = {
  eventId: string;
  seq: number;
  commandId: string;
  type: string;
  actor: RoomActor;
  payload: Record<string, unknown>;
  createdAtMs: number;
};

export type RoomCommandAck = {
  type: "ack";
  commandId: string;
  seq: number;
  duplicate: boolean;
  events: RoomEvent[];
};

export type RoomProtocolError = {
  type: "error";
  commandId?: string;
  code: string;
  message: string;
  retryable: boolean;
  latestSeq: number;
};

export type RoomHello = {
  type: "hello";
  protocol: typeof ROOM_PROTOCOL_VERSION;
  lastSeq: number;
  clientInstanceId: string;
};

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,191}$/;

export function assertBoundedJson(value: unknown, maxDepth = 20, maxNodes = 4_096): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) throw new Error("JSON structure is too complex");
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseRoomCommand(value: unknown): RoomCommandEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Command body must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const commandId = typeof candidate.commandId === "string" ? candidate.commandId.trim() : "";
  const action = typeof candidate.action === "string" ? candidate.action.trim() : "";
  if (!identifierPattern.test(commandId)) throw new Error("commandId is malformed");
  if (!/^[a-z][a-z0-9_.:-]{2,63}$/.test(action)) throw new Error("action is malformed");
  if (!candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) {
    throw new Error("payload must be an object");
  }
  assertBoundedJson(candidate.payload);
  const expectedSeq = candidate.expectedSeq;
  if (expectedSeq !== undefined && (!Number.isSafeInteger(expectedSeq) || Number(expectedSeq) < 0)) {
    throw new Error("expectedSeq must be a non-negative safe integer");
  }
  if (stableJson(candidate.payload).length > 16_384) throw new Error("payload is too large");
  return {
    commandId,
    action,
    payload: candidate.payload as Record<string, unknown>,
    ...(expectedSeq === undefined ? {} : { expectedSeq: Number(expectedSeq) }),
  };
}

export function commandIntent(command: RoomCommandEnvelope, actor: RoomActor): string {
  return stableJson({
    action: command.action,
    actorId: actor.participantId,
    payload: command.payload,
  });
}

export function parseRoomHello(value: unknown): RoomHello {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hello must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "hello" || candidate.protocol !== ROOM_PROTOCOL_VERSION) {
    throw new Error("Unsupported room protocol");
  }
  if (!Number.isSafeInteger(candidate.lastSeq) || Number(candidate.lastSeq) < 0) throw new Error("lastSeq is invalid");
  const clientInstanceId = typeof candidate.clientInstanceId === "string" ? candidate.clientInstanceId.trim() : "";
  if (!identifierPattern.test(clientInstanceId)) throw new Error("clientInstanceId is malformed");
  return {
    type: "hello",
    protocol: ROOM_PROTOCOL_VERSION,
    lastSeq: Number(candidate.lastSeq),
    clientInstanceId,
  };
}

export function newStableId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function shouldResetRoomState(cursor: string | null, after: number, minRetainedSeq: number): boolean {
  return cursor === null || after === 0 || after < minRetainedSeq;
}

export function roomActionRateLimit(action: string): number {
  if (action === "reaction.add") return 20;
  if (action === "suggestion.stage") return 3;
  if (action === "queue.vote") return 30;
  return 60;
}
