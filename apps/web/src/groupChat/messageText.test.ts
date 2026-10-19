import { describe, expect, it } from "vite-plus/test";

import { LONG_MESSAGE_CHARS, PREVIEW_CHARS, plainSnippet, previewOf } from "./messageText";

const filler = (chars: number, line = "the quick brown fox jumps over the lazy dog") => {
  const lines: string[] = [];
  while (lines.join("\n").length < chars) lines.push(line);
  return lines.join("\n");
};

const fenceLines = (preview: string) =>
  preview.split("\n").filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line));

describe("message previews", () => {
  it("a preview closes a tilde fence with a tilde fence", () => {
    const text = `intro\n~~~\n${filler(LONG_MESSAGE_CHARS)}\n~~~\nafter`;
    const preview = previewOf(text);
    expect(preview.length).toBeLessThan(text.length);
    expect(fenceLines(preview)).toEqual(["~~~", "~~~"]);
    expect(preview).not.toContain("```");
  });

  it("a preview closes a four-backtick fence with four backticks", () => {
    const text = `intro\n\`\`\`\`md\n\`\`\`\ninner\n\`\`\`\n${filler(LONG_MESSAGE_CHARS)}\n\`\`\`\`\nafter`;
    const preview = previewOf(text);
    expect(fenceLines(preview).at(-1)).toBe("````");
    // The three-backtick lines inside stay inner content: only the outer fence was open.
    expect(fenceLines(preview).filter((line) => line.startsWith("````"))).toEqual([
      "````md",
      "````",
    ]);
  });

  it("a preview never cuts inside a fence opener", () => {
    const line = "x".repeat(PREVIEW_CHARS - 2);
    const text = `${line}\n\`\`\`typescript\n${filler(LONG_MESSAGE_CHARS)}\n\`\`\``;
    const preview = previewOf(text);
    expect(preview).not.toMatch(/^`{1,2}$/m);
    expect(preview).not.toMatch(/^`{3}[a-z]{0,9}$/m);
    expect(preview.startsWith(line)).toBe(true);
  });

  it("a preview of an unfenced message ends at a line break and an ellipsis", () => {
    const preview = previewOf(filler(LONG_MESSAGE_CHARS));
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_CHARS + 3);
    expect(preview.endsWith("\n\n…")).toBe(true);
    expect(fenceLines(preview)).toEqual([]);
  });
});

describe("plain snippets", () => {
  it("drops markdown and cuts to one line", () => {
    expect(
      plainSnippet("# Title\n\n**bold** and `code` [link](http://x)\n```\nblock\n```\n- item"),
    ).toBe("Title bold and code link item");
    expect(plainSnippet("a".repeat(100), 10)).toBe(`${"a".repeat(10)}…`);
  });
});
