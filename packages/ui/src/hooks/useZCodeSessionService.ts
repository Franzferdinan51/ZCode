import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // Both hooks must run on every render: workspacePath resolves asynchronously,
  // and branching hook calls on it shifts the hook order between renders,
  // crashing React with "change in the order of Hooks".
  const scopedServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  return (workspacePath ? scopedServices : contextServices).zcodeSessionService;
}
