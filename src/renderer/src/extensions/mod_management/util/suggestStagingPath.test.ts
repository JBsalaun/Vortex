import type { Stats } from "node:fs";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("winapi-bindings", () => ({
  GetVolumePathName: vi.fn(() => {
    throw new Error("Windows API must not be called on Linux");
  }),
}));

const { statAsync } = vi.hoisted(() => ({ statAsync: vi.fn() }));

vi.mock("../../../util/fs", () => ({ statAsync }));

import { suggestStagingPathForGame } from "./suggestStagingPath";

const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

function mockDevices(devices: Record<string, number>) {
  statAsync.mockImplementation(async (filePath) => {
    const dev = devices[String(filePath)];
    if (dev === undefined) {
      throw Object.assign(new Error("Missing directory"), { code: "ENOENT" });
    }
    return { dev } as Stats;
  });
}

describeOnLinux("suggestStagingPathForGame on Linux", () => {
  const gamePath = "/games/steamapps/common/Surviving Mars";
  const userDataPath = "/home/user/.config/Vortex";
  const modPath = "/home/user/.config/Surviving Mars/mods";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("suggests a directory beside the game when deployment uses the same filesystem", async () => {
    mockDevices({
      [path.join(gamePath, "Data")]: 2,
      [path.dirname(gamePath)]: 2,
      [userDataPath]: 1,
    });

    await expect(
      suggestStagingPathForGame(path.join(gamePath, "Data"), gamePath, userDataPath, "Vortex Mods"),
    ).resolves.toBe(path.join(path.dirname(gamePath), "Vortex Mods", "{game}", "mods"));
  });

  it("uses user data when mods deploy there and the game is on another filesystem", async () => {
    mockDevices({
      [modPath]: 1,
      [userDataPath]: 1,
      [path.dirname(gamePath)]: 2,
    });

    await expect(
      suggestStagingPathForGame(modPath, gamePath, userDataPath, "Vortex Mods"),
    ).resolves.toBe(path.join("{USERDATA}", "{game}", "mods"));
  });

  it("resolves missing mod directories through their nearest existing ancestor", async () => {
    mockDevices({
      "/home/user/.config": 1,
      [userDataPath]: 1,
      [path.dirname(gamePath)]: 2,
    });

    await expect(
      suggestStagingPathForGame(modPath, gamePath, userDataPath, "Vortex Mods"),
    ).resolves.toBe(path.join("{USERDATA}", "{game}", "mods"));
    expect(statAsync).toHaveBeenCalledWith("/home/user/.config");
  });

  it("uses the deployment mount when both the game and user data are on other filesystems", async () => {
    mockDevices({
      "/mnt/mods": 3,
      "/mnt": 1,
      [userDataPath]: 1,
      [path.dirname(gamePath)]: 2,
    });

    await expect(
      suggestStagingPathForGame(
        "/mnt/mods/Surviving Mars/mods",
        gamePath,
        userDataPath,
        "Vortex Mods",
      ),
    ).resolves.toBe(path.join("/mnt/mods", "Vortex Mods", "{game}", "mods"));
  });

  it("propagates errors other than missing directories", async () => {
    const error = Object.assign(new Error("Access denied"), { code: "EACCES" });
    statAsync.mockRejectedValue(error);

    await expect(
      suggestStagingPathForGame(modPath, gamePath, userDataPath, "Vortex Mods"),
    ).rejects.toBe(error);
  });
});
