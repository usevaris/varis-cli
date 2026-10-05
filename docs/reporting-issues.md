# Report a problem with the Varis CLI

A report that lets us reproduce the problem gets fixed first. This page explains
what to include.

## Before you report

1. Update to the latest version, and check the problem still happens.
2. Search [existing issues](https://github.com/usevaris/varis-cli/issues)
   for the same error. If you find one, add your details to it rather than
   opening a new one.
3. If the CLI printed a report link, use it. It opens the bug report with your
   CLI version, operating system, command, error, and request ID filled in.

## What to include

The bug report form asks for each of these:

- **The CLI version.** Run `varis --version`.
- **Your operating system and architecture**, for example `darwin arm64`.
- **How you installed the CLI:** Homebrew, Scoop, the install script, a
  download, or from source.
- **The exact command you ran**, with its arguments.
- **Everything the CLI printed.** Copy the whole output, not a summary.
- **The request ID**, if the error included one. It starts with `var_req_` and
  lets us find the request in our logs.
- **What you expected** to happen.
- **Steps to reproduce**: the smallest set of steps that shows the problem,
  starting from a clean project if you can.

If the problem is with `varis build` or `varis publish`, include your project's
language and framework, and your `varis.json` with the `owner_id` removed.

## Never include

- Your device token.
- The contents of `credentials.toml`, found in your machine's `/configs`.
  directory.
- Agent keys, or any other secret from your project.

If you pasted a token by mistake, sign that machine out from the Varis
dashboard, under **Settings > Devices**, and edit the issue to remove it.

## Security problems

If you found a security vulnerability, don't open a public issue. Email the
details to [security@usevaris.com](mailto:security@usevaris.com) instead, so we can
fix it before it's known.
