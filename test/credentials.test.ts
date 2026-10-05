import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CredentialsLocation,
  credentialsPath,
  deleteToken,
  parseCredentials,
  readCredentials,
  readToken,
  saveToken,
  serialiseCredentials,
} from "../src/lib/credentials.ts";

const PROD = "https://api.usevaris.com";
const LOCAL = "http://localhost:3000/api";
const TOKEN_A = `var_dt_${"a".repeat(40)}`;
const TOKEN_B = `var_dt_${"b".repeat(40)}`;

let home: string;
let location: CredentialsLocation;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "varis-cli-home-"));
  location = { env: {}, platform: process.platform, home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const modeOf = async (file: string) => (await stat(file)).mode & 0o777;

describe("credentialsPath", () => {
  it("uses ~/.config/varis on macOS and Linux", () => {
    expect(credentialsPath({ env: {}, platform: "darwin", home: "/Users/ada" }))
      .toBe("/Users/ada/.config/varis/credentials.toml");
    expect(credentialsPath({ env: {}, platform: "linux", home: "/home/ada" }))
      .toBe("/home/ada/.config/varis/credentials.toml");
  });

  it("honours an absolute XDG_CONFIG_HOME, and ignores a relative one", () => {
    expect(
      credentialsPath({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", home: "/home/ada" }),
    ).toBe("/xdg/varis/credentials.toml");
    expect(
      credentialsPath({ env: { XDG_CONFIG_HOME: "rel" }, platform: "linux", home: "/home/ada" }),
    ).toBe("/home/ada/.config/varis/credentials.toml");
  });

  it("uses %APPDATA%\\varis on Windows", () => {
    expect(
      credentialsPath({
        env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
        platform: "win32",
        home: "C:\\Users\\Ada",
      }),
    ).toBe("C:\\Users\\Ada\\AppData\\Roaming\\varis\\credentials.toml");
  });
});

describe("a missing file", () => {
  it("reads as signed out", async () => {
    expect(await readToken(PROD, location)).toEqual({ status: "signed_out" });
    expect(await readCredentials(location)).toEqual({ status: "signed_out" });
  });

  it("is created, folder and all, on save", async () => {
    await saveToken(PROD, TOKEN_A, location);
    expect(await readToken(PROD, location)).toEqual({
      status: "signed_in",
      token: TOKEN_A,
    });
  });
});

describe("one token per machine", () => {
  it("records which server issued the token", async () => {
    await saveToken(PROD, TOKEN_A, location);
    expect(await readCredentials(location)).toEqual({
      status: "signed_in",
      credentials: { token: TOKEN_A, api: PROD },
    });
  });

  it("replaces the token on a new sign-in", async () => {
    await saveToken(PROD, TOKEN_A, location);
    await saveToken(PROD, TOKEN_B, location);
    expect(await readToken(PROD, location)).toEqual({
      status: "signed_in",
      token: TOKEN_B,
    });
  });

  it("replaces a token from another server on a new sign-in", async () => {
    await saveToken(LOCAL, TOKEN_A, location);
    await saveToken(PROD, TOKEN_B, location);
    expect(await readCredentials(location)).toMatchObject({
      credentials: { token: TOKEN_B, api: PROD },
    });
  });

  it("never offers a token to a server that didn't issue it", async () => {
    await saveToken(LOCAL, TOKEN_A, location);
    expect(await readToken(PROD, location)).toEqual({
      status: "signed_in_elsewhere",
      api: LOCAL,
    });
  });

  it("deletes the file on sign-out", async () => {
    await saveToken(PROD, TOKEN_A, location);
    expect(await deleteToken(location)).toBe(true);
    await expect(stat(credentialsPath(location))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readToken(PROD, location)).toEqual({ status: "signed_out" });
  });

  it("reports nothing removed when already signed out", async () => {
    expect(await deleteToken(location)).toBe(false);
  });

  it("refuses to save something that isn't a device token", async () => {
    await expect(saveToken(PROD, "var_ak_nope", location)).rejects.toThrow();
  });
});

describe("a corrupt file", () => {
  async function writeRaw(text: string) {
    const file = credentialsPath(location);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { mode: 0o600 });
  }

  it("reads as corrupt with the path and a reason, rather than throwing", async () => {
    await writeRaw("this is not toml at all");
    const result = await readToken(PROD, location);
    expect(result).toMatchObject({
      status: "corrupt",
      path: credentialsPath(location),
    });
    expect((result as { reason: string }).reason).toContain("line 1");
  });

  it("rejects a token that isn't a device token", async () => {
    await writeRaw(`token = "var_ak_${"a".repeat(40)}"\napi = "${PROD}"\n`);
    expect(await readToken(PROD, location)).toMatchObject({ status: "corrupt" });
  });

  it("rejects a missing field, a repeated field, and anything else", () => {
    expect(parseCredentials(`token = "${TOKEN_A}"`).ok).toBe(false);
    expect(parseCredentials(`api = "${PROD}"`).ok).toBe(false);
    expect(
      parseCredentials(`token = "${TOKEN_A}"\ntoken = "${TOKEN_B}"\napi = "${PROD}"`).ok,
    ).toBe(false);
    expect(parseCredentials(`["${PROD}"]\ntoken = "${TOKEN_A}"`).ok).toBe(false);
  });

  it("is replaced by a new sign-in", async () => {
    await writeRaw("garbage");
    await saveToken(PROD, TOKEN_A, location);
    expect(await readToken(PROD, location)).toMatchObject({ token: TOKEN_A });
  });
});

describe("the format", () => {
  it("round-trips, with comments ignored and fields in either order", () => {
    const parsed = parseCredentials(
      serialiseCredentials({ token: TOKEN_A, api: PROD }),
    );
    expect(parsed).toEqual({ ok: true, credentials: { token: TOKEN_A, api: PROD } });
    expect(
      parseCredentials(`# note\napi = "${PROD}"\n\ntoken = "${TOKEN_A}"\n`),
    ).toEqual({ ok: true, credentials: { token: TOKEN_A, api: PROD } });
  });

  it("accepts Windows line endings", () => {
    const parsed = parseCredentials(`token = "${TOKEN_A}"\r\napi = "${PROD}"\r\n`);
    expect(parsed.ok).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("file permissions", () => {
  it("creates the file readable only by its owner, in a private folder", async () => {
    await saveToken(PROD, TOKEN_A, location);
    const file = credentialsPath(location);
    expect(await modeOf(file)).toBe(0o600);
    expect(await modeOf(path.dirname(file))).toBe(0o700);
  });

  it("tightens a file others can read, on read", async () => {
    await saveToken(PROD, TOKEN_A, location);
    const file = credentialsPath(location);
    await chmod(file, 0o644);

    await readToken(PROD, location);
    expect(await modeOf(file)).toBe(0o600);
  });

  it("keeps 0600 after rewriting", async () => {
    await saveToken(PROD, TOKEN_A, location);
    await saveToken(PROD, TOKEN_B, location);
    expect(await modeOf(credentialsPath(location))).toBe(0o600);
  });

  it("leaves no temporary file behind", async () => {
    await saveToken(PROD, TOKEN_A, location);
    const entries = await readFile(credentialsPath(location), "utf8");
    expect(entries).toContain(TOKEN_A);
    expect(await readdir(path.dirname(credentialsPath(location)))).toEqual([
      "credentials.toml",
    ]);
  });
});
