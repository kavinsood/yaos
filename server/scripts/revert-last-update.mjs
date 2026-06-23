import { execFileSync } from "node:child_process";

function read(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

const lastUpdateCommit = read("git", [
	"log",
	"--fixed-strings",
	"--grep",
	"kaos(server): update to ",
	"-n",
	"1",
	"--format=%H",
]);

if (!lastUpdateCommit) {
	throw new Error("No previous KAOS server update commit was found");
}

console.log(`Reverting ${lastUpdateCommit}`);
execFileSync("git", ["revert", "--no-edit", lastUpdateCommit], {
	stdio: "inherit",
});
