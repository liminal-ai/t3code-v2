const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role=radio]",
  "[role=checkbox]",
  "[role=switch]",
  "[role=option]",
  "[role=menuitem]",
  "[role=tab]",
  "[role=combobox]",
  "[role=slider]",
].join(",");

/** A control inside a card, such as a question's option, keeps its own arrow keys. */
export const onControl = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(CONTROL_SELECTOR) !== null;
