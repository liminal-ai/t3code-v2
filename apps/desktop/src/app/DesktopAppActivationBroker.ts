// @effect-diagnostics globalTimers:off -- This protocol broker owns cancellable request deadlines outside the Effect runtime.
import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  type DesktopAppActivationDeadlines,
  type DesktopAppActivationFailure,
  type DesktopAppActivationRequest,
  DesktopAppActivationRequestType,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";

interface PendingActivation {
  readonly request: DesktopAppActivationRequest;
  readonly resolve: (response: DesktopAppActivationResponse) => void;
  readonly runMs: number;
  /** The wait deadline until the request is dispatched, then the run deadline. */
  timeout: ReturnType<typeof setTimeout>;
  dispatched: boolean;
}

interface RunningActivation {
  readonly request: DesktopAppActivationRequest;
  /** Its run deadline passed and its command has its answer, but the renderer has not finished. */
  overdue: boolean;
}

type RendererSender = (request: DesktopAppActivationRequest) => void;

/** Listing only reads, so it runs beside the other kinds and never waits behind them. */
function runsBesideOthers(request: DesktopAppActivationRequest): boolean {
  return request.type === "list-environments";
}

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code,
    message,
  };
}

function requestActivity(request: DesktopAppActivationRequest): string {
  switch (request.type) {
    case "open-workspace":
      return "opening the project";
    case "pair-environment":
      return "pairing the environment";
    case "list-environments":
      return "listing environments";
  }
}

function waitTimeoutMessage(
  request: DesktopAppActivationRequest,
  running: RunningActivation | null,
): string {
  if (running?.overdue) return stalledMessage(request, running.request);
  const message = `T3 Code did not start ${requestActivity(request)} in time, because its window was not ready or other requests were ahead.`;
  return request.type === "pair-environment"
    ? `${message} The link was not used, so you can run the command again.`
    : message;
}

// Only the renderer can end a request it is working on, and it can end it only by going away.
function stalledMessage(
  request: DesktopAppActivationRequest,
  stalled: DesktopAppActivationRequest,
): string {
  return [
    `T3 Code did not start ${requestActivity(request)}, because it is still ${requestActivity(stalled)} for an earlier command that already timed out.`,
    ...(request.type === "pair-environment" ? ["The link was not used."] : []),
    ...(stalled.type === "pair-environment"
      ? ["Run `t3 app environments` to see whether the earlier pairing saved its environment."]
      : []),
    "To stop the earlier request, reload the T3 Code window (View > Reload) or quit and reopen T3 Code, then run the command again.",
  ].join(" ");
}

function runTimeoutMessage(request: DesktopAppActivationRequest): string {
  return request.type === "pair-environment"
    ? "T3 Code did not finish pairing the environment in time. It is still working and may yet save the environment, so run `t3 app environments` before you create a new link."
    : `The desktop app did not finish ${requestActivity(request)} in time.`;
}

export class DesktopAppActivationBroker {
  readonly #pending = new Map<string, PendingActivation>();
  readonly #deadlines: (request: DesktopAppActivationRequest) => DesktopAppActivationDeadlines;
  readonly #activate: () => void;
  readonly #onLateCompletion: (response: DesktopAppActivationResponse) => void;
  #renderer: RendererSender | null = null;
  /** The kinds the renderer can handle now. A request of another kind waits, and others pass it. */
  #accepts: ReadonlySet<DesktopAppActivationRequestType> = new Set();
  /**
   * The request that can change the app, which the renderer is working on. It stays set after a
   * deadline answers the command, until the renderer finishes or goes away, so two never overlap.
   */
  #running: RunningActivation | null = null;
  /** Listings the renderer is working on. */
  readonly #reading = new Set<string>();
  #closed = false;

  constructor(input: {
    readonly deadlines: (request: DesktopAppActivationRequest) => DesktopAppActivationDeadlines;
    readonly activate: () => void;
    /** The renderer finished a request after its deadline or its command had already answered. */
    readonly onLateCompletion?: (response: DesktopAppActivationResponse) => void;
  }) {
    this.#deadlines = input.deadlines;
    this.#activate = input.activate;
    this.#onLateCompletion = input.onLateCompletion ?? (() => undefined);
  }

  request(request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> {
    if (this.#closed) {
      return Promise.resolve(
        failure(request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
    if (
      this.#pending.has(request.requestId) ||
      this.#running?.request.requestId === request.requestId ||
      this.#reading.has(request.requestId)
    ) {
      return Promise.resolve(
        failure(request.requestId, "invalid-request", "The request id is already in use."),
      );
    }

    const { waitMs, runMs } = this.#deadlines(request);
    const response = new Promise<DesktopAppActivationResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.#settle(
          failure(request.requestId, "request-timeout", waitTimeoutMessage(request, this.#running)),
        );
      }, waitMs);
      this.#pending.set(request.requestId, {
        request,
        resolve,
        runMs,
        timeout,
        dispatched: false,
      });
    });

    this.#activate();
    this.#flush();
    return response;
  }

  registerRenderer(
    send: RendererSender,
    accepts: ReadonlyArray<DesktopAppActivationRequestType> = DesktopAppActivationRequestType.literals,
  ): void {
    this.#renderer = send;
    this.#accepts = new Set(accepts);
    this.#flush();
  }

  clearRenderer(): void {
    this.#renderer = null;
    // Whatever the old renderer was working on went with it.
    this.#running = null;
    this.#reading.clear();
    for (const pending of this.#pending.values()) {
      if (pending.dispatched) {
        this.#settle(
          failure(
            pending.request.requestId,
            "renderer-unavailable",
            `The T3 Code window closed before it finished ${requestActivity(pending.request)}.`,
          ),
        );
      }
    }
  }

  complete(response: DesktopAppActivationResponse): void {
    const wasRunning = this.#running?.request.requestId === response.requestId;
    if (wasRunning) this.#running = null;
    const wasReading = this.#reading.delete(response.requestId);
    if (this.#pending.has(response.requestId)) {
      this.#settle(response);
      return;
    }
    if (wasRunning || wasReading) {
      this.#onLateCompletion(response);
      this.#flush();
    }
  }

  cancel(requestId: string): void {
    this.#settle(
      failure(requestId, "renderer-unavailable", "The command closed before T3 Code was ready."),
    );
  }

  close(): void {
    this.#closed = true;
    this.#renderer = null;
    this.#running = null;
    this.#reading.clear();
    for (const pending of this.#pending.values()) {
      this.#settle(
        failure(pending.request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
  }

  // One request that can change the app at a time, because the renderer runs them in order.
  // Listings go at once. A request's run deadline starts here, so time spent behind another
  // request does not count against it.
  #flush(): void {
    const renderer = this.#renderer;
    if (renderer === null) return;

    for (const pending of this.#pending.values()) {
      if (pending.dispatched || !this.#accepts.has(pending.request.type)) continue;
      const beside = runsBesideOthers(pending.request);
      if (!beside && this.#running !== null) continue;
      try {
        renderer(pending.request);
      } catch {
        this.#renderer = null;
        return;
      }
      pending.dispatched = true;
      const running = beside ? null : { request: pending.request, overdue: false };
      if (running === null) this.#reading.add(pending.request.requestId);
      else this.#running = running;
      clearTimeout(pending.timeout);
      pending.timeout = setTimeout(() => {
        if (running !== null) running.overdue = true;
        this.#settle(
          failure(pending.request.requestId, "request-timeout", runTimeoutMessage(pending.request)),
        );
      }, pending.runMs);
    }
  }

  #settle(response: DesktopAppActivationResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(response.requestId);
    pending.resolve(response);
    this.#flush();
  }
}
