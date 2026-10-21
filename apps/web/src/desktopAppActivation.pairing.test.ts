import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  desktopAppEnvironmentRecord,
  handleDesktopAppListEnvironmentsRequest,
  handleDesktopAppPairRequest,
  type DesktopAppEnvironmentDependencies,
  type DesktopAppEnvironmentRecord,
} from "./desktopAppActivation";

const dgxId = EnvironmentId.make("environment-dgx");
const PAIRING_URL = "https://dgx-01.example.ts.net/pair#token=pairing-token";

function bearerEntry(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrls: readonly [string, ...string[]];
}): ConnectionCatalogEntry {
  const [first, ...rest] = input.httpBaseUrls.map((httpBaseUrl) => {
    const connectionId = `bearer:${input.environmentId}:${new URL(httpBaseUrl).origin}`;
    return {
      target: new BearerConnectionTarget({
        environmentId: input.environmentId,
        label: input.label,
        connectionId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId: input.environmentId,
          label: input.label,
          httpBaseUrl,
          wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
        }),
      ),
    };
  });
  return {
    ...first!,
    ...(rest.length === 0 ? {} : { alternateRoutes: rest }),
    enabled: true,
  };
}

const dgxRecord = desktopAppEnvironmentRecord(
  bearerEntry({
    environmentId: dgxId,
    label: "dgx-01",
    httpBaseUrls: ["https://dgx-01.example.ts.net/"],
  }),
  "connected",
);

function pairRequest(overrides: { readonly label?: string; readonly force?: boolean } = {}) {
  return {
    version: 1,
    requestId: "request-pair",
    type: "pair-environment",
    pairingUrl: PAIRING_URL,
    force: false,
    ...overrides,
  } as const;
}

/** Each read returns the next snapshot, and the last one after that. */
function dependencies(
  snapshots: ReadonlyArray<ReadonlyArray<DesktopAppEnvironmentRecord>>,
  pairEnvironment: DesktopAppEnvironmentDependencies["pairEnvironment"] = vi.fn(async () => dgxId),
) {
  let reads = 0;
  return {
    readEnvironments: vi.fn(async () => snapshots[Math.min(reads++, snapshots.length - 1)] ?? []),
    pairEnvironment: vi.fn(pairEnvironment),
  };
}

