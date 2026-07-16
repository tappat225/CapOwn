// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
/** Streaming SSE parser + reconnecting client for CapOwn Master events.

Handles:
- CRLF and LF line endings
- Comments (lines starting with ``:``)
- Multiline ``data:`` fields
- Partial (split) frames across chunk boundaries
*/

import { log } from "./logging.js";

// --------------------------------------------------------------------------
// SSE event types
// --------------------------------------------------------------------------

export interface ParsedSSEEvent {
  event: string;
  data: string;
}

// --------------------------------------------------------------------------
// SSE Parser
// --------------------------------------------------------------------------

export class SSEParser {
  private _buffer = "";

  /** Feed raw text from the stream and return any complete events. */
  feed(chunk: string): ParsedSSEEvent[] {
    this._buffer += chunk;
    return this._drain();
  }

  /** Flush any remaining data (call at stream end). */
  flush(): ParsedSSEEvent[] {
    const events = this._drain();
    // If there's leftover text, try to parse it as a final event
    if (this._buffer.trim().length > 0) {
      events.push(...this._parseBlock(this._buffer));
    }
    this._buffer = "";
    return events;
  }

  private _drain(): ParsedSSEEvent[] {
    const events: ParsedSSEEvent[] = [];

    // Split on double newline (CRLF or LF)
    let idx: number;
    while ((idx = this._findEventBoundary()) !== -1) {
      const block = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1); // skip one \n or \r
      // Skip any leading \n after \r
      if (this._buffer.startsWith("\n")) {
        this._buffer = this._buffer.slice(1);
      }

      if (block.trim().length > 0) {
        events.push(...this._parseBlock(block));
      }
    }

    return events;
  }

  /** Find the end of the next event block (double newline). */
  private _findEventBoundary(): number {
    // Look for \r\n\r\n
    const crlf = this._buffer.indexOf("\r\n\r\n");
    if (crlf !== -1) return crlf + 2; // returns position of the second \r\n's \r

    // Look for \n\n
    const lf = this._buffer.indexOf("\n\n");
    if (lf !== -1) return lf + 1; // returns position of the second \n

    return -1;
  }

  /** Parse a single event block (text between double newlines). */
  private _parseBlock(block: string): ParsedSSEEvent[] {
    const lines = block.split(/\r?\n/);
    let eventType = "";
    const dataParts: string[] = [];
    const commentParts: string[] = [];

    for (const line of lines) {
      if (line.startsWith(":")) {
        commentParts.push(line.slice(1).replace(/^ /, ""));
        continue;
      }
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataParts.push(line.slice(5).replace(/^ /, ""));
      }
      // Ignore other fields (id:, retry:)
    }

    if (!eventType && dataParts.length === 0) {
      if (commentParts.length > 0) {
        return [{ event: "comment", data: commentParts.join("\n") }];
      }
      return [];
    }

    const data = dataParts.join("\n");
    return [{ event: eventType || "message", data }];
  }
}

// --------------------------------------------------------------------------
// SSE Client
// --------------------------------------------------------------------------

export interface SSEClientOptions {
  masterUrl: string;
  workerId: string;
  /** Called to get the current session token (may change after re-auth). */
  getSessionToken: () => string;
  /** Called when the server rejects the session (401/403). */
  onSessionExpired: () => void;
  /** Called for each parsed SSE event. */
  onEvent: (event: string, data: string) => void;
  /** Called when a Master heartbeat comment or ping event is received. */
  onHeartbeat?: () => void;
  /** AbortSignal for shutdown. */
  signal: AbortSignal;
  /** Header timeout override for tests. */
  connectTimeoutMs?: number;
}

export class SSEClient {
  private _parser = new SSEParser();
  private _reading = false;

  constructor(private readonly _opts: SSEClientOptions) {}

  /** Connect to the SSE stream and read events until connection drops or
   *  the abort signal fires.
   *
   *  Throws on network errors or auth rejection (the daemon loop handles
   *  reconnection). Does NOT throw on normal stream closure.
   */
  async connect(): Promise<void> {
    const url = this._buildUrl();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: "Bearer " + this._opts.getSessionToken(),
      "Cache-Control": "no-cache",
    };

    const requestController = new AbortController();
    const onShutdown = (): void => {
      requestController.abort(this._opts.signal.reason);
    };
    if (this._opts.signal.aborted) {
      onShutdown();
    } else {
      this._opts.signal.addEventListener("abort", onShutdown, { once: true });
    }

    const timeoutMs = this._opts.connectTimeoutMs ?? 15_000;
    const connectTimer = setTimeout(() => {
      requestController.abort(new Error(`SSE header timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "GET",
          headers,
          signal: requestController.signal,
        });
      } finally {
        // The timeout protects response headers only. The shutdown signal remains
        // connected to requestController for the lifetime of the response body.
        clearTimeout(connectTimer);
      }

      if (resp.status === 401 || resp.status === 403) {
        this._opts.onSessionExpired();
        throw new Error(`SSE auth rejected (HTTP ${resp.status})`);
      }

      if (!resp.ok) {
        throw new Error(`SSE connection failed (HTTP ${resp.status})`);
      }

      if (!resp.body) {
        throw new Error("SSE response has no body stream");
      }

      log.info("sse: connected to master");
      this._reading = true;

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (this._reading && !this._opts.signal.aborted) {
          const { done, value } = await reader.read();

          if (done) {
            const finalText = decoder.decode();
            const events = [
              ...(finalText ? this._parser.feed(finalText) : []),
              ...this._parser.flush(),
            ];
            for (const evt of events) {
              this._dispatchEvent(evt);
            }
            break;
          }

          const text = decoder.decode(value, { stream: true });
          const events = this._parser.feed(text);
          for (const evt of events) {
            this._dispatchEvent(evt);
          }
        }
      } catch (err) {
        if (this._opts.signal.aborted) return;
        throw err;
      } finally {
        this._reading = false;
        try {
          await reader.cancel();
        } catch {
          // ignore cancel errors
        }
      }

      log.info("sse: stream closed");
    } finally {
      this._opts.signal.removeEventListener("abort", onShutdown);
    }
  }

  /** Close the connection. */
  close(): void {
    this._reading = false;
  }

  private _buildUrl(): string {
    const base = this._opts.masterUrl.replace(/\/+$/, "");
    return (
      base +
      "/v1/workers/" +
      encodeURIComponent(this._opts.workerId) +
      "/events"
    );
  }

  private _dispatchEvent(evt: ParsedSSEEvent): void {
    if (evt.event === "comment" || evt.event === "ping") {
      this._opts.onHeartbeat?.();
      return;
    }

    if (!evt.data) {
      return;
    }

    log.warn(
      "sse: unexpected event (type=%s, size=%d bytes) -- ignoring (no task execution in this milestone)",
      evt.event,
      evt.data.length,
    );

    this._opts.onEvent(evt.event, evt.data);
  }
}
