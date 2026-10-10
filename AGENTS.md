# Instructions for coding agents in varis-cli

This repository holds the Varis CLI, the `varis` command developers use to
sign in, set up a project, and publish services that AI agents pay to call.
It is language-agnostic for its users: it reads and writes `varis.json`,
talks to the Varis API over HTTP, and runs each language's generator. It
never reads a developer's source code.

It is written in TypeScript and shipped as standalone binaries, so developers
never need Node.js to run it.

## Layout

```
varis-cli/
├── src/cli.ts            The entry point. The only file that touches the process.
├── src/commands/         One file per command: login, init, build, publish, test,
│                         logout, upgrade, dracarys.
├── src/lib/cli.ts        The command list, the help text, and the dispatcher.
├── src/lib/command.ts    The Command type every command implements.
├── src/lib/output.ts     Output: where commands write, so tests can capture it.
├── src/lib/style.ts      Colour, only on a terminal and never with NO_COLOR.
├── src/lib/constants.ts  The API origin, and its VARIS_API_URL override.
├── src/lib/credentials.ts  The credentials file: one device token per machine.
├── src/lib/api.ts        apiRequest: the one way to call the Varis API.
├── src/lib/issues.ts     Pre-filled GitHub issue links for bugs.
├── src/lib/device.ts     The machine's name, and whether a browser can open.
├── src/lib/prompt.ts     The arrow-key list and text prompt; Prompter for tests.
├── src/lib/manifest.ts   Reads and writes varis.json, keeping keys it doesn't own.
├── src/lib/base-url.ts   The publish rules for varis.json's base_url.
├── src/lib/agent-instructions.ts  The AGENTS.md block and CLAUDE.md import.
├── src/lib/generator.ts  Language markers, running a generator, reading its contract.
├── src/lib/test-signing.ts  varis test's throwaway signing key and loopback key
│                         listener. Must match the SDK's constants.
├── src/lib/query-string.ts  GET input as a query string, exactly as the gateway.
├── src/lib/schema.ts     JSON Schema validation, configured like the gateway.
├── src/lib/install-channel.ts  How this copy was installed: Homebrew, Scoop, script.
├── src/lib/release.ts    Finds, downloads, and checks a release, for varis upgrade.
├── src/lib/uninstall.ts  Undoes an install, for varis dracarys.
├── src/lib/version.ts    The version.
├── install.sh            Installer for macOS and Linux (POSIX sh, not bash).
├── install.ps1           Installer for Windows (Windows PowerShell 5.1).
├── scripts/smoke-test.sh  Checks one compiled binary runs without Node.js.
├── scripts/homebrew-formula.sh  Writes the Homebrew formula for a release.
├── scripts/scoop-manifest.sh    Writes the Scoop manifest for a release.
├── scripts/commit-package.sh   Commits a formula or manifest to its repository.
├── .github/workflows/check.yml  Type check and tests, on every pull request to main.
├── .github/workflows/build.yml  Compiles all five binaries and smoke-tests each.
├── .github/workflows/release.yml  On a version tag: builds, checksums, and releases.
├── .github/workflows/packages.yml  Updates Homebrew and Scoop to a release.
└── test/                 Vitest suites.
```

## Commands

- `npm run varis -- <args>`: runs the CLI from source with Node 24, for example
  `npm run varis -- --help`.
- `npm test`: runs the Vitest suite.
- `npm run typecheck`: type checks `src` and `test`.
- `npm run build`: compiles a standalone binary with Bun into `dist/`. The
  shipped binaries are built by `.github/workflows/build.yml`, not locally.

To run against a local `varis` app on port 3000:
`VARIS_API_URL=http://localhost:3000/api npm run varis -- login`.

To run `varis build` against a local generator instead of the npm package:
`VARIS_BUILD_COMMAND="node ~/dev/Projects/varis-ts/packages/build/dist/cli.js"`.

## Releasing

