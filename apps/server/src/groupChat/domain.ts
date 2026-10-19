export const SIGN_OFF_MARKER = "[[SIGN-OFF]]";

export const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export const newId = (prefix: string) => `${prefix}_${randomHex(10)}`;
