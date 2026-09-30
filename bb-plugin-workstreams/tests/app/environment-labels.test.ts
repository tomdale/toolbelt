import { describe, expect, it } from "vitest";
import {
  buildEnvironmentOptions,
  formatEnvironmentLabel,
  isPersonalEnvironment,
  isProjectWorkspaceEnvironment,
  isProviderAvailable,
  type CatalogEnvironment,
  type CatalogProvider,
  type CatalogThread,
} from "../../src/app/composer/environment-labels.ts";

describe("environment-labels", () => {
  const providers: CatalogProvider[] = [
    {
      id: "personal-workspace",
      displayName: "Personal workspace",
      availability: { status: "available" },
    },
    {
      id: "project-checkout",
      displayName: "Project checkout",
      availability: { status: "available" },
    },
    {
      id: "git-worktree",
      displayName: "New worktree",
      availability: { status: "available" },
    },
  ];

  it("identifies personal vs project workspace environments correctly", () => {
    expect(
      isPersonalEnvironment({
        type: "host",
        workspace: { type: "personal" },
      }),
    ).toBe(true);
    expect(
      isPersonalEnvironment({
        type: "provider",
        environmentProviderId: "personal-workspace",
        machine: { type: "existing", hostId: "h1" },
        inputs: null,
      }),
    ).toBe(true);
    expect(
      isPersonalEnvironment({
        type: "host",
        workspace: { type: "unmanaged", path: null },
      }),
    ).toBe(false);

    expect(
      isProjectWorkspaceEnvironment({
        type: "host",
        workspace: { type: "unmanaged", path: null },
      }),
    ).toBe(true);
    expect(
      isProjectWorkspaceEnvironment({
        type: "host",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      }),
    ).toBe(true);
    expect(
      isProjectWorkspaceEnvironment({
        type: "host",
        workspace: { type: "personal" },
      }),
    ).toBe(false);
  });

  it("uses explicit environment name when set", () => {
    const env: CatalogEnvironment = {
      id: "env_1",
      name: "Custom Named Workspace",
      branchName: "feature-x",
      path: "/some/path",
    };
    expect(formatEnvironmentLabel(env)).toBe("Custom Named Workspace");
  });

  it("derives personal workspace labels from thread title, path, or short ID without raw env IDs", () => {
    const threads: CatalogThread[] = [
      {
        id: "thr_1",
        title: "Weekend Trip Planner",
        sectionId: null,
        projectId: "proj_personal",
        environmentId: "env_p1",
        environmentName: null,
      },
    ];

    // Case 1: with thread title
    const envWithThread: CatalogEnvironment = {
      id: "env_p1",
      name: null,
      environmentProviderId: "personal-workspace",
      path: "/Users/user/.bb/plugins/environment-personal-workspace/host-data/workspaces/thr_1",
    };
    expect(formatEnvironmentLabel(envWithThread, threads, providers)).toBe(
      "Personal workspace (Weekend Trip Planner)",
    );

    // Case 2: without thread title, but with path segment
    const envWithPath: CatalogEnvironment = {
      id: "env_p2",
      name: null,
      environmentProviderId: "personal-workspace",
      path: "/Users/user/.bb/plugins/environment-personal-workspace/host-data/workspaces/thr_unwd8bt3q9",
    };
    expect(formatEnvironmentLabel(envWithPath, [], providers)).toBe(
      "Personal workspace (thr_unwd8b)",
    );

    // Case 3: without path, short ID fallback
    const envMinimal: CatalogEnvironment = {
      id: "env_r2iuwi2n7i",
      name: null,
      environmentProviderId: "personal-workspace",
    };
    expect(formatEnvironmentLabel(envMinimal, [], providers)).toBe(
      "Personal workspace (r2iuwi)",
    );
    // Crucially: not raw env_r2iuwi2n7i and not "Unnamed environment"
    expect(formatEnvironmentLabel(envMinimal, [], providers)).not.toContain(
      "env_r2iuwi2n7i",
    );
    expect(formatEnvironmentLabel(envMinimal, [], providers)).not.toBe(
      "Unnamed environment",
    );
  });

  it("derives worktree labels from branch name or path", () => {
    const envBranch: CatalogEnvironment = {
      id: "env_w1",
      name: null,
      environmentProviderId: "git-worktree",
      branchName: "tomdale/fix-modal",
      isWorktree: true,
    };
    expect(formatEnvironmentLabel(envBranch, [], providers)).toBe(
      "Worktree (tomdale/fix-modal)",
    );

    const envWorktreePath: CatalogEnvironment = {
      id: "env_w2",
      name: null,
      environmentProviderId: "git-worktree",
      path: "/Users/user/Code/Repos/bb/worktrees/task-42",
      isWorktree: true,
    };
    expect(formatEnvironmentLabel(envWorktreePath, [], providers)).toBe(
      "Worktree (task-42)",
    );
  });

  it("derives project checkout labels from path and branch", () => {
    const envCheckout: CatalogEnvironment = {
      id: "env_c1",
      name: null,
      environmentProviderId: "project-checkout",
      path: "/Users/user/Code/tomdaleOS",
      branchName: "main",
    };
    expect(formatEnvironmentLabel(envCheckout, [], providers)).toBe(
      "tomdaleOS",
    );

    const envCheckoutBranch: CatalogEnvironment = {
      id: "env_c2",
      name: null,
      environmentProviderId: "project-checkout",
      path: "/Users/user/Code/Reviews/agents/pr-3111",
      branchName: "bryan/signals-feature",
    };
    expect(formatEnvironmentLabel(envCheckoutBranch, [], providers)).toBe(
      "pr-3111 (bryan/signals-feature)",
    );
  });

  it("disambiguates identical environment labels within a list", () => {
    const environments: CatalogEnvironment[] = [
      {
        id: "env_aaa111",
        name: null,
        environmentProviderId: "git-worktree",
        branchName: "main",
      },
      {
        id: "env_bbb222",
        name: null,
        environmentProviderId: "git-worktree",
        branchName: "main",
      },
      {
        id: "env_unique",
        name: "Unique Workspace",
      },
    ];

    const options = buildEnvironmentOptions(environments, [], providers);
    expect(options).toEqual([
      {
        value: "env_aaa111",
        label: "Worktree (main) [aaa111]",
      },
      {
        value: "env_bbb222",
        label: "Worktree (main) [bbb222]",
      },
      {
        value: "env_unique",
        label: "Unique Workspace",
      },
    ]);
  });

  it("disambiguates environment labels colliding with static provider labels", () => {
    const environments: CatalogEnvironment[] = [
      {
        id: "env_chk123",
        name: null,
        environmentProviderId: "project-checkout",
      },
    ];

    const options = buildEnvironmentOptions(environments, [], providers, [
      "Project checkout",
      "New worktree",
    ]);
    expect(options).toEqual([
      {
        value: "env_chk123",
        label: "Project checkout [chk123]",
      },
    ]);
  });

  it("isProviderAvailable checks availability and machineAvailability correctly", () => {
    const pExplicitAvail: CatalogProvider = {
      id: "p1",
      displayName: "P1",
      availability: { status: "available" },
    };
    expect(isProviderAvailable(pExplicitAvail, "host_x")).toBe(true);

    const pExplicitUnavail: CatalogProvider = {
      id: "p2",
      displayName: "P2",
      availability: { status: "unavailable" },
    };
    expect(isProviderAvailable(pExplicitUnavail, "host_x")).toBe(false);

    const pMachineScoped: CatalogProvider = {
      id: "p3",
      displayName: "P3",
      availability: null,
      machineAvailability: {
        host_remote: { status: "available" },
        host_broken: { status: "unavailable" },
      },
    };
    // Listed available host: true
    expect(isProviderAvailable(pMachineScoped, "host_remote")).toBe(true);
    // Listed unavailable host: false
    expect(isProviderAvailable(pMachineScoped, "host_broken")).toBe(false);
    // Unlisted host: MUST be false (not available on unlisted machines)
    expect(isProviderAvailable(pMachineScoped, "host_local")).toBe(false);
  });
});
