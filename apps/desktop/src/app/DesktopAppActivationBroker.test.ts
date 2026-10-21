import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";

const oneSecond = () => ({ waitMs: 1_000, runMs: 1_000 });

const request: DesktopAppActivationRequest = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
};

describe("DesktopAppActivationBroker", () => {
  it("focuses immediately and waits for renderer readiness", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ deadlines: oneSecond, activate });

    const response = broker.request(request);
    expect(activate).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    broker.registerRenderer(send);
    expect(send).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true, projectId: "project-1" });
    broker.close();
  });

  it("fails an in-flight request when the renderer goes away", async () => {
    const broker = new DesktopAppActivationBroker({ deadlines: oneSecond, activate: vi.fn() });
    broker.registerRenderer(vi.fn());

    const response = broker.request(request);
    broker.clearRenderer();

    await expect(response).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
    broker.close();
  });

  it("queues requests after unsubscribe until a new renderer registers", async () => {
    const previousSend = vi.fn();
    const nextSend = vi.fn();
    const broker = new DesktopAppActivationBroker({ deadlines: oneSecond, activate: vi.fn() });
    broker.registerRenderer(previousSend);
    broker.clearRenderer();

    const response = broker.request(request);
    expect(previousSend).not.toHaveBeenCalled();
    expect(nextSend).not.toHaveBeenCalled();

    broker.registerRenderer(nextSend);
    expect(nextSend).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true });
    broker.close();
  });

  it("removes a queued request when its CLI connection closes", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ deadlines: oneSecond, activate: vi.fn() });

    const response = broker.request(request);
    broker.cancel(request.requestId);
    broker.registerRenderer(send);

    await expect(response).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(send).not.toHaveBeenCalled();
    broker.close();
  });

  it("never sends a canceled request that was queued behind another request", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ deadlines: oneSecond, activate: vi.fn() });
    broker.registerRenderer(send);
    const secondRequest = { ...request, requestId: "request-2" };

    const firstResponse = broker.request(request);
    const secondResponse = broker.request(secondRequest);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(request);

    broker.cancel(secondRequest.requestId);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(firstResponse).resolves.toMatchObject({ ok: true });
    await expect(secondResponse).resolves.toMatchObject({ ok: false });
    expect(send).toHaveBeenCalledTimes(1);
    broker.close();
  });

  it("times out a request without polling", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({ deadlines: oneSecond, activate: vi.fn() });
      const response = broker.request(request);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(response).resolves.toMatchObject({ ok: false, code: "request-timeout" });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a request's run deadline when it reaches the renderer, not while it waits", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const broker = new DesktopAppActivationBroker({
        deadlines: () => ({ waitMs: 60_000, runMs: 30_000 }),
        activate: vi.fn(),
      });
      broker.registerRenderer(send);
      const first = broker.request(pairRequest("pair-1"));
      const second = broker.request(pairRequest("pair-2"));
      expect(send).toHaveBeenCalledTimes(1);

      // Each pairing takes 19 seconds, so the second runs from 19 to 38.
      await vi.advanceTimersByTimeAsync(19_000);
      broker.complete(paired("pair-1"));
      await expect(first).resolves.toMatchObject({ ok: true, requestId: "pair-1" });
      expect(send).toHaveBeenLastCalledWith(pairRequest("pair-2"));

      await vi.advanceTimersByTimeAsync(19_000);
      broker.complete(paired("pair-2"));
      await expect(second).resolves.toMatchObject({ ok: true, requestId: "pair-2" });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a request that waits too long without sending it, and says the link is unused", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const broker = new DesktopAppActivationBroker({
        deadlines: () => ({ waitMs: 60_000, runMs: 30_000 }),
        activate: vi.fn(),
      });
      const pairing = broker.request(pairRequest("pair-1"));

      await vi.advanceTimersByTimeAsync(60_000);
      broker.registerRenderer(send);

      await expect(pairing).resolves.toEqual({
        version: 1,
        requestId: "pair-1",
        ok: false,
        code: "request-timeout",
        message:
          "T3 Code did not start pairing the environment in time, because its window was not ready or other requests were ahead. The link was not used, so you can run the command again.",
      });
      expect(send).not.toHaveBeenCalled();
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a pairing that outlives its deadline as still running, and holds the next request until it ends", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const onLateCompletion = vi.fn();
      const broker = new DesktopAppActivationBroker({
        deadlines: () => ({ waitMs: 60_000, runMs: 30_000 }),
        activate: vi.fn(),
        onLateCompletion,
      });
      broker.registerRenderer(send);
      const slow = broker.request(pairRequest("pair-slow"));
      const next = broker.request(pairRequest("pair-next"));

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(slow).resolves.toEqual({
        version: 1,
        requestId: "pair-slow",
        ok: false,
        code: "request-timeout",
        message:
          "T3 Code did not finish pairing the environment in time. It is still working and may yet save the environment, so run `t3 app environments` before you create a new link.",
      });
      // The renderer is still pairing, so the next request does not start its run yet.
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(8_000);
      broker.complete(paired("pair-slow"));
      expect(onLateCompletion).toHaveBeenCalledWith(paired("pair-slow"));
      expect(send).toHaveBeenLastCalledWith(pairRequest("pair-next"));

      broker.complete(paired("pair-next"));
      await expect(next).resolves.toMatchObject({ ok: true, requestId: "pair-next" });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the next request while the renderer finishes one whose command closed", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ deadlines: oneSecond, activate: vi.fn() });
    broker.registerRenderer(send);
    const first = broker.request(pairRequest("pair-1"));
    const second = broker.request(pairRequest("pair-2"));

    broker.cancel("pair-1");
    await expect(first).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(send).toHaveBeenCalledTimes(1);

    broker.complete(paired("pair-1"));
    expect(send).toHaveBeenLastCalledWith(pairRequest("pair-2"));
    broker.complete(paired("pair-2"));
    await expect(second).resolves.toMatchObject({ ok: true });
    broker.close();
  });
});

function pairRequest(requestId: string): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "pair-environment",
    pairingUrl: "https://builder.example.ts.net/pair#token=abc",
    force: false,
  };
}

function paired(requestId: string): DesktopAppActivationResponse {
  return {
    version: 1,
    requestId,
    ok: true,
    type: "pair-environment",
    outcome: "paired",
    environment: {
      environmentId: EnvironmentId.make("environment-builder"),
      label: "builder",
      kind: "remote",
      httpBaseUrl: "https://builder.example.ts.net/",
      enabled: true,
      connection: "connecting",
    },
  };
}
