#!/usr/bin/env node
/**
 * Pure-Node comparator for numpy .npz archives, used by the CozyClay vs
 * native ARDY parity work: two runs that share prompt, duration and seed
 * must produce numerically identical motion, and this is the tool that
 * proves it array by array.
 *
 * Loading is done with fflate (already vendored) plus a manual .npy header
 * parse: numpy stores each member as `<name>.npy` inside the zip. dtypes
 * <f4/<f8/<i1/<i2/<i4/<i8/<u1/<u2/<u4/<u8/|b1 are read as typed-array
 * views; '<U<n>' unicode strings are decoded (UTF-32LE code points, the
 * numpy wire format); anything else throws loudly. Fortran-ordered members
 * (numpy never writes them from the ARDY pipeline, and .npy stores them
 * transposed) are rejected with an explicit error instead of being compared
 * on the wrong layout.
 *
 * Exports:
 *   loadNpz(path) -> Map<name, { shape, dtype, data }>
 *     data is a TypedArray view (numeric dtypes) or an array of JS strings
 *     ('<U' dtypes); shape is an array of ints.
 *   compareNpz(aPath, bPath, { atol = 0, ignoreExtra = false }) -> report
 *     report = {
 *       arrays: [{ name, shapeA, shapeB, shapeEqual, dtypeA, dtypeB,
 *                  dtypeEqual, maxAbsDiff, meanAbsDiff, identical, pass }],
 *       onlyInA: [names], onlyInB: [names], pass: bool
 *     }
 *     pass = every shared array has equal shape AND equal dtype and
 *     maxAbsDiff <= atol (strings must be exactly equal; int64 differences
 *     beyond 2^53 always fail), and no array exists on only one side
 *     unless ignoreExtra is set. maxAbsDiff/meanAbsDiff are null for
 *     non-numeric arrays.
 *   printReport(aPath, bPath, report, { atol, ignoreExtra }) -> void
 *     human-readable table + result line.
 *
 * CLI: node test/ardy/compare-npz.mjs <a.npz> <b.npz> [--atol 1e-6] [--ignore-extra]
 *   exit 0 on pass, 1 on fail (2 on bad usage).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

/* --- .npy member parsing -------------------------------------------------- */

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

// descr -> [TypedArrayConstructor, bytesPerElement]. |b1 / <b1 / ? are numpy
// bool (1 byte, 0/1) and read fine as Uint8Array.
const DTYPE_VIEWS = {
	"<f4": [Float32Array, 4],
	"<f8": [Float64Array, 8],
	"<i1": [Int8Array, 1],
	"<i2": [Int16Array, 2],
	"<i4": [Int32Array, 4],
	"<i8": [BigInt64Array, 8],
	"<u1": [Uint8Array, 1],
	"<u2": [Uint16Array, 2],
	"<u4": [Uint32Array, 4],
	"<u8": [BigUint64Array, 8],
	"|b1": [Uint8Array, 1],
	"<b1": [Uint8Array, 1],
	"?": [Uint8Array, 1],
};

/** Decode one '<U<n>' payload: nchars little-endian UTF-32 code points per
 * element, NUL-padded by numpy to the fixed field width. */
function decodeNumpyUnicode(buf, dataStart, nchars, count) {
	const unitBytes = nchars * 4;
	const out = new Array(count);
	for (let e = 0; e < count; e += 1) {
		let s = "";
		for (let c = 0; c < nchars; c += 1) {
			const cp = buf.readUInt32LE(dataStart + e * unitBytes + c * 4);
			if (cp === 0) break; // trailing NUL padding
			s += String.fromCodePoint(cp);
		}
		out[e] = s;
	}
	return out;
}

/** Parse one unzipped .npy member (numpy v1.0/v2.0/v3.0 header) into
 * { shape, dtype, data }. Throws an explicit error on anything the parity
 * comparison cannot trust. */
