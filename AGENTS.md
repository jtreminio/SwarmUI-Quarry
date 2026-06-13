# Git repo

This extension lives in a subdirectory that is gitignored by the SwarmUI project; it has its own git repo. Do not look in the SwarmUI project for git changes related to this extension, and never create commits here (the maintainer commits everything himself).

# Javascript files

Do NOT manually modify `Assets/quarry.js` — it is the esbuild output. All JavaScript changes go in the TypeScript sources under `frontend/` (or `scripts/`). It is OK to edit the CSS file(s) directly.

# Run Tests

You are explicitly required to run the unit tests for this extension whenever your changes affect this extension's code or tests.

## Where `run-tests` is (working directory matters)

The `run-tests` script lives in **this extension's root directory**: the folder that contains `SwarmUI-QuarryExtension.csproj`, `SwarmUI-QuarryExtension.Tests.sln`, and `run-tests`. It is **not** at the main SwarmUI repository root and not inside `src/`, `Tests/`, or `frontend/`.

Before running it:

1. **Confirm cwd**: your shell (or tool `working_directory`) must be that extension root, **or**
2. **Call it by path from the SwarmUI repo root**:

   `./src/Extensions/SwarmUI-QuarryExtension/run-tests`

`run-tests` runs the backend xUnit suite (`dotnet test SwarmUI-QuarryExtension.Tests.sln`) and then the Jest frontend suite (`npm run test`). The backend tests build SwarmUI as a project reference; that is expected — do not separately rebuild or run the core SwarmUI app.

# Build

`npm run build` lints, type-checks, and bundles `frontend/main.ts` to `Assets/quarry.js` via esbuild. Run `npm install` once first.

# Rules override

If `AGENTS.dev.md` exists beside this file, it takes precedence over this one for overlapping instructions. That file is gitignored — check the filesystem manually.
