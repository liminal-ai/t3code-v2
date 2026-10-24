import { describe, expect, it } from "vite-plus/test";

import { onControl } from "./keys";

describe("lane shortcuts and controls", () => {
  it("a question's option, and the click its radio emits, belong to the control, a lane card does not", () => {
    document.body.innerHTML = `
      <div data-testid="lane-message" role="button" tabindex="0">
        <div role="radiogroup"><span role="radio" tabindex="0">tea</span><input type="radio" tabindex="-1" aria-hidden="true" /></div>
        <button type="button">Show all</button>
      </div>`;
    expect(onControl(document.querySelector("[role=radio]"))).toBe(true);
    expect(onControl(document.querySelector("button"))).toBe(true);
    expect(onControl(document.querySelector("input[type=radio]"))).toBe(true);
    expect(onControl(document.querySelector("[data-testid=lane-message]"))).toBe(false);
    expect(onControl(document.body)).toBe(false);
    expect(onControl(null)).toBe(false);
  });
});