Merge to `main`, then tag the merged commit and push the tag:
`git tag v0.2.0 && git push origin v0.2.0`. `release.yml` checks the tag is a
version on `main`, runs `build.yml` with that version stamped into
`src/lib/version.ts`, and publishes the five binaries and `SHA256SUMS` as a
GitHub release. A tag like `v0.2.0-rc.1` makes a pre-release, which nothing
installs by default. Never bump `src/lib/version.ts` by hand, and never
rename the release assets: the installers download them by name. The
installers put `varis` in `~/.varis/bin`; `varis upgrade` and
`varis dracarys` recognise an install-script copy by that folder.

## Rules

### Runtime

- Use only Node's standard modules (`node:fs`, `node:path`, `node:os`,
  `node:child_process`, `node:crypto`) and the global `fetch`. Never use
  Bun-specific APIs such as `Bun.file` or `Bun.spawn`. Bun compiles the
  binaries, and this rule is what keeps the source portable to another
  compiler.
- End relative imports in `.ts`. Node runs the source directly, and so does
  Bun.
- Use only TypeScript that erases to JavaScript: no `enum`, no `namespace`,
  no parameter properties. `erasableSyntaxOnly` enforces it.
- Add no runtime dependencies without a strong reason. Every one ships inside
  the binary.
  The only ones are `ajv` and `ajv-formats`, so `varis test` validates
  exactly as the gateway does.

### Commands

- The CLI has exactly eight commands: `login`, `init`, `build`, `publish`,
  `test`, `logout`, `upgrade`, and `dracarys`. Any new command needs a scope
  decision first.
- `dracarys` deletes things. It acts on the current project only, never
  scanning the disk, and only after a typed confirmation or `--yes`.
- A command's `run` returns its exit code and never calls `process.exit`:
  0 for success, 1 for a failure the developer can fix, 2 for a crash or a
  usage mistake.
- Write through `Output`, never `console` or `process.stdout`. Results go to
  `out`; errors go to `err`; progress that the next update replaces, such as
  a polling message, goes to `status`.
- Colour through `src/lib/style.ts` only: `success` (green tick) for a
  finished command, `failure` (red cross) for a failed one. It is plain text
  whenever the output isn't a terminal or `NO_COLOR` is set.
- Messages are plain sentences that say what to do next, for example "Run
  varis login."
- Ask questions through a `Prompter`, and only when `prompter.interactive`
  is true. Without a terminal, use the command's flags or fail with a
  message naming the flag; never wait for input that can't arrive.
- Check everything, and ask every question, before writing anything. A
  cancelled prompt or a bad flag leaves the project as it was.
- When a failure is our bug rather than the developer's, print
  `reportLines()` from `src/lib/issues.ts`: a pre-filled GitHub issue link
  and the reporting guide. Never ask developers to "contact us".
- The repository URL lives only in `src/lib/constants.ts`.
- `varis test` calls only the developer's own server, at `test_base_url`,
  never the Varis API or a production address. Its signing mechanism is
  explained in `src/lib/test-signing.ts`; change it only together with
  `verify.ts` in the `varis-ts` SDK.

### The API

- The API hostname lives only in `src/lib/constants.ts`. Call the API only
  through `apiRequest` in `src/lib/api.ts`, which builds URLs with
  `apiOrigin()`, attaches the token and owner, and turns every failure into an
  `ApiError` with a message ready to print.
- The API contract is `openapi.yaml` in the `usevaris/docs` repository.
- Send the user token as `Authorization: Bearer` and the owner as
  `X-Varis-Owner-Identifier`. Never read `owner_id` or a user ID from anywhere
  but the credentials file and `varis.json`.
- `varis.json` never holds a token. Tokens live in the user's config
  directory: `~/.config/varis/credentials.toml`, or
  `%APPDATA%\varis\credentials.toml` on Windows.

### Code style

- Name identifiers in British English, except where a convention or spec
  fixes the spelling, such as the `Authorization` header.
- Name functions after what they do.
