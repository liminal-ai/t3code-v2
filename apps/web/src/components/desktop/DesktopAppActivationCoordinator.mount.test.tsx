// @vitest-environment jsdom
import { act, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The root route's own view, with everything it renders stubbed except the route branches.
const testState = vi.hoisted(() => ({
  isElectron: true,
  pathname: "/",
  authGateState: { status: "authenticated" } as { readonly status: string },
  firstRun: "pending" as "pending" | "wizard" | "app",
  coordinator: { mounts: 0, unmounts: 0 },
  appShellShown: false,
  listeners: new Set<() => void>(),
}));

// The router and the gate re-render on their own, as the real ones do.
function subscribe(listener: () => void): () => void {
  testState.listeners.add(listener);
  return () => testState.listeners.delete(listener);
}

const { Passthrough, Nothing } = vi.hoisted(() => ({
  Passthrough: ({ children }: { readonly children?: ReactNode }) => children,
  Nothing: () => null,
}));

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: unknown) => ({
    options,
    useRouteContext: () => ({ authGateState: testState.authGateState }),
  }),
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string; hash: string }) => unknown;
  }) =>
    select({
      pathname: useSyncExternalStore(subscribe, () => testState.pathname),
      hash: "",
    }),
  useNavigate: () => vi.fn(),
  useRouter: () => ({}),
  redirect: vi.fn(),
  Outlet: Nothing,
  Link: Nothing,
}));
vi.mock("../../env", () => ({
  get isElectron() {
    return testState.isElectron;
  },
}));
vi.mock("./DesktopAppActivationCoordinator", () => ({
  DesktopAppActivationCoordinator: () => {
    useEffect(() => {
      testState.coordinator.mounts += 1;
      return () => {
        testState.coordinator.unmounts += 1;
      };
    }, []);
    return null;
  },
  DesktopAppActivationShellShown: () => {
    useEffect(() => {
      testState.appShellShown = true;
      return () => {
        testState.appShellShown = false;
      };
    }, []);
    return null;
  },
}));
vi.mock("../onboarding/FirstRunGate", () => ({
  FirstRunGate: ({ children }: { readonly children: ReactNode }) =>
    useSyncExternalStore(subscribe, () => testState.firstRun) === "app" ? children : null,
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: vi.fn(),
  scopeProjectRef: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("lucide", () => ({ Check: {}, Copy: {} }));
vi.mock("../../branding", () => ({
  APP_BASE_NAME: "T3 Code",
  APP_DISPLAY_NAME: "T3 Code",
  APP_STAGE_LABEL: "",
  APP_VERSION: "0.0.0",
}));
vi.mock("../../branding.logic", () => ({ resolveServerBackedAppDisplayName: () => "T3 Code" }));
vi.mock("../AppSidebarLayout", () => ({ AppSidebarLayout: Passthrough }));
vi.mock("../CommandPalette", () => ({ CommandPalette: Passthrough }));
vi.mock("../CustomSnoozeDialog", () => ({ CustomSnoozeDialogHost: Nothing }));
vi.mock("../ConfirmDialogHost", () => ({ ConfirmDialogHost: Nothing }));
vi.mock("../KeybindingsConfigWarning", () => ({ KeybindingsConfigWarning: Nothing }));
vi.mock("../cloud/ConnectOnboardingDialog", () => ({ ConnectOnboardingDialog: Nothing }));
vi.mock("../cloud/RelayClientInstallDialog", () => ({ RelayClientInstallDialog: Nothing }));
vi.mock("./SshPasswordPromptDialog", () => ({ SshPasswordPromptDialog: Nothing }));
vi.mock("./SnapShotCoordinator", () => ({ SnapShotCoordinator: Nothing }));
vi.mock("./DesktopWebLinkCoordinator", () => ({ DesktopWebLinkCoordinator: Nothing }));
vi.mock("./RunningThreadKeepAlive", () => ({ RunningThreadKeepAlive: Nothing }));
vi.mock("../PermissionUpdateNotice", () => ({ PermissionUpdateNotice: Nothing }));
vi.mock("../ProviderUpdateLaunchNotification", () => ({
  ProviderUpdateLaunchNotification: Nothing,
}));
vi.mock("../sidebar/updateEverythingRun", () => ({ DesktopUpdateLaunchNotice: Nothing }));
vi.mock("../LegacyThreadMigrationToast", () => ({ LegacyThreadMigrationToast: Nothing }));
vi.mock("../ThreadNotificationCoordinator", () => ({ ThreadNotificationCoordinator: Nothing }));
vi.mock("../ReopenClosedViewShortcut", () => ({ ReopenClosedViewShortcut: Nothing }));
vi.mock("../ProjectCloneToastCoordinator", () => ({ ProjectCloneToastCoordinator: Nothing }));
vi.mock("../pullRequest/guide/PullRequestGuideRunCoordinator", () => ({
  PullRequestGuideRunCoordinator: Nothing,
}));
vi.mock("../SlowRpcRequestToastCoordinator", () => ({ SlowRpcRequestToastCoordinator: Nothing }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: Nothing }));
vi.mock("../settings/ProviderAuthCallbackCoordinator", () => ({
  ProviderAuthCallbackCoordinator: Nothing,
}));
vi.mock("../settings/ThemeEditorHost", () => ({ ThemeEditorHost: Nothing }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ useCopyToClipboard: () => ({}) }));
vi.mock("../../hooks/useDefaultTheme", () => ({ useDefaultThemeAdoption: () => undefined }));
vi.mock("../../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeSync: () => undefined }));
vi.mock("../ui/button", () => ({ Button: Nothing }));
vi.mock("../MorphIcon", () => ({ MorphIcon: Nothing }));
vi.mock("../ui/standalone-page", () => ({
  StandalonePage: Passthrough,
  StandalonePageHeader: Nothing,
}));
vi.mock("../ui/toast", () => ({
  AnchoredToastProvider: Passthrough,
  ToastProvider: Passthrough,
  stackedThreadToast: vi.fn(),
  toastManager: {},
}));
vi.mock("../../lib/utils", () => ({ cn: () => "" }));
vi.mock("../../appearanceFonts", () => ({ applyAppearanceFontVariables: vi.fn() }));
vi.mock("../../appearanceContrast", () => ({ applyAppearanceContrast: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => undefined }));
vi.mock("../../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: vi.fn(),
  derivePhysicalProjectKeyFromPath: vi.fn(),
  selectProjectGroupingSettings: vi.fn(),
}));
vi.mock("../../uiStateStore", () => ({ useUiStateStore: () => undefined }));
vi.mock("../../hooks/useTheme", () => ({ syncBrowserChromeTheme: vi.fn() }));
vi.mock("../../observability/clientTracing", () => ({ configureClientTracing: vi.fn() }));
vi.mock("../../environments/primary", () => ({ resolveInitialServerAuthGateState: vi.fn() }));
vi.mock("../../hostedPairing", () => ({
  hasHostedPairingRequest: () => false,
  isHostedStaticApp: () => false,
}));
vi.mock("../promptLinks/HostedPromptLinkLanding", () => ({
  useHostedPromptLinkLanding: () => null,
}));
vi.mock("../../localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../state/server", () => ({
  primaryServerConfigAtom: {},
  primaryServerConfigEventAtom: {},
  primaryServerWelcomeAtom: {},
}));
vi.mock("../../state/entities", () => ({
  readProject: vi.fn(),
  setActiveEnvironmentId: vi.fn(),
  useActiveEnvironmentId: () => null,
}));
vi.mock("../KeybindingsUpdateToast.logic", () => ({
  createKeybindingsUpdateToastController: vi.fn(),
}));
vi.mock("../../lib/desktopSnapShot", () => ({ getDesktopSnapShotBridge: () => null }));
vi.mock("../../lib/desktopPasteAsText", () => ({ installDesktopPasteAsText: () => undefined }));
vi.mock("../../lib/snapShotSetupResume", () => ({
  shouldResumeSnapShotSetupOnStartup: () => false,
}));

