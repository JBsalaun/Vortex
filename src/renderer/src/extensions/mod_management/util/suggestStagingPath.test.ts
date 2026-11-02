import * as path from "path";

import { describe, expect, it, vi } from "vitest";

vi.mock("winapi-bindings", () => ({
  GetVolumePathName: vi.fn(() => {
    throw new Error("Windows API must not be called on Linux");
  }),
}));

vi.mock("../../../util/fs", () => ({
  statAsync: vi.fn(() => {
    throw new Error("Filesystem probing is unnecessary on Linux");
  }),
}));

import { suggestStagingPathForGame } from "./suggestStagingPath";

const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

describeOnLinux("suggestStagingPathForGame on Linux", () => {
  it("suggests a directory beside the game rather than inside it", async () => {
    const gamePath = path.join(
      path.sep,
      "home",
      "user",
      ".local",
      "share",
      "Steam",
      "steamapps",
      "common",
      "S.T.A.L.K.E.R. 2 Heart of Chornobyl",
    );

    await expect(
      suggestStagingPathForGame("unused", gamePath, "unused", "Vortex Mods"),
    ).resolves.toBe(path.join(path.dirname(gamePath), "Vortex Mods", "{game}", "mods"));
  });
});
