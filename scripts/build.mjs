import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

await build({
    absWorkingDir: projectRoot,
    entryPoints: [path.join(projectRoot, "frontend", "main.ts")],
    outfile: path.join(projectRoot, "Assets", "quarry.js"),
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: false,
    sourcemap: true,
    charset: "utf8",
    legalComments: "none",
});
