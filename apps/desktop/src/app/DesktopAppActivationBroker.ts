// @effect-diagnostics globalTimers:off -- This protocol broker owns cancellable request deadlines outside the Effect runtime.
import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  type DesktopAppActivationDeadlines,
  type DesktopAppActivationFailure,
  type DesktopAppActivationRequest,
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

type RendererSender = (request: DesktopAppActivationRequest) => void;

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

function waitTimeoutMessage(request: DesktopAppActivationRequest): string {
  const message = `T3 Code did not start ${requestActivity(request)} in time, because its window was not ready or other requests were ahead.`;
  return request.type === "pair-environment"
    ? `${message} The link was not used, so you can run the command again.`
    : message;
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
  /** The request the renderer is working on. It stays set after a deadline answers the command, until the renderer finishes. */
  #running: string | null = null;
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
    if (this.#pending.has(request.requestId) || this.#running === request.requestId) {
      return Promise.resolve(
        failure(request.requestId, "invalid-request", "The request id is already in use."),
      );
    }

    const { waitMs, runMs } = this.#deadlines(request);
    const response = new Promise<DesktopAppActivationResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.#settle(failure(request.requestId, "request-timeout", waitTimeoutMessage(request)));
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

  registerRenderer(send: RendererSender): void {
    this.#renderer = send;
    this.#flush();
  }

  clearRenderer(): void {
    this.#renderer = null;
    // Whatever the old renderer was working on went with it.
    this.#running = null;
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
    const wasRunning = this.#running === response.requestId;
    if (wasRunning) this.#running = null;
    if (this.#pending.has(response.requestId)) {
      this.#settle(response);
      return;
    }
    if (wasRunning) {
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
    for (const pending of this.#pending.values()) {
      this.#settle(
        failure(pending.request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
  }

  // One request at a time, because the renderer runs them in order. A request's run deadline
  // starts here, so time spent behind another request does not count against it.
  #flush(): void {
    const renderer = this.#renderer;
    if (renderer === null || this.#running !== null) return;

    for (const pending of this.#pending.values()) {
      try {
        renderer(pending.request);
      } catch {
        this.#renderer = null;
        return;
      }
      pending.dispatched = true;
      this.#running = pending.request.requestId;
      clearTimeout(pending.timeout);
      pending.timeout = setTimeout(() => {
        this.#settle(
          failure(pending.request.requestId, "request-timeout", runTimeoutMessage(pending.request)),
        );
      }, pending.runMs);
      return;
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
