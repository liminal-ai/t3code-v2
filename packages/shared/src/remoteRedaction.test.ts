import { describe, expect, it } from "vite-plus/test";

import { redactPairingTokens } from "./remote.ts";

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

  it("leaves text without a token alone", () => {
    const text = "https://dgx-01.example.ts.net/ rejected the pairing token. Create a new link.";

    expect(redactPairingTokens(text, LINK)).toBe(text);
    expect(redactPairingTokens(text, "not a url")).toBe(text);
  });
});