describe("desktop app pairing", () => {
  it("pairs a new server with the pasted-link pairing and replies with the saved environment", async () => {
    const deps = dependencies([[], [dgxRecord]]);

    const response = await handleDesktopAppPairRequest(pairRequest({ label: "dgx-01" }), deps);

    expect(deps.pairEnvironment).toHaveBeenCalledWith({ pairingUrl: PAIRING_URL, label: "dgx-01" });
    expect(response).toEqual({
      version: 1,
      requestId: "request-pair",
      ok: true,
      type: "pair-environment",
      outcome: "paired",
      environment: {
        environmentId: dgxId,
        label: "dgx-01",
        kind: "remote",
        httpBaseUrl: "https://dgx-01.example.ts.net/",
        enabled: true,
        connection: "connected",
      },
    });
  });

  it("skips a server the app already has at that address, keeping the token unspent", async () => {
    const alternate = desktopAppEnvironmentRecord(
      bearerEntry({
        environmentId: dgxId,
        label: "dgx-01",
        httpBaseUrls: ["https://10.0.0.5:3773/", "https://dgx-01.example.ts.net/"],
      }),
      "connected",
    );
    const deps = dependencies([[alternate]]);

    const response = await handleDesktopAppPairRequest(pairRequest(), deps);

    expect(deps.pairEnvironment).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: true,
      outcome: "already-paired",
      environment: { environmentId: dgxId, httpBaseUrl: "https://10.0.0.5:3773/" },
    });
  });

  it("pairs again with --force", async () => {
    const deps = dependencies([[dgxRecord]]);

    const response = await handleDesktopAppPairRequest(pairRequest({ force: true }), deps);

    expect(deps.pairEnvironment).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ ok: true, outcome: "paired" });
  });

  it("reports a new address for a saved server as another route", async () => {
    const lan = desktopAppEnvironmentRecord(
      bearerEntry({ environmentId: dgxId, label: "dgx-01", httpBaseUrls: ["https://10.0.0.5/"] }),
      "connected",
    );
    const both = desktopAppEnvironmentRecord(
      bearerEntry({
        environmentId: dgxId,
        label: "dgx-01",
        httpBaseUrls: ["https://10.0.0.5/", "https://dgx-01.example.ts.net/"],
      }),
      "connected",
    );
    const deps = dependencies([[lan], [both]]);

    const response = await handleDesktopAppPairRequest(pairRequest(), deps);

    expect(response).toMatchObject({ ok: true, outcome: "route-added" });
  });

  it.each([
    {
      name: "an expired or used token",
      error: new ConnectionBlockedError({
        reason: "authentication",
        detail: "The environment credential is invalid.",
      }),
      code: "pairing-rejected",
      message:
        "https://dgx-01.example.ts.net/ rejected the pairing token. It may have expired or been used already, so create a new link and try again.",
    },
    {
      name: "an unreachable host",
      error: new ConnectionTransientError({ reason: "network", detail: "fetch failed" }),
      code: "environment-unreachable",
      message: "T3 Code could not reach https://dgx-01.example.ts.net/: fetch failed",
    },
    {
      name: "an incompatible server",
      error: new ConnectionBlockedError({
        reason: "unsupported",
        detail: "The environment runs an unsupported protocol.",
      }),
      code: "pairing-failed",
      message: "The environment runs an unsupported protocol.",
    },
  ])("maps $name to $code", async ({ error, code, message }) => {
    const deps = dependencies([[]], async () => {
      throw error;
    });

    const response = await handleDesktopAppPairRequest(pairRequest(), deps);

    expect(response).toEqual({
      version: 1,
      requestId: "request-pair",
      ok: false,
      code,
      message,
    });
  });

  it.each([
    ["a pairing error", new Error(`Could not pair ${PAIRING_URL}`)],
    [
      "an unreachable host",
      new ConnectionTransientError({
        reason: "network",
        detail: `fetch ${encodeURIComponent(PAIRING_URL)} failed`,
      }),
    ],
    ["a bare token", new Error("Credential pairing-token was refused.")],
  ])("never quotes the token from %s", async (_, error) => {
    const deps = dependencies([[]], async () => {
      throw error;
    });

    const response = await handleDesktopAppPairRequest(pairRequest(), deps);

    expect(response).toMatchObject({ ok: false, message: expect.stringContaining("<redacted>") });
    expect(JSON.stringify(response)).not.toContain("pairing-token");
  });

  it("answers a failure to read the saved environments without quoting the token", async () => {
    const deps = {
      readEnvironments: vi.fn(async () => {
        throw new Error(`Catalog read failed while pairing ${PAIRING_URL}`);
      }),
      pairEnvironment: vi.fn(async () => dgxId),
    };

    const response = await handleDesktopAppPairRequest(pairRequest(), deps);

    expect(response).toEqual({
      version: 1,
      requestId: "request-pair",
      ok: false,
      code: "internal-error",
      message:
        "Catalog read failed while pairing https://dgx-01.example.ts.net/pair#token=<redacted>",
    });
    expect(deps.pairEnvironment).not.toHaveBeenCalled();
  });

  it("rejects a link without a token without pairing", async () => {
    const deps = dependencies([[]]);

    const response = await handleDesktopAppPairRequest(
      { ...pairRequest(), pairingUrl: "https://dgx-01.example.ts.net/pair" },
      deps,
    );

    expect(deps.pairEnvironment).not.toHaveBeenCalled();
    expect(response).toMatchObject({ ok: false, code: "invalid-request" });
  });
});

describe("desktop app environments", () => {
  it("lists every saved environment", async () => {
    const local = desktopAppEnvironmentRecord(
      {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("environment-local"),
          label: "This Mac",
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
        }),
        profile: Option.none(),
        enabled: true,
      },
      "connected",
    );
    const sshConnectionId = "ssh:environment-ssh:builder";
    const ssh = desktopAppEnvironmentRecord(
      {
        target: new SshConnectionTarget({
          environmentId: EnvironmentId.make("environment-ssh"),
          label: "builder",
          connectionId: sshConnectionId,
        }),
        profile: Option.some(
          new SshConnectionProfile({
            connectionId: sshConnectionId,
            environmentId: EnvironmentId.make("environment-ssh"),
            label: "builder",
            target: { alias: "builder", hostname: "builder", username: "lee", port: null },
          }),
        ),
        enabled: false,
      },
      "offline",
    );

    const response = await handleDesktopAppListEnvironmentsRequest(
      { version: 1, requestId: "request-list", type: "list-environments" },
      { readEnvironments: async () => [local, dgxRecord, ssh] },
    );

    expect(response).toEqual({
      version: 1,
      requestId: "request-list",
      ok: true,
      type: "list-environments",
      environments: [
        {
          environmentId: "environment-local",
          label: "This Mac",
          kind: "local",
          httpBaseUrl: "http://127.0.0.1:3773/",
          enabled: true,
          connection: "connected",
        },
        dgxRecord.environment,
        {
          environmentId: "environment-ssh",
          label: "builder",
          kind: "ssh",
          httpBaseUrl: null,
          enabled: false,
          connection: "offline",
        },
      ],
    });
  });
});