import { Route } from "../../routes/__root";

const RootRouteView = Route.options.component!;

let renderer: ReactTestRenderer | null = null;

async function show(pathname: string, firstRun: typeof testState.firstRun): Promise<void> {
  await act(async () => {
    testState.pathname = pathname;
    testState.firstRun = firstRun;
    if (renderer === null) renderer = create(<RootRouteView />);
    else for (const listener of testState.listeners) listener();
  });
}

beforeEach(() => {
  testState.isElectron = true;
  testState.pathname = "/";
  testState.authGateState = { status: "authenticated" };
  testState.firstRun = "pending";
  testState.coordinator = { mounts: 0, unmounts: 0 };
  testState.appShellShown = false;
  testState.listeners.clear();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("the root route's desktop app activation", () => {
  it.each([["authenticated"], ["hosted-static"]])(
    "listens from a new install's first launch, through the wizard, into the app (%s)",
    async (status) => {
      testState.authGateState = { status };

      // The first-run gate is still deciding, and renders nothing.
      await show("/", "pending");
      expect(testState.coordinator).toEqual({ mounts: 1, unmounts: 0 });
      expect(testState.appShellShown).toBe(false);

      // The gate chose the wizard and redirected.
      await show("/welcome", "wizard");
      expect(testState.coordinator).toEqual({ mounts: 1, unmounts: 0 });
      expect(testState.appShellShown).toBe(false);

      // The wizard finished, and the gate lets the app shell through.
      await show("/", "app");
      expect(testState.coordinator).toEqual({ mounts: 1, unmounts: 0 });
      expect(testState.appShellShown).toBe(true);
    },
  );

  it("listens while the primary environment still needs pairing", async () => {
    testState.authGateState = { status: "requires-auth" };
    await show("/", "app");
    expect(testState.coordinator).toEqual({ mounts: 1, unmounts: 0 });
    expect(testState.appShellShown).toBe(false);
  });

  it("does not listen outside the desktop app", async () => {
    testState.isElectron = false;
    await show("/", "app");
    expect(testState.coordinator.mounts).toBe(0);
    expect(testState.appShellShown).toBe(false);
  });
});
