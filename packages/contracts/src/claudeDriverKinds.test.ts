import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_DRIVER_KIND,
  CLAUDE_DRIVER_KINDS,
  CLAUDE_LHC_DRIVER_KIND,
  isClaudeDriverKind,
} from "./claudeDriverKinds.ts";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";
import { ClaudeLhcSettings, resolveProviderInstanceEnabled } from "./settings.ts";

const decodeLhc = Schema.decodeUnknownResult(ClaudeLhcSettings);
const accepts = (config: Record<string, unknown>) => decodeLhc(config)._tag === "Success";

describe("Claude driver kinds", () => {
  it("recognises both Claude kinds and nothing else", () => {
    expect(CLAUDE_DRIVER_KINDS).toEqual([CLAUDE_DRIVER_KIND, CLAUDE_LHC_DRIVER_KIND]);
    expect(isClaudeDriverKind("claudeAgent")).toBe(true);
    expect(isClaudeDriverKind("claude-lhc")).toBe(true);
    expect(isClaudeDriverKind("codex")).toBe(false);
    expect(isClaudeDriverKind(null)).toBe(false);
    expect(isClaudeDriverKind(undefined)).toBe(false);
  });

  it("gives the LHC kind Claude's models and its own display name", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[CLAUDE_LHC_DRIVER_KIND]).toBe(
      DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER_KIND],
    );
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[CLAUDE_LHC_DRIVER_KIND]).toBe(
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[CLAUDE_DRIVER_KIND],
    );
    expect(PROVIDER_DISPLAY_NAMES[CLAUDE_LHC_DRIVER_KIND]).toBe("Claude LHC");
  });
});

describe("ClaudeLhcSettings", () => {
  it("defaults to off, a 700k trigger, a 120k rebuilt view, and no idle compaction", () => {
    expect(Schema.decodeSync(ClaudeLhcSettings)({})).toMatchObject({
      enabled: false,
      autoCompactWindow: "700000",
      lhcLowerBound: "120000",
      idleCompaction: "off",
    });
    expect(resolveProviderInstanceEnabled({ driver: CLAUDE_LHC_DRIVER_KIND })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: CLAUDE_DRIVER_KIND })).toBe(true);
  });

  it("refuses an empty window, since the sidecar needs both", () => {
    expect(accepts({ autoCompactWindow: "", lhcLowerBound: "120000" })).toBe(false);
    expect(accepts({ autoCompactWindow: "380000", lhcLowerBound: "" })).toBe(false);
  });

  it("keeps the trigger in 100k-1M, the view in 10k-1M, and the view below the trigger", () => {
    expect(accepts({ autoCompactWindow: "240000", lhcLowerBound: "80000" })).toBe(true);
    expect(accepts({ autoCompactWindow: "99999", lhcLowerBound: "50000" })).toBe(false);
    expect(accepts({ autoCompactWindow: "1000001", lhcLowerBound: "50000" })).toBe(false);
    expect(accepts({ autoCompactWindow: "380000", lhcLowerBound: "9999" })).toBe(false);
    expect(accepts({ autoCompactWindow: "200000", lhcLowerBound: "199999" })).toBe(true);
    expect(accepts({ autoCompactWindow: "200000", lhcLowerBound: "200000" })).toBe(false);
  });

  it("refuses an idle compaction mode, so no stored config can name a second compaction owner", () => {
    expect(accepts({ idleCompaction: "beforeCacheExpires" })).toBe(false);
  });
});
