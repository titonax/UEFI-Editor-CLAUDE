import { afterEach, describe, expect, it, vi } from "vitest";
import { FULL_IMAGE_CHECK_TIMEOUT_MS, startFullImageCheck } from "./fullImageCheckClient";
import type { FullImageRequest, FullImageResult } from "./fullImageExport";

const request = {} as FullImageRequest;
const okResult: FullImageResult = { ok: false, stage: "plan", messages: ["nothing to do"] };

class FakeWorker {
  static last: FakeWorker | undefined;
  static throwOnConstruct: Error | undefined;
  static throwOnPost: Error | undefined;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = 0;
  posted: unknown[] = [];
  constructor() {
    if (FakeWorker.throwOnConstruct) throw FakeWorker.throwOnConstruct;
    FakeWorker.last = this;
  }
  postMessage(message: unknown) {
    if (FakeWorker.throwOnPost) throw FakeWorker.throwOnPost;
    this.posted.push(message);
  }
  terminate() {
    this.terminated++;
  }
}

function install() {
  FakeWorker.last = undefined;
  FakeWorker.throwOnConstruct = undefined;
  FakeWorker.throwOnPost = undefined;
  vi.stubGlobal("Worker", FakeWorker);
}
const worker = () => {
  if (!FakeWorker.last) throw new Error("no worker was started");
  return FakeWorker.last;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("startFullImageCheck", () => {
  it("sends the request and resolves with what the worker answers, then ends the worker", async () => {
    install();
    const handle = startFullImageCheck(request);

    worker().onmessage?.({ data: okResult });

    await expect(handle.result).resolves.toEqual(okResult);
    expect(worker().posted).toEqual([request]);
    expect(worker().terminated).toBe(1);
  });

  it("rejects with the worker's own message when it crashed", async () => {
    install();
    const handle = startFullImageCheck(request);

    worker().onmessage?.({ data: { crashed: "out of memory" } });

    await expect(handle.result).rejects.toThrow("out of memory");
    expect(worker().terminated).toBe(1);
  });

  it("rejects an answer that is not an object instead of hanging", async () => {
    install();
    const handle = startFullImageCheck(request);

    worker().onmessage?.({ data: null });

    await expect(handle.result).rejects.toThrow(/could not be read/);
  });

  it("rejects when the worker errors or its answer cannot be read", async () => {
    install();
    const failing = startFullImageCheck(request);
    worker().onerror?.({ message: "script error" });
    await expect(failing.result).rejects.toThrow("script error");

    install();
    const unreadable = startFullImageCheck(request);
    worker().onmessageerror?.();
    await expect(unreadable.result).rejects.toThrow(/could not be read/);
    expect(worker().terminated).toBe(1);
  });

  it("rejects, and ends the worker, when the request cannot be sent", async () => {
    install();
    FakeWorker.throwOnPost = new Error("DataCloneError");

    const handle = startFullImageCheck(request);

    await expect(handle.result).rejects.toThrow(/could not be sent.*DataCloneError/);
    expect(worker().terminated).toBe(1);
  });

  it("returns a rejected result, never throws, when the worker cannot be started", async () => {
    install();
    FakeWorker.throwOnConstruct = new Error("blocked by CSP");

    const handle = startFullImageCheck(request);

    await expect(handle.result).rejects.toThrow(/could not be started.*blocked by CSP/);
    expect(() => {
      handle.cancel();
    }).not.toThrow();
  });

  it("cancels at once, and a late answer changes nothing", async () => {
    install();
    const handle = startFullImageCheck(request);

    handle.cancel();
    worker().onmessage?.({ data: okResult });

    await expect(handle.result).rejects.toThrow(/cancelled/);
    expect(worker().terminated).toBeGreaterThanOrEqual(1);
  });

  it("gives up after the timeout and ends the worker", async () => {
    install();
    vi.useFakeTimers();
    const handle = startFullImageCheck(request);
    const outcome = expect(handle.result).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(FULL_IMAGE_CHECK_TIMEOUT_MS + 1);

    await outcome;
    expect(worker().terminated).toBe(1);
  });
});
