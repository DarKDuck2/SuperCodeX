import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSseStream } from "../src/lib/stream.js";

describe("SSE stream reader", () => {
  it("emits JSON events and ignores done markers", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"step","message":"hello"}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const response = new Response(body);
    const events: Array<{ type: string; message: string }> = [];

    await readSseStream(response, (event: { type: string; message: string }) => {
      events.push(event);
    });

    assert.deepEqual(events, [{ type: "step", message: "hello" }]);
  });
});
