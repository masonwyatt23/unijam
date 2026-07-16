import assert from "node:assert/strict";
import test from "node:test";

import { BoundedBodyError, readBoundedBody, readBoundedJson, requestWithBoundedBody } from "./bounded-body.ts";

function streamingRequest(chunks: readonly string[], headers: HeadersInit = {}): Request {
  const encoder = new TextEncoder();
  return new Request("https://unijam.test/api", {
    method: "POST",
    headers,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

test("bounded reader accepts missing Content-Length and measures actual bytes", async () => {
  const request = streamingRequest(["123", "45"]);
  assert.equal(request.headers.has("Content-Length"), false);
  assert.equal(new TextDecoder().decode(await readBoundedBody(request, 5)), "12345");
});

test("bounded reader stops an oversized stream without Content-Length", async () => {
  await assert.rejects(
    () => readBoundedBody(streamingRequest(["1234", "56"]), 5),
    (error: unknown) => error instanceof BoundedBodyError && error.code === "BODY_TOO_LARGE" && error.status === 413,
  );
});

test("bounded reader rejects malformed and mismatched declared lengths", async () => {
  await assert.rejects(
    () => readBoundedBody(streamingRequest(["{}"], { "Content-Length": "not-a-number" }), 10),
    (error: unknown) => error instanceof BoundedBodyError && error.code === "BODY_LENGTH_INVALID",
  );
  await assert.rejects(
    () => readBoundedBody(streamingRequest(["{}"], { "Content-Length": "1" }), 10),
    (error: unknown) => error instanceof BoundedBodyError && error.code === "BODY_LENGTH_MISMATCH",
  );
});

test("bounded JSON parsing and request reconstruction preserve only capped content", async () => {
  const parsed = await readBoundedJson(streamingRequest(["{\"safe\":" , "true}"], { "Content-Type": "application/json" }), 32);
  assert.deepEqual(parsed, { safe: true });
  const rebuilt = await requestWithBoundedBody(streamingRequest(["payload"]), 7);
  assert.equal(rebuilt.headers.has("Content-Length"), false);
  assert.equal(await rebuilt.text(), "payload");
});
