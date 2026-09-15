import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = process.env.OBSIDIAN_EXCALIDRAW_SOURCE ??
  "/tmp/yaos-obsidian-excalidraw-source";

const read = (path) => readFileSync(join(sourceRoot, path), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const packageJson = JSON.parse(read("package.json"));
const root = read("src/view/components/ExcalidrawRoot.ts");
const view = read("src/view/ExcalidrawView.ts");
const automate = read("src/shared/ExcalidrawAutomate.ts");
const constants = read("src/constants/constants.ts");
const registries = read("src/shared/EmbeddedDataRegistries.ts");

const checks = {
  pluginId: manifest.id === "obsidian-excalidraw-plugin",
  sceneHookDeclared:
    automate.includes("onSceneChangeHook:") &&
    automate.includes("trackElements?: boolean"),
  sceneHookReceivesFiles: automate.includes("files: BinaryFiles"),
  reactOnChangeDelegates: root.includes("view.onChange(et as ExcalidrawElement[], st, files)"),
  reactPointerDelegates: root.includes("onPointerUpdate: (p) => view.onPointerUpdate(p)"),
  publicUpdateScene: view.includes("public updateScene("),
  deletedElementGetterUsed: view.includes("getSceneElementsIncludingDeleted()"),
  remoteCaptureMode:
    constants.includes("Use for updates which should never be recorded, such as remote updates") &&
    constants.includes('NEVER: "NEVER"'),
  durableIncrementMarksDirty:
    view.includes('if (event.type !== "durable")') &&
    view.includes("if (changedElements.length > 0) {\n      this.setDirty();"),
  sceneVersionFallbackMarksDirty:
    view.includes("private checkSceneVersion") &&
    view.includes("sceneVersion !== this.previousSceneVersion") &&
    view.includes("this.setDirty();"),
  sceneIncludesFiles:
    view.includes("const files = { ...api.getFiles() }") ||
    view.includes("const files = { ...api.getFiles() };"),
  embeddedResourceRegistries:
    registries.includes("public getFileEntries()") &&
    registries.includes("public getEquationEntries()") &&
    registries.includes("public getMarkdownImage(") &&
    registries.includes("public getMermaidEntries()"),
};

const failed = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

const result = {
  sourceRoot,
  pluginVersion: manifest.version,
  excalidrawVersion: packageJson.dependencies?.["@zsviczian/excalidraw"],
  checks,
  passed: failed.length === 0,
  failed,
};

console.log(JSON.stringify(result, null, 2));
if (failed.length > 0) process.exitCode = 1;
