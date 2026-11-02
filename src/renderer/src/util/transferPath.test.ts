import * as path from "path";

import { describe, it, expect, vi, beforeEach } from "vitest";

interface WalkEntry {
  name: string;
  filePath?: string;
  isDirectory: boolean;
  size: number;
}

type WalkCallback = (err: Error | null, files: WalkEntry[]) => void;

type PathHandler = (cb: WalkCallback) => void;

const walkHandlers: Record<string, PathHandler> = {};

vi.mock("turbowalk", () => ({
  __esModule: true,
  default: (walkPath: string, cb: (files: WalkEntry[]) => void) =>
    new Promise<void>((resolve, reject) => {
      if (walkHandlers[walkPath] !== undefined) {
        walkHandlers[walkPath]((err, files) => {
          if (err !== null) {
            reject(err);
          } else {
            cb(files);
            resolve();
          }
        });
      } else {
        cb([]);
        resolve();
      }
    }),
}));

const diskCheckResults: Record<string, { free: number }> = {
  "": { free: 42 },
};

vi.mock("fs", () => ({
  statfsSync: (checkPath: string) => {
    const result = diskCheckResults[checkPath] ?? diskCheckResults[""];
    return { bavail: result.free, bsize: 1 };
  },
}));

vi.mock("winapi-bindings", () => ({
  GetVolumePathName: vi.fn((input: string) => {
    const res = path.dirname(input);
    if (res === "/missing") {
      throw Object.assign(new Error("fake error"), {
        code: "ENOTFOUND",
        systemCode: 2,
      });
    }
    return res;
  }),
  ShellExecuteEx: () => {},
  RegGetValue: () => ({ type: "REG_SZ", value: "foobar" }),
}));

type FakeInfo = Record<string, unknown>;
let fakeFS: Record<string, unknown> = {};

function insertFake(filePath: string, info: FakeInfo): void {
  const parts = filePath.split(path.sep);
  let tgt: Record<string, unknown> = fakeFS;
  for (let i = 0; i < parts.length - 1; i++) {
    if (tgt[parts[i]] === undefined) tgt[parts[i]] = {};
    tgt = tgt[parts[i]] as Record<string, unknown>;
  }
  tgt[parts[parts.length - 1]] = info;
}

function getFake(filePath: string): FakeInfo {
  const parts = filePath.split(path.sep);
  let tgt: Record<string, unknown> = fakeFS;
  for (let i = 0; i < parts.length - 1; i++) {
    if (tgt[parts[i]] === undefined) {
      throw Object.assign(new Error("file not found"), { code: "ENOENT" });
    }
    tgt = tgt[parts[i]] as Record<string, unknown>;
  }
  return tgt[parts[parts.length - 1]] as FakeInfo;
}

function delFake(filePath: string): void {
  const parts = filePath.split(path.sep);
  let tgt: Record<string, unknown> = fakeFS;
  for (let i = 0; i < parts.length - 1; i++) {
    if (tgt[parts[i]] === undefined) {
      throw Object.assign(new Error("file not found"), { code: "ENOENT" });
    }
    tgt = tgt[parts[i]] as Record<string, unknown>;
  }
  delete tgt[parts[parts.length - 1]];
}

