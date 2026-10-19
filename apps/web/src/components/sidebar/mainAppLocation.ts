import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/group-chat" ||
    pathname.startsWith("/group-chat/") ||
    pathname === "/pull-requests"
  );
}

// A full-document load of a utility page drops module memory, so the href is
// also kept in the tab's sessionStorage for Back to return to after a reload.
const MAIN_APP_HREF_KEY = "t3code:main-app-href";

let mainAppHref: string | null = null;

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
  return url.origin === base && !isSidebarUtilityPage(url.pathname);
}

export function mainAppReturnHref(getStorage: () => Storage = () => window.sessionStorage) {
  if (mainAppHref !== null) return mainAppHref;
  try {
    const saved = getStorage().getItem(MAIN_APP_HREF_KEY);
    if (saved !== null && isSameOriginMainAppHref(saved)) return saved;
  } catch {}
  return "/";
}

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null) rememberMainAppHref(href);
  }, [href]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: mainAppReturnHref() }), [navigate]);
}
