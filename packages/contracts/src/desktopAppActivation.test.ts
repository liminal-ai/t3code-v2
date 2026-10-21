import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
} from "./desktopAppActivation.ts";

const isRequest = Schema.is(DesktopAppActivationRequest);
const isResponse = Schema.is(DesktopAppActivationResponse);

const environment = {
  environmentId: "environment-dgx",
  label: "dgx-01",
  kind: "remote",
  httpBaseUrl: "https://dgx-01.example.ts.net/",
  enabled: true,
  connection: "connected",
};

describe("desktop app activation requests", () => {
  it("accepts each request kind", () => {
    expect(
      isRequest({
        version: 1,
        requestId: "request-1",
        type: "open-workspace",
        workspaceRoot: "/workspace/project",
        platform: "darwin",
      }),
    ).toBe(true);
    expect(
      isRequest({
        version: 1,
        requestId: "request-2",
        type: "pair-environment",
        pairingUrl: "https://dgx-01.example.ts.net/pair#token=abc",
        label: "dgx-01",
        force: false,
      }),
    ).toBe(true);
    expect(isRequest({ version: 1, requestId: "request-3", type: "list-environments" })).toBe(true);
  });

  it("rejects a pairing request without a link or a force choice, or with an empty label", () => {
    const pair = {
      version: 1,
      requestId: "request-2",
      type: "pair-environment",
      pairingUrl: "https://dgx-01.example.ts.net/pair#token=abc",
      force: false,
    };
    expect(isRequest({ ...pair, pairingUrl: "  " })).toBe(false);
    expect(isRequest({ ...pair, force: undefined })).toBe(false);
    expect(isRequest({ ...pair, label: "" })).toBe(false);
  });
});

describe("desktop app activation responses", () => {
  it("accepts pairing and listing results", () => {
    for (const outcome of ["paired", "route-added", "already-paired"]) {
      expect(
        isResponse({
          version: 1,
          requestId: "request-2",
          ok: true,
          type: "pair-environment",
          outcome,
          environment,
        }),
      ).toBe(true);
    }
    expect(
      isResponse({
        version: 1,
        requestId: "request-3",
        ok: true,
        type: "list-environments",
        environments: [environment, { ...environment, kind: "ssh", httpBaseUrl: null }],
      }),
    ).toBe(true);
  });

  it("rejects an environment of an unknown kind or connection phase", () => {
    const list = (entry: object) => ({
      version: 1,
      requestId: "request-3",
      ok: true,
      type: "list-environments",
      environments: [entry],
    });
    expect(isResponse(list({ ...environment, kind: "cloud" }))).toBe(false);
    expect(isResponse(list({ ...environment, connection: "sleeping" }))).toBe(false);
  });

  it("accepts the pairing error codes", () => {
    for (const code of ["pairing-rejected", "environment-unreachable", "pairing-failed"]) {
      expect(
        isResponse({ version: 1, requestId: "request-2", ok: false, code, message: "No." }),
      ).toBe(true);
    }
  });
});
