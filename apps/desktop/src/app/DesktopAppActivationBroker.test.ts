import {
  desktopAppActivationDeadlines,
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

  it("sends pairing and listing past an open-workspace the window cannot take yet", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ deadlines: oneSecond, activate: vi.fn() });
    // The local environment is off, so the window takes only pairing and listing.
    broker.registerRenderer(send, ["pair-environment", "list-environments"]);
    const opened = broker.request(request);
    const pairing = broker.request(pairRequest("pair-1"));
    const listing = broker.request(listRequest("list-1"));

    // Listing only reads, so it runs beside the pairing.
    expect(send.mock.calls).toEqual([[pairRequest("pair-1")], [listRequest("list-1")]]);
    broker.complete(listed("list-1"));
    await expect(listing).resolves.toMatchObject({ ok: true, requestId: "list-1" });
    broker.complete(paired("pair-1"));
    await expect(pairing).resolves.toMatchObject({ ok: true, requestId: "pair-1" });
    expect(send).not.toHaveBeenCalledWith(request);

    broker.registerRenderer(send, ["open-workspace", "pair-environment", "list-environments"]);
    expect(send).toHaveBeenLastCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });
    await expect(opened).resolves.toMatchObject({ ok: true, projectId: "project-1" });
    broker.close();
  });

  it("keeps listing while a pairing the window never finishes holds later pairings, and says how to recover", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const broker = new DesktopAppActivationBroker({
        deadlines: (request) => desktopAppActivationDeadlines(request.type),
        activate: vi.fn(),
      });
      broker.registerRenderer(send);
      const stalled = broker.request(pairRequest("pair-stalled"));
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(stalled).resolves.toMatchObject({ ok: false, code: "request-timeout" });

      // `t3 app environments`, as the timeout tells the user to run, still answers.
      const listing = broker.request(listRequest("list-1"));
      expect(send).toHaveBeenLastCalledWith(listRequest("list-1"));
      broker.complete(listed("list-1"));
      await expect(listing).resolves.toMatchObject({ ok: true, requestId: "list-1" });

      // A new pairing is never sent while the earlier one may still save, and says why.
      const next = broker.request(pairRequest("pair-next"));
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(next).resolves.toEqual({
        version: 1,
        requestId: "pair-next",
        ok: false,
        code: "request-timeout",
        message:
          "T3 Code did not start pairing the environment, because it is still pairing the environment for an earlier command that already timed out or was stopped. The link was not used. Run `t3 app environments` to see whether the earlier pairing saved its environment. To stop the earlier request, reload the T3 Code window (View > Reload) or quit and reopen T3 Code, then run the command again.",
      });
      expect(send).not.toHaveBeenCalledWith(pairRequest("pair-next"));

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      const laterListing = broker.request(listRequest("list-2"));
      expect(send).toHaveBeenLastCalledWith(listRequest("list-2"));
      broker.complete(listed("list-2"));
      await expect(laterListing).resolves.toMatchObject({ ok: true, requestId: "list-2" });

      // Reloading the window ends the stalled pairing, and the next one runs.
      broker.clearRenderer();
      broker.registerRenderer(send);
      const afterReload = broker.request(pairRequest("pair-after-reload"));
      expect(send).toHaveBeenLastCalledWith(pairRequest("pair-after-reload"));
      broker.complete(paired("pair-after-reload"));
      await expect(afterReload).resolves.toMatchObject({ ok: true });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says how to recover from a pairing the window never finishes after its command was stopped", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const broker = new DesktopAppActivationBroker({
        deadlines: (request) => desktopAppActivationDeadlines(request.type),
        activate: vi.fn(),
      });
      broker.registerRenderer(send);
      const stopped = broker.request(pairRequest("pair-stopped"));
      expect(send).toHaveBeenLastCalledWith(pairRequest("pair-stopped"));

      // Ctrl+C before the pairing's run deadline.
      await vi.advanceTimersByTimeAsync(5_000);
      broker.cancel("pair-stopped");
      await expect(stopped).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });

      const listing = broker.request(listRequest("list-1"));
      expect(send).toHaveBeenLastCalledWith(listRequest("list-1"));
      broker.complete(listed("list-1"));
      await expect(listing).resolves.toMatchObject({ ok: true, requestId: "list-1" });

      const recovery =
        "T3 Code did not start pairing the environment, because it is still pairing the environment for an earlier command that already timed out or was stopped. The link was not used. Run `t3 app environments` to see whether the earlier pairing saved its environment. To stop the earlier request, reload the T3 Code window (View > Reload) or quit and reopen T3 Code, then run the command again.";
      const next = broker.request(pairRequest("pair-next"));
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(next).resolves.toMatchObject({
        ok: false,
        code: "request-timeout",
        message: recovery,
      });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      const later = broker.request(pairRequest("pair-later"));
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(later).resolves.toMatchObject({
        ok: false,
        code: "request-timeout",
        message: recovery,
      });
      expect(send).not.toHaveBeenCalledWith(pairRequest("pair-next"));
      expect(send).not.toHaveBeenCalledWith(pairRequest("pair-later"));

      // Reloading the window ends the stalled pairing, and the next one runs.
      broker.clearRenderer();
      broker.registerRenderer(send);
      const afterReload = broker.request(pairRequest("pair-after-reload"));
      expect(send).toHaveBeenLastCalledWith(pairRequest("pair-after-reload"));
      broker.complete(paired("pair-after-reload"));
      await expect(afterReload).resolves.toMatchObject({ ok: true });
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

function listRequest(requestId: string): DesktopAppActivationRequest {
  return { version: 1, requestId, type: "list-environments" };
}

function listed(requestId: string): DesktopAppActivationResponse {
  return { version: 1, requestId, ok: true, type: "list-environments", environments: [] };
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