function parseNpyMember(buf, name) {
	if (buf.length < 10 || !NPY_MAGIC.every((byte, i) => buf[i] === byte)) {
		throw new Error(`${name}: not a numpy .npy member (bad magic)`);
	}
	const major = buf[6];
	let headerLen;
	if (major === 1) {
		if (buf.length < 10) throw new Error(`${name}: truncated .npy header`);
		headerLen = buf.readUInt16LE(8);
	} else if (major === 2 || major === 3) {
		if (buf.length < 12) throw new Error(`${name}: truncated .npy header`);
		headerLen = buf.readUInt32LE(8);
	} else {
		throw new Error(`${name}: unsupported .npy version ${major}`);
	}
	// v1.0 stores HEADER_LEN as uint16 at offset 8 (10-byte prefix); v2.0
	// and v3.0 store it as uint32 (12-byte prefix). The header dict starts
	// right after the version-specific prefix.
	const prefixLen = major === 1 ? 10 : 12;
	if (prefixLen + headerLen > buf.length) throw new Error(`${name}: truncated .npy header`);
	const header = buf.subarray(prefixLen, prefixLen + headerLen).toString("latin1");
	const descrMatch = /'descr':\s*'([^']*)'/.exec(header);
	const fortranMatch = /'fortran_order':\s*(True|False)/.exec(header);
	const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
	if (!descrMatch || !fortranMatch || !shapeMatch) {
		throw new Error(`${name}: malformed .npy header "${header.slice(0, 80)}"`);
	}
	if (fortranMatch[1] === "True") {
		throw new Error(`${name}: fortran_order=True layout is not supported`);
	}
	const dtype = descrMatch[1];
	const shape =
		shapeMatch[1].trim() === ""
			? []
			: [...shapeMatch[1].matchAll(/\d+/g)].map((m) => Number(m[0]));
	// The payload starts right after the version-specific prefix + header.
	const dataStart = prefixLen + headerLen;
	const count = shape.reduce((n, d) => n * d, 1); // scalar shape () -> 1

	const strMatch = /^<U(\d+)$/.exec(dtype);
	if (strMatch) {
		const unitBytes = Number(strMatch[1]) * 4;
		if (dataStart + count * unitBytes > buf.length) {
			throw new Error(`${name}: truncated ${dtype} payload`);
		}
		return { shape, dtype, data: decodeNumpyUnicode(buf, dataStart, Number(strMatch[1]), count) };
	}

	const view = DTYPE_VIEWS[dtype];
	if (!view) throw new Error(`${name}: unsupported dtype "${dtype}"`);
	const [Ctor, esz] = view;
	const byteLen = count * esz;
	if (dataStart + byteLen > buf.length) throw new Error(`${name}: truncated ${dtype} payload`);
	// Typed-array views need the payload aligned to the element size (8 for
	// int64); unaligned payloads are copied into a fresh buffer instead.
	const tail = buf.subarray(dataStart, dataStart + byteLen);
	const aligned = tail.byteOffset % esz === 0 ? tail : Buffer.from(tail);
	return { shape, dtype, data: new Ctor(aligned.buffer, aligned.byteOffset, count) };
}

/* --- public API ----------------------------------------------------------- */

/**
 * Read a .npz archive into a name -> { shape, dtype, data } map (sorted by
 * member name; non-.npy members ignored). Numeric data are views into the
 * unzipped buffer, not copies.
 */
export function loadNpz(path) {
	const archive = unzipSync(readFileSync(path));
	const members = new Map();
	for (const rawName of Object.keys(archive).sort()) {
		if (!rawName.endsWith(".npy")) continue;
		const raw = archive[rawName];
		const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
		members.set(rawName.slice(0, -4), parseNpyMember(buf, rawName));
	}
	return members;
}

// Largest difference a BigInt pair can report as a Number: 2^53 is exactly
// representable as a double, anything above it is not.
const MAX_SAFE_INT_DIFF = 2n ** 53n;

/** Elementwise diff of two same-length typed arrays. NaN equals NaN for the
 * identical check; any real difference feeds max/mean absolute difference.
 * BigInt pairs (int64/uint64) are compared exactly, never via Number: a
 * difference beyond 2^53 cannot be represented as a Number, so it reports
 * Infinity and forces a fail instead of a false pass. */
function numericDiff(da, db) {
	let identical = true;
	let maxAbsDiff = 0;
	let sumAbsDiff = 0;
	const n = da.length;
	const bigPair = typeof da[0] === "bigint" && typeof db[0] === "bigint";
	for (let i = 0; i < n; i += 1) {
		const x = da[i];
		const y = db[i];
		if (x === y) continue;
		if (Number.isNaN(x) && Number.isNaN(y)) continue;
		identical = false;
		let diff;
		if (bigPair) {
			diff = x > y ? x - y : y - x; // exact BigInt
			if (diff > MAX_SAFE_INT_DIFF) {
				maxAbsDiff = Infinity;
				sumAbsDiff = Infinity;
				continue;
			}
			diff = Number(diff);
		} else {
			diff = Math.abs(Number(x) - Number(y));
		}
		maxAbsDiff = Math.max(maxAbsDiff, diff);
		sumAbsDiff += diff;
	}
	return { identical, maxAbsDiff, meanAbsDiff: n === 0 ? 0 : sumAbsDiff / n };
}

