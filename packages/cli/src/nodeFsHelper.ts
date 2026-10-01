export interface FileIdentity {
	readonly dev: number;
	readonly ino: number;
}

export interface FileSnapshot extends FileIdentity {
	readonly mode: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly bytes: string;
	readonly content: string;
}

export interface FilePublication extends FileIdentity {
	readonly size: number;
	readonly mtimeMs: number;
}

export type NodeFsRequest =
	| { readonly kind: "read"; readonly root: string; readonly path: string; readonly identity: FileIdentity; readonly maximumBytes: number }
	| { readonly kind: "replace"; readonly root: string; readonly path: string; readonly expected: FileSnapshot; readonly output: string; readonly maximumBytes: number; readonly temporary: string }
	| { readonly kind: "rename"; readonly root: string; readonly path: string; readonly target: string; readonly identity: FileIdentity };

export const NODE_FS_HELPER_SOURCE = String.raw`
const filesystem = require("node:fs");
const paths = require("node:path");
let published = false;
let retainedTemporary;
function assertParent(root, filename) {
  const parent = paths.relative(root, filesystem.realpathSync(paths.dirname(filename)));
  if (parent.startsWith("..") || paths.isAbsolute(parent)) {
    throw new Error("Symlink traversal rejected");
  }
}
function assertIdentity(stats, expected) {
  if (stats.dev !== expected.dev || stats.ino !== expected.ino) throw new Error("File identity changed");
}
function readChecked(request) {
  assertParent(request.root, request.path);
  const namedBefore = filesystem.lstatSync(request.path);
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) throw new Error("Not a regular file");
  assertIdentity(namedBefore, request.identity || request.expected);
  const descriptor = filesystem.openSync(request.path, filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW | filesystem.constants.O_NONBLOCK);
  try {
    const stats = filesystem.fstatSync(descriptor);
    assertIdentity(stats, namedBefore);
    if (!stats.isFile() || stats.size > request.maximumBytes) throw new Error("Invalid process input size or type");
    const bytes = Buffer.alloc(stats.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = filesystem.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = filesystem.fstatSync(descriptor);
    assertParent(request.root, request.path);
    const named = filesystem.lstatSync(request.path);
    if (offset !== stats.size || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || after.ctimeMs !== stats.ctimeMs ||
        named.dev !== stats.dev || named.ino !== stats.ino || named.mtimeMs !== stats.mtimeMs || named.ctimeMs !== stats.ctimeMs) {
      throw new Error("Process source changed during read");
    }
    const exact = bytes.subarray(0, offset);
    return { dev: stats.dev, ino: stats.ino, mode: stats.mode, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs,
      bytes: exact.toString("base64"), content: exact.toString("utf8") };
  } finally {
    filesystem.closeSync(descriptor);
  }
}
function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = filesystem.openSync(directory, "r");
    filesystem.fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) filesystem.closeSync(descriptor);
  }
}
function discardKnownTemporary(request, identity) {
  try {
    const current = readChecked({ kind: "read", root: request.root, path: request.temporary,
      identity, maximumBytes: request.maximumBytes });
    if (current.bytes !== Buffer.from(request.output, "utf8").toString("base64")) return false;
    assertParent(request.root, request.temporary);
    const named = filesystem.lstatSync(request.temporary);
    if (named.dev !== current.dev || named.ino !== current.ino || named.mtimeMs !== current.mtimeMs || named.ctimeMs !== current.ctimeMs) return false;
    filesystem.rmSync(request.temporary);
    return true;
  } catch (error) {
    return error.code === "ENOENT";
  }
}
function execute(request) {
  if (request.kind === "read") return readChecked(request);
  if (request.kind === "rename") {
    assertParent(request.root, request.path);
    assertParent(request.root, request.target);
    const source = filesystem.lstatSync(request.path);
    if (source.isSymbolicLink() || (!source.isFile() && !source.isDirectory())) throw new Error("Not a vault entry");
    assertIdentity(source, request.identity);
    try {
      filesystem.lstatSync(request.target);
      throw new Error("File already exists");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    filesystem.renameSync(request.path, request.target);
    published = true;
    syncDirectory(paths.dirname(request.path));
    if (paths.dirname(request.path) !== paths.dirname(request.target)) syncDirectory(paths.dirname(request.target));
    return null;
  }
  if (request.kind !== "replace") throw new Error("Unknown filesystem request");
  if (typeof request.output !== "string" || Buffer.byteLength(request.output, "utf8") > request.maximumBytes) {
    throw new Error("Invalid process output type or size");
  }
  assertParent(request.root, request.path);
  if (paths.dirname(request.temporary) !== paths.dirname(request.path) || !paths.basename(request.temporary).startsWith(".yaos-write-")) {
    throw new Error("Invalid temporary path");
  }
  let renamed = false;
  let created = false;
  let ownedIdentity;
  try {
    const descriptor = filesystem.openSync(request.temporary, "wx", request.expected.mode & 0o7777);
    created = true;
    let stats;
    try {
      const opened = filesystem.fstatSync(descriptor);
      ownedIdentity = { dev: opened.dev, ino: opened.ino };
      filesystem.fchmodSync(descriptor, request.expected.mode & 0o7777);
      filesystem.writeFileSync(descriptor, request.output, "utf8");
      filesystem.fdatasyncSync(descriptor);
      stats = filesystem.fstatSync(descriptor);
    } finally {
      filesystem.closeSync(descriptor);
    }
    const current = readChecked(request);
    if (current.mtimeMs !== request.expected.mtimeMs || current.ctimeMs !== request.expected.ctimeMs || current.bytes !== request.expected.bytes) {
      throw new Error("Process source changed before publication");
    }
    filesystem.renameSync(request.temporary, request.path);
    renamed = true;
    published = true;
    syncDirectory(paths.dirname(request.path));
    assertParent(request.root, request.path);
    const named = filesystem.lstatSync(request.path);
    assertIdentity(named, stats);
    if (!named.isFile() || named.isSymbolicLink()) throw new Error("Published file replaced externally");
    return { dev: named.dev, ino: named.ino, size: named.size, mtimeMs: named.mtimeMs };
  } finally {
    if (created && !renamed) {
      if (!ownedIdentity || !discardKnownTemporary(request, ownedIdentity)) retainedTemporary = request.temporary;
    }
  }
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const result = execute(JSON.parse(input));
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const message = error.message + (retainedTemporary ? "; temporary retained at " + retainedTemporary + "; inspect before removal" : "");
    process.stdout.write(JSON.stringify({ ok: false, message, code: error.code, published }));
  }
});
`;
