import { describe, expect, it, vi } from "vitest";
import { publish } from "../src/commands/publish.ts";
import { COMMANDS, helpText, runCli } from "../src/lib/cli.ts";
import { apiOrigin, VARIS_API_ORIGIN } from "../src/lib/constants.ts";
import type { Output } from "../src/lib/output.ts";
import { VERSION } from "../src/lib/version.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: (t) => err.push(t),
    styled: false,
  };
  return { output, out, err };
}

describe("varis", () => {
  it("lists exactly the eight commands, in order", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "login",
      "init",
      "build",
      "publish",
      "test",
      "logout",
      "upgrade",
      "dracarys",
    ]);
  });

  it("prints help for --help, -h, and no arguments, exiting 0", async () => {
    for (const argv of [["--help"], ["-h"], []]) {
      const { output, out } = capture();
      expect(await runCli(argv, output)).toBe(0);
      expect(out.join("\n")).toBe(helpText());
    }
  });

  it("names every command with its summary in the help", () => {
    const help = helpText();
    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.summary);
    }
  });

  it("prints the version", async () => {
    const { output, out } = capture();
    expect(await runCli(["--version"], output)).toBe(0);
    expect(out).toEqual([VERSION]);
  });

  it("prints a command's own help", async () => {
    const { output, out } = capture();
    expect(await runCli(["publish", "--help"], output)).toBe(0);
    expect(out.join("\n")).toContain("Usage: varis publish");
  });

  it("rejects an unknown command on stderr, exiting 2", async () => {
    const { output, out, err } = capture();
    expect(await runCli(["invoke"], output)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Unknown command: invoke");
  });
});

describe("a command that crashes", () => {
  it("says it's a bug and gives a pre-filled GitHub issue link, exiting 2", async () => {
    const spy = vi.spyOn(publish, "run").mockRejectedValue(new Error("boom"));
    const { output, err } = capture();

    expect(await runCli(["publish", "weather"], output)).toBe(2);

    const printed = err.join("\n");
    expect(printed).toContain("varis publish crashed: boom");
    expect(printed).toContain("issues/new?");
    expect(printed).toContain("command=varis+publish+weather");
    expect(printed).toContain("reporting-issues.md");
    spy.mockRestore();
  });
});

describe("apiOrigin", () => {
  it("defaults to the Varis API", () => {
    expect(apiOrigin({})).toBe(VARIS_API_ORIGIN);
    expect(VARIS_API_ORIGIN).toBe("https://api.usevaris.com");
  });

  it("takes VARIS_API_URL for local development, dropping a trailing slash", () => {
    expect(apiOrigin({ VARIS_API_URL: "http://localhost:3000/api/" })).toBe(
      "http://localhost:3000/api",
    );
  });

  it("ignores a blank override", () => {
    expect(apiOrigin({ VARIS_API_URL: "  " })).toBe(VARIS_API_ORIGIN);
  });
});