function compareArray(name, ma, mb, atol) {
	const base = {
		name,
		shapeA: ma.shape,
		shapeB: mb.shape,
		shapeEqual: JSON.stringify(ma.shape) === JSON.stringify(mb.shape),
		dtypeA: ma.dtype,
		dtypeB: mb.dtype,
		dtypeEqual: ma.dtype === mb.dtype,
	};
	if (!base.shapeEqual) return { ...base, maxAbsDiff: null, meanAbsDiff: null, identical: false, pass: false };
	const aStr = Array.isArray(ma.data);
	const bStr = Array.isArray(mb.data);
	if (aStr !== bStr) return { ...base, maxAbsDiff: null, meanAbsDiff: null, identical: false, pass: false };
	if (aStr) {
		const identical = ma.data.length === mb.data.length && ma.data.every((s, i) => s === mb.data[i]);
		return { ...base, maxAbsDiff: null, meanAbsDiff: null, identical, pass: base.dtypeEqual && identical };
	}
	const { identical, maxAbsDiff, meanAbsDiff } = numericDiff(ma.data, mb.data);
	return { ...base, maxAbsDiff, meanAbsDiff, identical, pass: base.dtypeEqual && (identical || maxAbsDiff <= atol) };
}

/**
 * Compare two .npz files array by array. See the header comment for the
 * exact report shape and pass semantics.
 */
export function compareNpz(aPath, bPath, { atol = 0, ignoreExtra = false } = {}) {
	const a = loadNpz(aPath);
	const b = loadNpz(bPath);
	const arrays = [...a.keys()]
		.filter((name) => b.has(name))
		.sort()
		.map((name) => compareArray(name, a.get(name), b.get(name), atol));
	const onlyInA = [...a.keys()].filter((name) => !b.has(name)).sort();
	const onlyInB = [...b.keys()].filter((name) => !a.has(name)).sort();
	const pass =
		arrays.every((entry) => entry.pass) && (ignoreExtra || (onlyInA.length === 0 && onlyInB.length === 0));
	return { arrays, onlyInA, onlyInB, pass };
}

/* --- report printing ------------------------------------------------------ */

const fmtShape = (s) => (s.length === 0 ? "()" : `(${s.join(", ")}${s.length === 1 ? "," : ""})`);

const fmtNum = (v) => {
	if (v === null) return "-";
	if (v === 0) return "0";
	if (!Number.isFinite(v)) return String(v);
	return v.toExponential(3);
};

/** Print the comparison table and a result line for humans. */
export function printReport(aPath, bPath, report, { atol = 0, ignoreExtra = false } = {}) {
	const headers = ["array", "shapeA", "shapeB", "dtypeA", "dtypeB", "shape", "dtype", "maxAbsDiff", "meanAbsDiff", "identical", "pass"];
	const rows = report.arrays.map((r) => [
		r.name,
		fmtShape(r.shapeA),
		fmtShape(r.shapeB),
		r.dtypeA,
		r.dtypeB,
		r.shapeEqual ? "same" : "DIFF",
		r.dtypeEqual ? "same" : "DIFF",
		fmtNum(r.maxAbsDiff),
		fmtNum(r.meanAbsDiff),
		r.identical ? "yes" : "no",
		r.pass ? "ok" : "FAIL",
	]);
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
	const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
	console.log(`comparing ${aPath}`);
	console.log(`       vs ${bPath}  (atol=${fmtNum(atol)}, ignoreExtra=${ignoreExtra})`);
	console.log(line(headers));
	for (const row of rows) console.log(line(row));
	if (report.onlyInA.length > 0) console.log(`only in a: ${report.onlyInA.join(", ")}`);
	if (report.onlyInB.length > 0) console.log(`only in b: ${report.onlyInB.join(", ")}`);
	const failed = report.arrays.filter((entry) => !entry.pass).length;
	const extra = report.onlyInA.length + report.onlyInB.length;
	console.log(`result: ${report.pass ? "PASS" : "FAIL"} (${report.arrays.length} shared, ${failed} failed, ${extra} extra)`);
}

/* --- CLI ------------------------------------------------------------------ */

const USAGE = `usage: node test/ardy/compare-npz.mjs <a.npz> <b.npz> [--atol <tolerance>] [--ignore-extra]
  compares every array in both .npz archives member by member (same name =>
  numeric diff; arrays present on only one side fail unless --ignore-extra).
  exit 0 on pass, 1 on fail.`;

function main(argv) {
	const positional = [];
	const opts = { atol: 0, ignoreExtra: false };
	while (argv.length > 0) {
		const arg = argv.shift();
		if (arg === "--atol") opts.atol = Number(argv.shift());
		else if (arg === "--ignore-extra") opts.ignoreExtra = true;
		else if (arg === "-h" || arg === "--help") {
			console.log(USAGE);
			process.exit(0);
		} else positional.push(arg);
	}
	if (positional.length !== 2 || !Number.isFinite(opts.atol) || opts.atol < 0) {
		console.error(USAGE);
		process.exit(2);
	}
	try {
		const report = compareNpz(positional[0], positional[1], opts);
		printReport(positional[0], positional[1], report, opts);
		process.exit(report.pass ? 0 : 1);
	} catch (err) {
		console.error(`compare-npz: ${err.message}`);
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2));
}
