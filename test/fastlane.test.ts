import test from "node:test";
import assert from "node:assert/strict";
import { parseHttpResponse } from "../src/fastlane.js";

const JSON_BODY = '{"jsonrpc":"2.0","id":1,"result":"0x1237"}';

/** Exactly what the sequencer returns. */
function contentLengthResponse(body: string): string {
  return `HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Exactly what the RPC returns. */
function chunkedResponse(body: string): string {
  return (
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n` +
    `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`
  );
}

test("parses a content-length response (sequencer framing)", () => {
  const r = parseHttpResponse(contentLengthResponse(JSON_BODY));
  assert.deepEqual(r, { payload: JSON_BODY });
});

test("parses a chunked response (RPC framing)", () => {
  const r = parseHttpResponse(chunkedResponse(JSON_BODY));
  assert.deepEqual(r, { payload: JSON_BODY });
});

test("parses a chunked response split across multiple chunks", () => {
  const a = '{"jsonrpc":"2.0",';
  const b = '"id":1,"result":"0x1237"}';
  const raw =
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n` +
    `${Buffer.byteLength(a).toString(16)}\r\n${a}\r\n` +
    `${Buffer.byteLength(b).toString(16)}\r\n${b}\r\n0\r\n\r\n`;
  assert.deepEqual(parseHttpResponse(raw), { payload: a + b });
});

test("returns null until the response is complete", () => {
  const full = contentLengthResponse(JSON_BODY);
  // headers not finished
  assert.equal(parseHttpResponse("HTTP/1.1 200 OK\r\ncontent-len"), null);
  // headers done, body short
  assert.equal(parseHttpResponse(full.slice(0, full.length - 5)), null);
  // complete
  assert.ok(parseHttpResponse(full));

  const chunked = chunkedResponse(JSON_BODY);
  assert.equal(parseHttpResponse(chunked.slice(0, chunked.length - 10)), null);
  assert.ok(parseHttpResponse(chunked));
});

test("byte-by-byte accumulation resolves exactly once, at the final byte", () => {
  for (const build of [contentLengthResponse, chunkedResponse]) {
    const full = build(JSON_BODY);
    let completed = 0;
    for (let i = 1; i <= full.length; i++) {
      if (parseHttpResponse(full.slice(0, i))) completed++;
    }
    assert.equal(completed, 1, "must complete only on the final byte");
  }
});

test("handles a real captured error response", () => {
  const body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"typed transaction too short"}}\n';
  assert.deepEqual(parseHttpResponse(chunkedResponse(body)), { payload: body });
  assert.deepEqual(parseHttpResponse(contentLengthResponse(body)), { payload: body });
  const parsed = JSON.parse(parseHttpResponse(chunkedResponse(body))!.payload) as {
    error: { message: string };
  };
  assert.equal(parsed.error.message, "typed transaction too short");
});

test("multibyte bodies are measured in bytes, not characters", () => {
  const body = '{"m":"ééé"}'; // 3 two-byte chars
  const r = parseHttpResponse(contentLengthResponse(body));
  assert.deepEqual(r, { payload: body });
});

test("a response with no length framing is treated as incomplete, never truncated", () => {
  assert.equal(parseHttpResponse("HTTP/1.1 200 OK\r\nserver: x\r\n\r\n{}"), null);
});
