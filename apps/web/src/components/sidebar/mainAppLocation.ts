import { useNavigate, type AnyRouter } from "@tanstack/react-router";

import { GUEST_PAGE_PATH } from "../../guestPage";

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") ||
    pathname === "/group-chat" ||
    pathname.startsWith("/group-chat/") ||
    pathname === "/pull-requests"
  );
}

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

// A full-document load of a utility page drops module memory, so the href is
// also kept in the tab's sessionStorage for Back to return to after a reload.
const MAIN_APP_HREF_KEY = "t3code:main-app-href";

let mainAppHref: string | null = null;
let appModalReturnHref: string | null = null;

export function rememberMainAppHref(
  href: string,
  getStorage: () => Storage = () => window.sessionStorage,
) {
  mainAppHref = href;
  try {
    getStorage().setItem(MAIN_APP_HREF_KEY, href);
  } catch {}
}

function isSameOriginMainAppHref(href: string) {
  const base = "http://main-app.invalid";
  const url = new URL(href, base);
  return (
    url.origin === base &&
    !isSidebarUtilityPage(url.pathname) &&
    !isAppModalPage(url.pathname) &&
    !SHELL_LESS_PATHS.has(url.pathname)
  );
}

export function mainAppReturnHref(getStorage: () => Storage = () => window.sessionStorage) {
  if (mainAppHref !== null) return mainAppHref;
  try {
    const saved = getStorage().getItem(MAIN_APP_HREF_KEY);
    if (saved !== null && isSameOriginMainAppHref(saved)) return saved;
  } catch {}
  return "/";
}

/** Remembers where Settings, Usage, and the utility pages lead back to. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname, href } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    appModalReturnHref = href;
    if (!isSidebarUtilityPage(pathname)) rememberMainAppHref(href);
  };
  record();
  return router.subscribe("onResolved", record);
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppReturnHref() });
}

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  return () => navigate({ href: appModalReturnHref ?? mainAppReturnHref() });
}
