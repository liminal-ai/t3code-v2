import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopAppActivationRequest,
  DesktopAppActivationRequestType,
  DesktopAppActivationResponse,
  DesktopAppOpenWorkspaceRequest,
  DesktopBridge,
} from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef } from "react";

import { readEnvironmentCatalogEntries } from "../../connection/catalog";
import { connectPairing } from "../../connection/onboarding";
import {
  desktopAppEnvironmentRecord,
  handleDesktopAppActivationRequest,
  handleDesktopAppListEnvironmentsRequest,
  handleDesktopAppPairRequest,
  type DesktopAppEnvironmentDependencies,
} from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProjects, waitForProject } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

// Pairing and listing need only this window, so they run with the local environment switched off.
const ENVIRONMENT_REQUESTS: ReadonlyArray<DesktopAppActivationRequestType> = [
  "pair-environment",
  "list-environments",
];
const ALL_REQUESTS: ReadonlyArray<DesktopAppActivationRequestType> = [
  "open-workspace",
  ...ENVIRONMENT_REQUESTS,
];

type DesktopAppActivationBridge = NonNullable<DesktopBridge["appActivation"]>;

const COMPLETION_ATTEMPTS = 3;

const appShellShownAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop-app-activation:app-shell-shown"),
);

/**
 * Mounted with the app shell, past first-run onboarding. The coordinator itself mounts above
 * the first-run gate, so pairing and listing work on a new install, and opens a workspace only
 * while this is mounted, as upstream did when the gate held the whole coordinator.
 */
export function DesktopAppActivationShellShown() {
  const setAppShellShown = useAtomSet(appShellShownAtom);
  useEffect(() => {
    setAppShellShown(true);
    return () => setAppShellShown(false);
  }, [setAppShellShown]);
  return null;
}

function unreportedResultMessage(request: DesktopAppActivationRequest): string {
  return request.type === "pair-environment"
    ? "T3 Code finished the pairing but could not report how it went, so it may have saved the environment. Run `t3 app environments` before you create a new link."
    : "T3 Code finished the request but could not report how it went.";
}

// The desktop app holds the next request until it hears how this one ended, so a result it
// refuses is sent again, and then replaced by a failure it cannot refuse.
async function reportCompletion(
  activation: DesktopAppActivationBridge,
  request: DesktopAppActivationRequest,
  response: DesktopAppActivationResponse,
): Promise<void> {
  for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt += 1) {
    try {
      await activation.complete(response);
      return;
    } catch (error) {
      console.warn("The desktop app refused an activation result.", {
        requestId: request.requestId,
        attempt,
        error,
      });
    }
  }
  try {
    await activation.complete({
      version: 1,
      requestId: request.requestId,
      ok: false,
      code: "internal-error",
      message: unreportedResultMessage(request),
    });
  } catch (error) {
    console.error("The desktop app refused an activation failure.", {
      requestId: request.requestId,
      error,
    });
  }
}

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const pairEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const readCatalogEntries = useAtomCommand(readEnvironmentCatalogEntries, {
    reportFailure: false,
  });
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const appShellShown = useAtomValue(appShellShownAtom);
  const shell = useEnvironmentQuery(
    !appShellShown || primaryEnvironment === null
      ? null
      : environmentShell.stateAtom(primaryEnvironment.environmentId),
  );
  const workspaceReady =
    appShellShown &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null &&
    shell.data?.snapshot._tag === "Some";

  const environmentDependencies: DesktopAppEnvironmentDependencies = {
    readEnvironments: async () => {
      const result = await readCatalogEntries();
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        throw error instanceof Error
          ? error
          : new Error("T3 Code could not read its environments.");
      }
      return [...result.value.values()].map((entry) => {
        const presentation = appAtomRegistry.get(
          environmentPresentations.presentationAtom(entry.target.environmentId),
        );
        // A registration that just finished has no supervisor state yet.
        const connection =
          presentation?.connection.phase ?? (entry.enabled ? "connecting" : "offline");
        return desktopAppEnvironmentRecord(entry, connection);
      });
    },
    pairEnvironment: async (input) => {
      const result = await pairEnvironment(input);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
  };

  const processOpenWorkspace = (request: DesktopAppOpenWorkspaceRequest) =>
    handleDesktopAppActivationRequest(request, {
      getTarget: () => {
        if (
          primaryEnvironment?.connection.phase !== "connected" ||
          primaryEnvironment.serverConfig === null
        ) {
          return null;
        }
        return {
          environmentId: primaryEnvironment.environmentId,
          platform: primaryEnvironment.serverConfig.environment.platform.os,
        };
      },
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => openThread(projectRef),
    });

  const processRequest = useEffectEvent(
    async (request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> => {
      try {
        switch (request.type) {
          case "open-workspace":
            return await processOpenWorkspace(request);
          case "pair-environment":
            return await handleDesktopAppPairRequest(request, environmentDependencies);
          case "list-environments":
            return await handleDesktopAppListEnvironmentsRequest(request, environmentDependencies);
        }
      } catch (error) {
        return {
          version: 1,
          requestId: request.requestId,
          ok: false,
          code: "internal-error",
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "T3 Code could not process the request.",
        };
      }
    },
  );

  useEffect(() => {
    if (activation === undefined) return;

    const unsubscribe = activation.onRequest((request) => {
      const run = async () => reportCompletion(activation, request, await processRequest(request));
      // Listing only reads, so it does not wait behind a pairing.
      if (request.type === "list-environments") {
        void run();
        return;
      }
      queueRef.current = queueRef.current.then(run);
    });
    return () => {
      void activation.setReady([]).catch(() => undefined);
      unsubscribe();
    };
  }, [activation]);

  // Opening a workspace waits for the app shell, the local environment and its shell. The desktop app holds
  // those requests until then and sends the others past them.
  useEffect(() => {
    if (activation === undefined) return;

    let current = true;
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (current) {
        void activation
          .setReady(workspaceReady ? ALL_REQUESTS : ENVIRONMENT_REQUESTS)
          .catch(() => undefined);
      }
    });
    return () => {
      current = false;
    };
  }, [activation, workspaceReady]);

  return null;
}
