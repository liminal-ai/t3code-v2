import { describe, expect, it } from "vite-plus/test";

import { redactPairingTokens, resolveRemotePairingTarget } from "./remote.ts";

const TOKEN = "SYNTHETIC+secret/token";
const LINK = `https://dgx-01.example.ts.net/pair#token=${encodeURIComponent(TOKEN)}`;

describe("redactPairingTokens", () => {
  it.each([
    ["a fragment link", `Failed to pair ${LINK}.`],
    ["a query link", `Failed to pair https://dgx-01.example.ts.net/pair?token=${TOKEN}&x=1.`],
    ["a hosted link", `Bad link https://app.t3.codes/pair?host=dgx-01#token=${TOKEN}`],
    ["an encoded link", `Could not fetch ${encodeURIComponent(LINK)}`],
    ["a twice-encoded link", `Could not fetch ${encodeURIComponent(encodeURIComponent(LINK))}`],
    ["a quoted link", `Unexpected positional argument: ${JSON.stringify(LINK)}`],
  ])("hides the token in %s", (_, text) => {
    const redacted = redactPairingTokens(text);

    expect(redacted).toContain("<redacted>");
    expect(redacted).not.toContain("SYNTHETIC");
  });

  it.each([
    ["raw", TOKEN],
    ["encoded", encodeURIComponent(TOKEN)],
    ["twice-encoded", encodeURIComponent(encodeURIComponent(TOKEN))],
  ])("hides the link's own token quoted %s without its name", (_, quoted) => {
    expect(redactPairingTokens(`The server rejected ${quoted}.`, LINK)).toBe(
      "The server rejected <redacted>.",
    );
  });

  // URLSearchParams decodes names and values, so each of these links carries SYNTHETIC_PR24_SECRET
  // or SYNTHETIC+PR24/SECRET.
  const encodedLinks = [
    [
      "an encoded fragment name",
      "https://dgx-01.example.ts.net/pair#%74oken=SYNTHETIC_PR24_SECRET",
    ],
    ["an encoded query name", "https://dgx-01.example.ts.net/pair?to%6Ben=SYNTHETIC_PR24_SECRET"],
    [
      "a fully encoded name",
      "https://dgx-01.example.ts.net/pair#%74%6F%6B%65%6E=SYNTHETIC_PR24_SECRET&x=1",
    ],
    ["a noncanonical value", "https://dgx-01.example.ts.net/pair#%74oken=%53YNTHETIC_PR24_SECRET"],
    ["lowercase escapes", "https://dgx-01.example.ts.net/pair#token=SYNTHETIC%2bPR24%2fSECRET"],
    ["a tab in the name", "https://dgx-01.example.ts.net/pair#to\tken=SYNTHETIC_PR24_SECRET"],
  ] as const;

  it.each(encodedLinks)("hides the token of a link with %s, however it is quoted", (_, link) => {
    expect(resolveRemotePairingTarget({ pairingUrl: link }).credential).toMatch(/PR24/);
    for (const quoted of [
      link,
      encodeURIComponent(link),
      encodeURIComponent(encodeURIComponent(link)),
    ]) {
      expect(redactPairingTokens(`Could not fetch ${quoted}`)).not.toContain("PR24");
    }
    for (const quoted of [link, JSON.stringify(link), encodeURIComponent(link)]) {
      expect(redactPairingTokens(`Unexpected positional argument: ${quoted}`, link)).not.toContain(
        "PR24",
      );
    }
  });

  it.each(encodedLinks)("hides the token of a link with %s quoted as written", (_, link) => {
    const written = link.split("=")[1]!.split("&")[0]!;

    for (const quoted of [written, encodeURIComponent(written)]) {
      expect(redactPairingTokens(`The server rejected ${quoted}.`, link)).toBe(
        "The server rejected <redacted>.",
      );
    }
  });

  it("leaves text without a token alone", () => {
    const text = "https://dgx-01.example.ts.net/ rejected the pairing token. Create a new link.";

    expect(redactPairingTokens(text, LINK)).toBe(text);
    expect(redactPairingTokens(text, "not a url")).toBe(text);
  });
});
