import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BuildDeps, runBuild } from "../src/commands/build.ts";
import {
  detectLanguage,
  generatorCommand,
  LANGUAGES,
  readOutcome,
  type RunResult,
} from "../src/lib/generator.ts";
import type { Output } from "../src/lib/output.ts";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "varis-cli-build-"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

async function typescriptProject() {
  await writeFile(path.join(project, "package.json"), "{}");
  await writeFile(
    path.join(project, "varis.json"),
    JSON.stringify({ owner_id: "var_ownr_x", services: [] }),
  );
}

function setup(result: RunResult, env: Record<string, string> = {}) {
  const ran: { command: string[]; cwd: string }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const statuses: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: (t) => statuses.push(t),
    styled: false,
  };
  const deps: BuildDeps = {
    cwd: project,
    env,
    run: async (command, cwd) => {
      ran.push({ command, cwd });
      return result;
    },
  };
  return { deps, output, out, err, statuses, ran };
}

const ran = (code: number, stdout = "", stderr = ""): RunResult => ({
  status: "ran",
  code,
  stdout,
  stderr,
});

describe("varis build", () => {
  it("exit 0: reports the services built, and the generator's warnings", async () => {
    await typescriptProject();
    const t = setup(
      ran(
        0,
        `${
          JSON.stringify({
            services: ["news", "weather"],
            warnings: ["Move @usevaris/build to devDependencies."],
          })
        }\n`,
      ),
    );

    expect(await runBuild([], t.output, t.deps)).toBe(0);

    expect(t.ran[0]).toEqual({
      command: ["npx", "--yes", "@usevaris/build@1"],
      cwd: project,
    });
    expect(t.out).toEqual([
      "✓ Built varis.json: 2 services.",
      "  news",
      "  weather",
    ]);
    expect(t.err).toEqual([
      "Warning: Move @usevaris/build to devDependencies.",
    ]);
  });

  it("exit 1: lists every problem with its file and line, ignoring npx's own lines", async () => {
    await typescriptProject();
    const stderr = [
      "npm warn exec The following package was not found and will be installed: @usevaris/build@1.0.0",
      JSON.stringify({
        file: "src/weather.ts",
        line: 12,
        message: 'The value of "endpoint_url" must be a literal.',
      }),
      JSON.stringify({
        file: "varis.json",
        line: 0,
        message: "base_url must use https.",
      }),
    ].join("\n");
    const t = setup(ran(1, "", stderr));

    expect(await runBuild([], t.output, t.deps)).toBe(1);

    const printed = t.err.join("\n");
    expect(printed).toContain("2 problems to fix. varis.json wasn't changed.");
    expect(printed).toContain("src/weather.ts:12");
    expect(printed).toContain('The value of "endpoint_url" must be a literal.');
    expect(printed).toContain("  varis.json\n");
    expect(printed).not.toContain("npm warn");
  });

  it("exit 2: says the generator crashed, shows why, and where to report it", async () => {
    await typescriptProject();
    const t = setup(
      ran(
        2,
        "",
        JSON.stringify({
          file: "",
          line: 0,
          message: "TypeError: boom\n    at build.js:1",
        }),
      ),
    );

    expect(await runBuild([], t.output, t.deps)).toBe(1);

    const printed = t.err.join("\n");
    expect(printed).toContain(
      "The Varis generator crashed. This is a bug in Varis, not your code.",
    );
    expect(printed).toContain("TypeError: boom");
    expect(printed).toContain("github.com/usevaris/varis-ts/issues/new");
  });

  it("an unrecognised project: names the markers it looks for, running nothing", async () => {
    await writeFile(
      path.join(project, "varis.json"),
      JSON.stringify({ owner_id: "var_ownr_x" }),
    );
    await writeFile(path.join(project, "pyproject.toml"), "");
    const t = setup(ran(0));

    expect(await runBuild([], t.output, t.deps)).toBe(1);

    const printed = t.err.join("\n");
    expect(printed).toContain("doesn't recognise this project's language");
    expect(printed).toContain("package.json");
    expect(printed).toContain("write the services in varis.json by hand");
    expect(t.ran).toEqual([]);
  });

  it("needs varis.json first", async () => {
    await writeFile(path.join(project, "package.json"), "{}");
    const t = setup(ran(0));
    expect(await runBuild([], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("Run varis init first.");
    expect(t.ran).toEqual([]);
  });

  it("says Node.js is needed when npx isn't installed", async () => {
    await typescriptProject();
    const t = setup({ status: "missing", program: "npx" });
    expect(await runBuild([], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("Install Node.js");
  });

  it("reports a failure the contract doesn't explain, such as a failed download", async () => {
    await typescriptProject();
    const t = setup(
      ran(1, "", "npm error code ENOTFOUND\nnpm error network request failed"),
    );
    expect(await runBuild([], t.output, t.deps)).toBe(1);
    const printed = t.err.join("\n");
    expect(printed).toContain("failed without saying why (exit 1)");
    expect(printed).toContain("ENOTFOUND");
  });

  it("runs VARIS_BUILD_COMMAND instead, for a local generator", async () => {
    await typescriptProject();
    const t = setup(ran(0, JSON.stringify({ services: [], warnings: [] })), {
      VARIS_BUILD_COMMAND: "node /dev/varis-ts/packages/build/dist/cli.js",
    });
    await runBuild([], t.output, t.deps);
    expect(t.ran[0]!.command).toEqual([
      "node",
      "/dev/varis-ts/packages/build/dist/cli.js",
    ]);
    expect(t.out[0]).toBe("✓ Built varis.json: no services defined yet.");
  });
});

describe("the generator contract", () => {
  it("reads a successful run from the last stdout line", () => {
    expect(readOutcome(0, 'noise\n{"services":["a"],"warnings":[]}\n', ""))
      .toEqual({
        kind: "built",
        services: ["a"],
        warnings: [],
      });
  });

  it("treats exit 0 without the JSON line as unexpected", () => {
    expect(readOutcome(0, "hello", "").kind).toBe("unexpected");
  });

  it("detects TypeScript from package.json", async () => {
    await writeFile(path.join(project, "package.json"), "{}");
    expect(await detectLanguage(project)).toBe(LANGUAGES[0]);
    expect(generatorCommand(LANGUAGES[0]!, {})).toEqual([
      "npx",
      "--yes",
      "@usevaris/build@1",
    ]);
  });
});
