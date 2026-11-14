// Preview builds share nightly branding but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

// liminal-ai/t3code-v2 builds (see isDesktopLimVersion in scripts/build-desktop-artifact.ts).
export function isLimDesktopVersion(version: string): boolean {
  return /-lim\./.test(version);
}
