// SPDX-License-Identifier: Apache-2.0
/** Unit tests for SSE parser with chunk boundaries, CRLF/LF, comments. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { once } from "node:events";
import {
  SSEClient,
  SSEParser,
  type ParsedSSEEvent,
} from "../src/sse.js";

function collectEvents(parser: SSEParser, chunks: string[]): ParsedSSEEvent[] {
  const all: ParsedSSEEvent[] = [];
  for (const chunk of chunks) {
    all.push(...parser.feed(chunk));
  }
  return all;
}

describe("SSEParser", () => {
  it("parses a basic event with CRLF", () => {
    const parser = new SSEParser();
    const events = parser.feed("event: ping\ndata: {}\r\n\r\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "ping");
    assert.equal(events[0].data, "{}");
  });

  it("parses a basic event with LF only", () => {
    const parser = new SSEParser();
    const events = parser.feed("event: ping\ndata: {}\n\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "ping");
    assert.equal(events[0].data, "{}");
  });

  it("parses a wake event", () => {
    const parser = new SSEParser();
    const events = parser.feed(
      'event: wake\ndata: {"reason":"jobs_available"}\n\n',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "wake");
    assert.equal(events[0].data, '{"reason":"jobs_available"}');
  });

  it("handles multiline data:", () => {
    const parser = new SSEParser();
    const events = parser.feed(
      "event: notice\ndata: {\"id\":\"abc\"}\ndata: {\"more\":true}\n\n",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "notice");
    assert.equal(events[0].data, '{"id":"abc"}\n{"more":true}');
  });

  it("reports comments (lines starting with :)", () => {
    const parser = new SSEParser();
    const events = parser.feed(
      ": this is a comment\nevent: ping\ndata: {}\n\n",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "ping");
  });

  it("handles split chunks across boundaries", () => {
    const parser = new SSEParser();

    // First chunk: partial event
    const events1 = parser.feed("event: notice\nda");
    assert.equal(events1.length, 0);

    // Second chunk: rest of data + blank line
    const events2 = parser.feed('ta: {"key":"val"}\n\n');
    assert.equal(events2.length, 1);
    assert.equal(events2[0].event, "notice");
    assert.equal(events2[0].data, '{"key":"val"}');
  });

  it("handles split across data: boundary", () => {
    const parser = new SSEParser();

    const e1 = parser.feed("event: test\ndata: par");
    assert.equal(e1.length, 0);

    const e2 = parser.feed("tial\n\n");
    assert.equal(e2.length, 1);
    assert.equal(e2[0].event, "test");
    assert.equal(e2[0].data, "partial");
  });

  it("handles multiple events in one chunk", () => {
    const parser = new SSEParser();
    const events = parser.feed(
      "event: ping\ndata: {}\n\nevent: notice\ndata: {\"id\":1}\n\n",
    );
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "ping");
    assert.equal(events[1].event, "notice");
  });

  it("flushes remaining data", () => {
    const parser = new SSEParser();
    parser.feed("event: flush-test\ndata: done\n\n");
    const flushed = parser.flush();
    assert.equal(flushed.length, 0); // already consumed

    // Flush with data
    const parser2 = new SSEParser();
    parser2.feed("event: final\ndata: end");
    const events = parser2.flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "final");
    assert.equal(events[0].data, "end");
  });

  it("returns empty for empty input", () => {
    const parser = new SSEParser();
    const events = parser.feed("");
    assert.equal(events.length, 0);
  });

  it("handles ping comment only (Master comment pings)", () => {
    const parser = new SSEParser();
    // Master sends comment-only pings: just a colon line
    const events = parser.feed(": ping\n\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "comment");
    assert.equal(events[0].data, "ping");
  });

  it("handles events with no event: field (defaults to message)", () => {
    const parser = new SSEParser();
    const events = parser.feed('data: {"hello":"world"}\n\n');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "message");
    assert.equal(events[0].data, '{"hello":"world"}');
  });
});

describe("SSEClient", () => {
  it("does not apply the header timeout to the response body", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      setTimeout(() => res.write(": ping\n\n"), 60);
      setTimeout(() => res.end(), 90);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      let heartbeats = 0;
      const abort = new AbortController();
      const client = new SSEClient({
        masterUrl: `http://127.0.0.1:${address.port}`,
        workerId: "wrk_test",
        getSessionToken: () => "cown_sess_test",
        onSessionExpired: () => {},
        onEvent: () => {},
        onHeartbeat: () => {
          heartbeats++;
        },
        signal: abort.signal,
        connectTimeoutMs: 500,
      });

      await client.connect();
      assert.equal(heartbeats, 1);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("expires the session on an HTTP 401 response", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response("unauthorized", { status: 401 });
    let expired = false;
    try {
      const client = new SSEClient({
        masterUrl: "http://mock-master",
        workerId: "wrk_test",
        getSessionToken: () => "cown_sess_test",
        onSessionExpired: () => {
          expired = true;
        },
        onEvent: () => {},
        signal: new AbortController().signal,
      });
      await assert.rejects(() => client.connect(), /SSE auth rejected/);
      assert.equal(expired, true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