vi.mock("./fs", async () => {
  const Bluebird = (await import("bluebird")).default;

  return {
    statAsync: (filePath: string) => {
      const dev = filePath.startsWith(path.sep + "drivea") ? 1 : 2;
      return Bluebird.resolve({
        dev,
        ino: Math.floor(Math.random() * 1000000),
        isDirectory: filePath.indexOf(".") === -1,
        isFile: filePath.indexOf(".") !== -1,
        size: 0,
      });
    },
    ensureDirWritableAsync: vi.fn((dirPath: string) => {
      insertFake(dirPath, {});
      return Bluebird.resolve(undefined);
    }),
    mkdirsAsync: vi.fn((dirPath: string) => {
      insertFake(dirPath, {});
      return Bluebird.resolve(undefined);
    }),
    copyAsync: vi.fn((source: string, dest: string) => {
      const info = getFake(source);
      if (info.fail !== undefined) {
        return Bluebird.reject(info.fail);
      }
      insertFake(dest, { ...info, type: "copied" });
      return Bluebird.resolve(undefined);
    }),
    renameAsync: vi.fn((source: string, dest: string) => {
      const info = getFake(source);
      if (info.renameFail !== undefined) {
        return Bluebird.reject(info.renameFail);
      }
      insertFake(dest, info);
      delFake(source);
      return Bluebird.resolve(undefined);
    }),
    linkAsync: vi.fn((source: string, dest: string) => {
      const info = getFake(source);
      if (info.linkFail !== undefined) {
        return Bluebird.reject(info.linkFail);
      }
      insertFake(dest, { ...info, type: "linked" });
      return Bluebird.resolve(undefined);
    }),
    rmdirAsync: vi.fn((dirPath: string) => {
      const info = getFake(dirPath);
      if (Object.keys(info).length > 0) {
        return Bluebird.reject(
          Object.assign(new Error("not empty"), {
            path: dirPath,
            code: "ENOTEMPTY",
          }),
        );
      }
      delFake(dirPath);
      return Bluebird.resolve(undefined);
    }),
    removeAsync: vi.fn((filePath: string) => {
      delFake(filePath);
      return Bluebird.resolve(undefined);
    }),
    ensureDirAsync: vi.fn((dirPath: string) => {
      insertFake(dirPath, {});
      return Bluebird.resolve(undefined);
    }),
    readdirAsync: () => Bluebird.resolve([]),
  };
});

import { moveFile, testPathTransfer, transferPath } from "./transferPath";

const MB = 1024 * 1024;

const baseA = path.sep + "drivea";
const baseB = path.sep + "driveb";

const describeOnWindows = process.platform === "win32" ? describe : describe.skip;
const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

describeOnWindows("testPathTransfer", () => {
  beforeEach(() => {
    walkHandlers[path.join(baseA, "source")] = (cb) => {
      cb(null, [
        { name: "dummyfile1.dat", isDirectory: false, size: 500 * MB },
        { name: "dummyfile2.dat", isDirectory: false, size: 500 * MB },
      ]);
    };
  });
  it("reports success if there is enough space", async () => {
    diskCheckResults[baseB] = { free: 2000 * MB };
    await expect(
      testPathTransfer(path.join(baseA, "source"), path.join(baseB, "destination")),
    ).resolves.toBeUndefined();
  });
  it("reports success if on same drive, independent of free size", async () => {
    diskCheckResults[baseA] = { free: 1 * MB };
    await expect(
      testPathTransfer(path.join(baseA, "source"), path.join(baseA, "destination")),
    ).resolves.toBeUndefined();
  });
  it("fails if there is less than 512 MB free", async () => {
    diskCheckResults[baseB] = { free: 256 * MB };
    await expect(
      testPathTransfer(path.join(baseA, "source"), path.join(baseB, "destination")),
    ).rejects.toThrow(`The partition "${path.sep}driveb" has insufficient space.`);
  });
});

describeOnLinux("testPathTransfer on Linux", () => {
  it("does not call the Windows volume API", async () => {
    const winapi = await import("winapi-bindings");
    await expect(
      testPathTransfer(path.join(baseA, "source"), path.join(baseA, "destination")),
    ).resolves.toBeUndefined();
    expect(winapi.GetVolumePathName).not.toHaveBeenCalled();
  });
});

const dummyA = path.join(baseA, "source", "dummyfile1.dat");
const dummyB = path.join(baseA, "source", "dummyfile2.dat");

