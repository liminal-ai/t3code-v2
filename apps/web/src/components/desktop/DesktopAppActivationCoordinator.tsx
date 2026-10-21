import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopAppActivationRequest,
  DesktopAppActivationRequestType,
  DesktopAppActivationResponse,
  DesktopAppOpenWorkspaceRequest,
} from "@t3tools/contracts";
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
  const shell = useEnvironmentQuery(
    primaryEnvironment === null
      ? null
      : environmentShell.stateAtom(primaryEnvironment.environmentId),
  );
  const workspaceReady =
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
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    return () => {
      void activation.setReady([]).catch(() => undefined);
      unsubscribe();
    };
  }, [activation]);

  // Opening a workspace waits for the local environment and its shell. The desktop app holds
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
