import { useEffect, useRef } from "react";
import type { Device, Page, Resource, TransferTask } from "./types";

type Workspace = {
  page: Page;
  devices: Device[];
  resources: Resource[];
  tasks: TransferTask[];
};
interface Context {
  registerTool(
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute(input: unknown): unknown;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}
export function useWorkspaceTools(workspace: Workspace) {
  const current = useRef(workspace);
  current.current = workspace;
  useEffect(() => {
    const context = (document as Document & { modelContext?: Context })
      .modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: "inspect_demo_workspace",
            title: "查看演示工作空间",
            description:
              "Read visible demo device, resource metadata and task state. Does not upload files, transmit data, or change any state. All devices and tasks are simulated.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute(input) {
              if (
                !input ||
                typeof input !== "object" ||
                Array.isArray(input) ||
                Object.keys(input).length
              )
                throw new Error("Expected an empty object.");
              const { page, devices, resources, tasks } = current.current;
              return {
                mode: "local-demo",
                page,
                devices,
                resources: resources.map(
                  ({ id, name, kind, size, origin }) => ({
                    id,
                    name,
                    kind,
                    size,
                    origin,
                  }),
                ),
                tasks,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => {
        /* Optional browser enhancement; normal UI is independent. */
      });
    } catch {
      /* Browser support is optional. */
    }
    return () => lifecycle.abort();
  }, []);
}
