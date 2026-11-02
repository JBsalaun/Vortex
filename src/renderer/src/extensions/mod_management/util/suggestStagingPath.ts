import * as path from "path";

import * as winapi from "winapi-bindings";

import * as fs from "../../../util/fs";

export async function suggestStagingPathForGame(
  modPath: string,
  gamePath: string,
  userDataPath: string,
  suggestInstallPathDirectory: string,
): Promise<string> {
  if (process.platform !== "win32") {
    return path.join(path.dirname(gamePath), suggestInstallPathDirectory, "{game}", "mods");
  }

  let statModPath: fs.Stats;
  const identifyModPath = async (testPath: string): Promise<void> => {
    try {
      statModPath = await fs.statAsync(testPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      const parentPath = path.dirname(testPath);
      if (parentPath === testPath) {
        throw err;
      }
      await identifyModPath(parentPath);
    }
  };

  await identifyModPath(modPath);
  const statUserData = await fs.statAsync(userDataPath);
  if (statModPath.dev === statUserData.dev) {
    return path.join("{USERDATA}", "{game}", "mods");
  }

  const volume = winapi.GetVolumePathName(modPath);
  return path.join(volume, suggestInstallPathDirectory, "{game}");
}
