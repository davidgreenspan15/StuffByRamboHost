import { ApiError, readBoundedText, readJson } from "./http.ts";

Deno.test("body reader stops and cancels at byte limit without draining upload", async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (reads > 2) throw new Error("upload was drained beyond limit");
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const request = new Request("https://example.test", { method: "POST", body });
  try {
    await readBoundedText(request, 16);
    throw new Error("oversized body accepted");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 413) throw error;
  }
  if (reads !== 2 || !cancelled) {
    throw new Error("upload not cancelled promptly");
  }
});

Deno.test("body reader preserves split UTF-8 and exact raw signed bytes", async () => {
  const raw = '{"value":"a ☃ b"}';
  const bytes = new TextEncoder().encode(raw);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const request = new Request("https://example.test", { method: "POST", body });
  if (await readBoundedText(request, bytes.length) !== raw) {
    throw new Error("raw text changed");
  }
});

Deno.test("JSON reader enforces bytes rather than character count", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"v":"☃"}',
  });
  try {
    await readJson(request, 10);
    throw new Error("oversized UTF-8 body accepted");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 413) throw error;
  }
});