describe("transferPath", () => {
  beforeEach(() => {
    fakeFS = {};
    insertFake(dummyA, { name: "dummyA" });
    insertFake(dummyB, { name: "dummyB" });
    walkHandlers[path.join(baseA, "source")] = (cb) => {
      cb(null, [
        {
          name: "dummyfile1.dat",
          filePath: dummyA,
          isDirectory: false,
          size: 500 * MB,
        },
        {
          name: "dummyfile2.dat",
          filePath: dummyB,
          isDirectory: false,
          size: 500 * MB,
        },
      ]);
    };
  });

  it("transfers all files with copy between drives", async () => {
    await expect(
      transferPath(path.join(baseA, "source"), path.join(baseB, "destination"), () => undefined),
    ).resolves.toBeUndefined();
    expect(fakeFS).toEqual({
      "": {
        drivea: {},
        driveb: {
          destination: {
            "dummyfile1.dat": { name: "dummyA", type: "copied" },
            "dummyfile2.dat": { name: "dummyB", type: "copied" },
          },
        },
      },
    });
  });
  it("transfers all files with link on the same drive", async () => {
    await expect(
      transferPath(path.join(baseA, "source"), path.join(baseA, "destination"), () => undefined),
    ).resolves.toBeUndefined();
    expect(fakeFS).toEqual({
      "": {
        drivea: {
          destination: {
            "dummyfile1.dat": { name: "dummyA", type: "linked" },
            "dummyfile2.dat": { name: "dummyB", type: "linked" },
          },
        },
      },
    });
  });
  it("falls back to copying when a link unexpectedly returns EXDEV", async () => {
    insertFake(dummyA, {
      linkFail: Object.assign(new Error("cross-device link"), { code: "EXDEV" }),
      name: "dummyA",
    });

    await expect(
      transferPath(path.join(baseA, "source"), path.join(baseA, "destination"), () => undefined),
    ).resolves.toBeUndefined();

    expect(getFake(path.join(baseA, "destination", "dummyfile1.dat"))).toMatchObject({
      name: "dummyA",
      type: "copied",
    });
    expect(getFake(path.join(baseA, "source"))).toBeUndefined();
  });
  it("creates required directories", async () => {
    const filePath = path.join(baseA, "source", "subdir", "dummyfile1.dat");
    walkHandlers[path.join(baseA, "source")] = (cb) => {
      cb(null, [
        {
          name: "subdir",
          filePath: path.join(baseA, "source", "subdir"),
          isDirectory: true,
          size: 0,
        },
        {
          name: "dummyfile1.dat",
          filePath,
          isDirectory: false,
          size: 500 * MB,
        },
      ]);
    };
    fakeFS = {};
    insertFake(filePath, { name: "dummyA" });
    await transferPath(
      path.join(baseA, "source"),
      path.join(baseB, "destination"),
      () => undefined,
    );
    expect(fakeFS).toEqual({
      "": {
        drivea: {},
        driveb: {
          destination: {
            subdir: {
              "dummyfile1.dat": { name: "dummyA", type: "copied" },
            },
          },
        },
      },
    });
  });
});

describe("moveFile", () => {
  beforeEach(() => {
    fakeFS = {};
  });

  it("copies on EXDEV and removes the source only after verification", async () => {
    const source = path.join(baseA, "source.pak");
    const destination = path.join(baseB, "destination.pak");
    insertFake(source, {
      name: "mod",
      renameFail: Object.assign(new Error("cross-device move"), { code: "EXDEV" }),
      size: 42,
    });

    await expect(moveFile(source, destination)).resolves.toBeUndefined();
    expect(getFake(source)).toBeUndefined();
    expect(getFake(destination)).toMatchObject({ name: "mod", type: "copied" });
  });

  it("keeps the source when the fallback copy fails", async () => {
    const source = path.join(baseA, "source.utoc");
    const destination = path.join(baseB, "destination.utoc");
    insertFake(source, {
      fail: new Error("copy failed"),
      renameFail: Object.assign(new Error("cross-device move"), { code: "EXDEV" }),
      size: 42,
    });

    await expect(moveFile(source, destination)).rejects.toThrow("copy failed");
    expect(getFake(source)).toMatchObject({ size: 42 });
  });
});
