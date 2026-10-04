import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateArtifactDir, evictPrivateArtifact, removePrivateArtifactDir } from "../../tools/ardy/artifacts.mjs";
import { handleExtract } from "../../tools/ardy/extract.mjs";

class Response extends EventEmitter {
	writableEnded = false;
	writeHead() {}
	write() {}
	end() { this.writableEnded = true; }
}

const root = mkdtempSync(join(tmpdir(), "ardy-secure-artifacts-"));
const outDir = join(root, "extract-out");
const stamp = 1700000000000;
const sentinel = join(root, "external-sentinel.txt");
const plantedPath = join(outDir, `extract-upload-${stamp}.mp4`);
const originalExtractHost = process.env.CCLAY_EXTRACT_HOST;
const originalArdyHost = process.env.CCLAY_ARDY_HOST;
try {
	// Given: an attacker pre-planted the old predictable upload name as a symlink.
	writeFileSync(sentinel, "SAFE");
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	symlinkSync(sentinel, plantedPath);
	delete process.env.CCLAY_EXTRACT_HOST;
	delete process.env.CCLAY_ARDY_HOST;

	// When: the real extraction handler receives an upload.
	const request = new EventEmitter();
	request.headers = { "content-type": "video/mp4" };
	const extraction = handleExtract(request, new Response(), {
		readBody: async () => "",
		footagePath: () => null,
		registerMotion: () => {},
		artifactRoot: outDir,
	});
	request.emit("data", Buffer.alloc(1024, 0x41));
	request.emit("end");
	await extraction;

	// Then: the old symlink remains and its external target is untouched.
	assert.equal(readFileSync(sentinel, "utf8"), "SAFE");
	assert.equal(lstatSync(plantedPath).isSymbolicLink(), true);
	assert.deepEqual(readdirSync(outDir).filter((name) => /^extract-[A-Za-z0-9]+$/.test(name)), []);

	// Given: a symlinked artifact root.
	const symlinkedRoot = join(root, "symlinked-out");
	symlinkSync(root, symlinkedRoot);

	// When: a request tries to use that root.
	assert.throws(() => createPrivateArtifactDir(symlinkedRoot, "generate"), /must not be a symlink/);

	// Then: the unsafe root is rejected.

	// Given: a new artifact root.
	const secureRoot = join(root, "secure-out");
	mkdirSync(secureRoot);

	// When: ARDY creates an artifact workspace.
	const requestDir = createPrivateArtifactDir(secureRoot, "generate");
	const artifact = join(requestDir, "pose-0.json");
	writeFileSync(artifact, "{}", { flag: "wx", mode: 0o600 });

	// Then: every directory and artifact carries the private mode contract.
	assert.equal((lstatSync(secureRoot).mode & 0o777), 0o700);
	assert.equal((lstatSync(requestDir).mode & 0o777), 0o700);
	assert.equal((lstatSync(artifact).mode & 0o777), 0o600);
	removePrivateArtifactDir(requestDir);

	// Two extracted people share one private request directory. Evicting the
	// older id must keep that directory while its newer sibling remains live.
	const sharedDir = createPrivateArtifactDir(secureRoot, "extract");
	const firstTake = join(sharedDir, "motion-0.npz");
	const secondTake = join(sharedDir, "motion-1.npz");
	writeFileSync(firstTake, "first", { flag: "wx", mode: 0o600 });
	writeFileSync(secondTake, "second", { flag: "wx", mode: 0o600 });
	const motions = new Map([["first", firstTake], ["second", secondTake]]);
	evictPrivateArtifact(motions, "first");
	assert.equal(readFileSync(secondTake, "utf8"), "second");
	evictPrivateArtifact(motions, "second");
	assert.throws(() => lstatSync(sharedDir));
	console.log("secure ARDY artifact creation preserves planted symlink targets and enforces private modes");
} finally {
	if (originalExtractHost === undefined) delete process.env.CCLAY_EXTRACT_HOST;
	else process.env.CCLAY_EXTRACT_HOST = originalExtractHost;
	if (originalArdyHost === undefined) delete process.env.CCLAY_ARDY_HOST;
	else process.env.CCLAY_ARDY_HOST = originalArdyHost;
	rmSync(plantedPath, { force: true });
	rmSync(root, { recursive: true, force: true });
}
