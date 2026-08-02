import { invokeTauri } from "@/shared/api/tauri";
import type { DesignRepoResult } from "@/shared/api/types";

/**
 * Clone a team's frontend repo into the design workspace so agents can work
 * from the real source. Authenticates with the GitHub connector's stored token
 * when present (private repos work with no extra setup).
 *
 * `repo` accepts `owner/repo` or any github.com URL form. Throws a string error
 * on failure (bad repo, clone error).
 */
export async function cloneDesignRepo(repo: string): Promise<DesignRepoResult> {
  return invokeTauri<DesignRepoResult>("clone_design_repo", { repo });
}
