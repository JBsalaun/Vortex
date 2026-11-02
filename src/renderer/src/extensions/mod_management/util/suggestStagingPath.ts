import * as path from "path";

import * as winapi from "winapi-bindings";

import * as fs from "../../../util/fs";

export async function suggestStagingPathForGame(
  modPath: string,
  gamePath: string,
  userDataPath: string,
  suggestInstallPathDirectory: string,
): Promise<string> {
  const identifyModPath = async (testPath: string): Promise<fs.Stats> => {
    try {
      return await fs.statAsync(testPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      const parentPath = path.dirname(testPath);
      if (parentPath === testPath) {
        throw err;
      }
      return identifyModPath(parentPath);
    }
  };

  const statModPath = await identifyModPath(modPath);
  if (process.platform !== "win32") {
    const gameParent = path.dirname(gamePath);
    if ((await identifyModPath(gameParent)).dev === statModPath.dev) {
      return path.join(gameParent, suggestInstallPathDirectory, "{game}", "mods");
    }
  }

  const statUserData = await fs.statAsync(userDataPath);
  if (statModPath.dev === statUserData.dev) {
    return path.join("{USERDATA}", "{game}", "mods");
  }

  let volume: string;
  if (process.platform === "win32") {
    volume = winapi.GetVolumePathName(modPath);
  } else {
    volume = modPath;
    while (path.dirname(volume) !== volume) {
      const parentPath = path.dirname(volume);
      if ((await identifyModPath(parentPath)).dev !== statModPath.dev) {
        break;
      }
      volume = parentPath;
    }
    return path.join(volume, suggestInstallPathDirectory, "{game}", "mods");
  }
  return path.join(volume, suggestInstallPathDirectory, "{game}");
}
