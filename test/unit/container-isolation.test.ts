import { describe, expect, it } from "vitest";

import { buildContainerRunArgs, type ContainerRunSpec } from "../../src/core/container.js";

const base: ContainerRunSpec = {
  imageId: "sha256:" + "a".repeat(64),
  operation: "hover",
  path: "src/main.ts",
  line: 1,
  character: 2,
  mounts: [{ source: "/state/candidates/cand_x/source", destination: "/candidate", label: "candidate source root" }],
  descriptorPath: "/state/runs/run-1/candidate.json",
  containerRoot: "/candidate",
};

/** Reads the value that follows a flag, so assertions do not depend on argument order. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function allValuesAfter(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg === flag && args[index + 1] !== undefined) values.push(args[index + 1] as string);
  });
  return values;
}

describe("container execution profile", () => {
  it("denies the network", () => {
    // The container profile is the only profile admitted as enforced. Its enforcement is
    // exactly this argument list, so each property is asserted rather than assumed.
    expect(valueAfter(buildContainerRunArgs(base), "--network")).toBe("none");
  });

  it("makes the root filesystem read-only and drops all capabilities", () => {
    const args = buildContainerRunArgs(base);
    expect(args).toContain("--read-only");
    expect(valueAfter(args, "--cap-drop")).toBe("ALL");
    expect(valueAfter(args, "--security-opt")).toBe("no-new-privileges");
  });

  it("runs as a non-root user", () => {
    const user = valueAfter(buildContainerRunArgs(base), "--user");
    expect(user).toBeDefined();
    expect(user?.startsWith("0:")).toBe(false);
    expect(user).toBe("65532:65532");
  });

  it("bounds process, memory and cpu resources", () => {
    const args = buildContainerRunArgs(base);
    expect(valueAfter(args, "--pids-limit")).toBe("256");
    expect(valueAfter(args, "--memory")).toBe("1024m");
    expect(valueAfter(args, "--cpus")).toBe("2");
  });

  it("mounts every bind read-only", () => {
    const args = buildContainerRunArgs({
      ...base,
      mounts: [
        { source: "/state/candidates/cand_x/source", destination: "/candidate", label: "candidate source root" },
        { source: "/state/dependencies/depsnap_y/dependencies", destination: "/dependencies", label: "dependency snapshot root" },
      ],
    });

    const mounts = allValuesAfter(args, "--mount");
    expect(mounts.length).toBe(3);
    for (const mount of mounts) {
      expect(mount).toMatch(/,readonly$/);
      expect(mount.startsWith("type=bind,")).toBe(true);
    }
    expect(mounts.some((mount) => mount.includes("dst=/dependencies"))).toBe(true);
  });

  it("keeps writable space on noexec tmpfs rather than a bind mount", () => {
    const tmpfs = allValuesAfter(buildContainerRunArgs(base), "--tmpfs");
    expect(tmpfs.length).toBeGreaterThan(0);
    for (const entry of tmpfs) {
      expect(entry).toContain("noexec");
      expect(entry).toContain("nosuid");
      expect(entry).toContain("nodev");
    }
  });

  it("pins the image by digest rather than by tag", () => {
    const args = buildContainerRunArgs(base);
    expect(args).toContain(base.imageId);
    expect(base.imageId.startsWith("sha256:")).toBe(true);
  });

  it("refuses a host path the mount encoder cannot represent unambiguously", () => {
    // A comma would split the mount specification and silently change what is exposed.
    expect(() => buildContainerRunArgs({
      ...base,
      mounts: [{ source: "/state/a,b/source", destination: "/candidate", label: "candidate source root" }],
    })).toThrow(/CONTAINER_ISOLATION_INVALID/);

    expect(() => buildContainerRunArgs({ ...base, descriptorPath: "/state/run\n1/candidate.json" }))
      .toThrow(/CONTAINER_ISOLATION_INVALID/);
  });

  it("refuses a relative container destination", () => {
    expect(() => buildContainerRunArgs({
      ...base,
      mounts: [{ source: "/state/source", destination: "candidate", label: "candidate source root" }],
    })).toThrow(/CONTAINER_ISOLATION_INVALID/);
  });
});
