import type { Environment } from "./intake.ts";

export type CatalogProvider = {
  id: string;
  displayName: string;
  description?: string | null;
  availability?: {
    status: "available" | "setup-required" | "unavailable";
    message?: string;
  } | null;
  machineAvailability?: Record<
    string,
    {
      status: "available" | "setup-required" | "unavailable";
      message?: string;
    } | null
  >;
  requires?: {
    gitCheckout: boolean;
    gitRemote: boolean;
    projectCheckout: boolean;
    projectless: boolean;
  };
  acceptsEmptyInputs?: boolean;
};

export type CatalogEnvironment = {
  id: string;
  name: string | null;
  path?: string | null;
  branchName?: string | null;
  environmentProviderId?: string | null;
  isWorktree?: boolean;
  isGitRepo?: boolean;
};

export type CatalogThread = {
  id: string;
  title: string;
  sectionId: string | null;
  projectId: string;
  environmentId: string | null;
  environmentName: string | null;
  providerId?: string;
};

export function hostWorkspaceProviderId(
  workspaceType: "managed-worktree" | "unmanaged" | "personal",
): string {
  switch (workspaceType) {
    case "managed-worktree":
      return "git-worktree";
    case "unmanaged":
      return "project-checkout";
    case "personal":
      return "personal-workspace";
  }
}

export function isProviderAvailable(
  provider: CatalogProvider | undefined,
  hostId: string | null,
): boolean {
  if (!provider) return false;
  if (provider.availability) {
    return provider.availability.status === "available";
  }
  if (hostId && provider.machineAvailability) {
    return provider.machineAvailability[hostId]?.status === "available";
  }
  return true;
}

export function isPersonalEnvironment(
  environment: Environment | null | undefined,
): boolean {
  if (!environment) return false;
  if (environment.type === "host")
    return environment.workspace.type === "personal";
  if (environment.type === "provider")
    return environment.environmentProviderId === "personal-workspace";
  return false;
}

export function isProjectWorkspaceEnvironment(
  environment: Environment | null | undefined,
): boolean {
  if (!environment) return false;
  if (environment.type === "host")
    return (
      environment.workspace.type === "unmanaged" ||
      environment.workspace.type === "managed-worktree"
    );
  if (environment.type === "provider")
    return (
      environment.environmentProviderId === "project-checkout" ||
      environment.environmentProviderId === "git-worktree"
    );
  return false;
}

function pathBasename(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  const normalized = rawPath.replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]+/).filter(Boolean);
  return parts.pop() ?? null;
}

function shortId(rawId: string): string {
  return rawId.replace(/^env_/, "").slice(0, 6);
}

/** Formats a descriptive, readable label for an environment using metadata. */
export function formatEnvironmentLabel(
  env: CatalogEnvironment,
  threads?: readonly CatalogThread[],
  providers?: readonly CatalogProvider[],
): string {
  if (env.name && env.name.trim()) return env.name.trim();

  const branch = env.branchName?.trim();
  const path = env.path?.trim();
  const basename = pathBasename(path);
  const providerId = env.environmentProviderId;
  const provider = providers?.find((p) => p.id === providerId);
  const providerName =
    provider?.displayName ??
    (providerId === "personal-workspace"
      ? "Personal workspace"
      : providerId === "git-worktree"
        ? "Worktree"
        : providerId === "project-checkout"
          ? "Project checkout"
          : null);

  const associatedThread = threads?.find((t) => t.environmentId === env.id);
  const threadTitle = associatedThread?.title?.trim();

  const isPersonal =
    providerId === "personal-workspace" ||
    (!!path &&
      (path.includes("personal-workspace") ||
        path.includes("personal-workspaces")));

  if (isPersonal) {
    if (threadTitle) return `Personal workspace (${threadTitle})`;
    if (basename) {
      const clean = basename.startsWith("thr_")
        ? basename.slice(0, 10)
        : basename;
      return `Personal workspace (${clean})`;
    }
    return `Personal workspace (${shortId(env.id)})`;
  }

  if (env.isWorktree || providerId === "git-worktree") {
    if (branch) return `Worktree (${branch})`;
    if (basename) return `Worktree (${basename})`;
    if (threadTitle) return `Worktree (${threadTitle})`;
    return `Worktree (${shortId(env.id)})`;
  }

  if (providerId === "project-checkout") {
    if (basename) {
      if (branch && branch !== "main" && branch !== "master") {
        return `${basename} (${branch})`;
      }
      return basename;
    }
    if (branch) return `Project checkout (${branch})`;
    return "Project checkout";
  }

  if (branch && basename) return `${basename} (${branch})`;
  if (branch) return providerName ? `${providerName} (${branch})` : branch;
  if (basename) return providerName ? `${providerName}: ${basename}` : basename;
  if (threadTitle)
    return providerName
      ? `${providerName} (${threadTitle})`
      : `Environment (${threadTitle})`;
  return providerName
    ? `${providerName} (${shortId(env.id)})`
    : `Environment (${shortId(env.id)})`;
}

/** Builds option objects with duplicate-disambiguated labels. */
export function buildEnvironmentOptions(
  environments: readonly CatalogEnvironment[],
  threads?: readonly CatalogThread[],
  providers?: readonly CatalogProvider[],
  existingLabels: readonly string[] = [],
): Array<{ value: string; label: string }> {
  const baseLabels = environments.map((e) =>
    formatEnvironmentLabel(e, threads, providers),
  );
  const counts = new Map<string, number>();
  for (const label of existingLabels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  for (const label of baseLabels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return environments.map((e, index) => {
    const base = baseLabels[index]!;
    if ((counts.get(base) ?? 0) > 1) {
      return { value: e.id, label: `${base} [${shortId(e.id)}]` };
    }
    return { value: e.id, label: base };
  });
}
