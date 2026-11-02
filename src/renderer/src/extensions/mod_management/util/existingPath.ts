import * as path from "path";

import { getErrorCode } from "@vortex/shared";

import * as fs from "../../../util/fs";

export function existingPathSync(filePath: string): string {
  let currentPath = filePath;
  while (true) {
    try {
      fs.statSync(currentPath);
      return currentPath;
    } catch (err) {
      if (getErrorCode(err) !== "ENOENT") {
        throw err;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw err;
      }
      currentPath = parentPath;
    }
  }
}
