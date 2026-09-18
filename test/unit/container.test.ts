import { describe, expect, it } from "vitest";

import { parseLinuxMountInfo } from "../../src/core/container.js";

describe("Linux mountinfo parsing", () => {
  it("decodes escaped mount points and preserves read-only mount options", () => {
    const entries = parseLinuxMountInfo([
      "36 25 0:31 / / rw,relatime - overlay overlay rw",
      "42 36 0:45 /src /candidate ro,nosuid,nodev,relatime - ext4 /dev/sda1 rw",
      "43 36 0:46 /input /input/candidate\\040file.json ro,relatime - ext4 /dev/sda1 rw",
      "",
    ].join("\n"));

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ mount_point: "/candidate", mount_options: expect.arrayContaining(["ro"]) }),
      expect.objectContaining({ mount_point: "/input/candidate file.json", mount_options: expect.arrayContaining(["ro"]) }),
    ]));
  });
});
