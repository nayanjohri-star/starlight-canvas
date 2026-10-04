#!/usr/bin/env node
/**
 * Synthetic-fixture proof for test/ardy/compare-npz.mjs, the pure-Node
 * comparator used by the CozyClay vs native ARDY parity work.
 *
 * Every fixture is a real .npz built in memory (fflate zipSync) from
 * hand-written .npy bytes, written under os.tmpdir() and removed on exit:
 *
 *   (a) v1.0 header parsing (padded, numpy-style 64-byte alignment)
 *   (b) v2.0 header with the 12-byte prefix -- a parser that hardcodes
 *       the v1.0 10-byte prefix slices the header two bytes short, loses
 *       the shape tuple's ')', and fails (this fixture is deliberately
 *       unpadded with the dict ending in the shape tuple, so the old
 *       slice cannot be rescued by padding)
 *   (c) dtype mismatch (<f4 vs <f8 with equal values) fails
 *   (d) int64 values beyond 2^53: a 1-unit difference must fail (Number
 *       widening used to round both to the same double = false pass),
 *       and a difference beyond 2^53 must fail even at a huge atol
 *   (e) identical int64 values pass
 *   (f) '<U' strings: identical (NUL-padded) pass, different fail
 *   (g) fortran_order=True members are rejected loudly
 *   (h) atol boundary: diff == atol passes, diff just over fails
 *   (i) ignoreExtra: a member present on only one side fails by default
 *       and is accepted with --ignore-extra
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { compareNpz, loadNpz } from "./compare-npz.mjs";

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY
const ESZ = { "<f4": 4, "<f8": 8, "<i8": 8 };

let failures = 0;
const ok = (label, cond, detail) => {
	if (cond) {
		console.log(`PASS  ${label}`);
	} else {
		failures += 1;
		console.log(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
	}
};

const throws = (fn) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};

// --- fixture builders --------------------------------------------------------

/** Little-endian wire bytes for a numeric .npy payload. */
function payload(dtype, values) {
	const buf = Buffer.alloc(values.length * ESZ[dtype]);
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	values.forEach((v, i) => {
		const o = i * ESZ[dtype];
		if (dtype === "<f4") dv.setFloat32(o, v, true);
		else if (dtype === "<f8") dv.setFloat64(o, v, true);
		else dv.setBigInt64(o, BigInt(v), true);
	});
	return buf;
}

/** '<U<n>' payload: fixed-width little-endian UTF-32 code points, NUL-padded. */
function unicodePayload(nchars, strings) {
	const buf = Buffer.alloc(strings.length * nchars * 4);
	strings.forEach((s, e) => {
		for (let c = 0; c < s.length; c += 1) {
			buf.writeUInt32LE(s.codePointAt(c), (e * nchars + c) * 4);
		}
	});
	return buf;
}

/** The numpy header dict literal, same text as tools/ardy/npz.mjs writes. */
function headerDict(dtype, shape, fortran = false) {
	const tuple = shape.length === 0 ? "()" : `(${shape.join(", ")}${shape.length === 1 ? "," : ""})`;
	return `{'descr': '${dtype}', 'fortran_order': ${fortran ? "True" : "False"}, 'shape': ${tuple}, }`;
}

/**
 * One .npy member: magic + version + HEADER_LEN + header + payload.
 * With pad (the default) the header is space-padded so the whole prefix is
 * 64-aligned, exactly like numpy writes it. The v2.0 fixture passes
 * pad:false and a dict that ends in the shape tuple, so a parser assuming
 * the v1.0 10-byte prefix slices the header two bytes short and loses the
 * closing ')' -- the exact regression case.
 */
function npyBytes(major, dict, data, pad = true) {
	const prefixLen = major === 1 ? 10 : 12;
	let header = dict;
	if (pad) {
		const padLen = (64 - ((prefixLen + dict.length + 1) % 64)) % 64;
		header = dict + " ".repeat(padLen) + "\n";
	}
	const prefix = Buffer.alloc(prefixLen);
	NPY_MAGIC.forEach((byte, i) => prefix.writeUInt8(byte, i));
	prefix.writeUInt8(major, 6);
	prefix.writeUInt8(0, 7);
	if (major === 1) prefix.writeUInt16LE(header.length, 8);
	else prefix.writeUInt32LE(header.length, 8);
	return Buffer.concat([prefix, Buffer.from(header, "latin1"), data]);
}

/** Write a .npz with the given members (member name -> npyBytes spec). */
function writeNpz(dir, name, members) {
	const entries = {};
	for (const [member, spec] of Object.entries(members)) {
		entries[`${member}.npy`] = npyBytes(spec.major, spec.dict, spec.data, spec.pad ?? true);
	}
	const path = join(dir, name);
	writeFileSync(path, zipSync(entries));
	return path;
}

	const dir = mkdtempSync(join(tmpdir(), "cozyclay-verify-compare-npz-"));

// --- (a) v1.0 header parsing --------------------------------------------------

const v1 = {
	x: { major: 1, dict: headerDict("<f8", [2, 3]), data: payload("<f8", [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]) },
	s: { major: 1, dict: headerDict("<f8", []), data: payload("<f8", [7.25]) },
};
let report = null;
try {
	report = compareNpz(writeNpz(dir, "v1-a.npz", v1), writeNpz(dir, "v1-b.npz", v1));
	ok(
		"v1 header: padded v1.0 npz parses and compares identical",
		report.pass === true && report.arrays.length === 2,
		`arrays=${report.arrays.length}`
	);
} catch (err) {
	ok("v1 header: padded v1.0 npz parses and compares identical", false, err.message);
}
if (report) {
	const x = report.arrays.find((r) => r.name === "x");
	const s = report.arrays.find((r) => r.name === "s");
	ok(
		"v1 header: shapes/dtypes parsed",
		x !== undefined && x.dtypeA === "<f8" && s !== undefined && s.dtypeA === "<f8" && s.shapeA.length === 0,
		x && s ? `x=${x.shapeA} s=()` : "member missing"
	);
	const m = loadNpz(join(dir, "v1-a.npz"));
	ok(
		"v1 header: values match the fixture",
		m.get("x").data[5] === 6.5 && m.get("s").data[0] === 7.25
	);
}

// --- (b) v2.0 header: 12-byte prefix -------------------------------------------

const v2 = {
	x: { major: 2, dict: `{'descr': '<f8', 'fortran_order': False, 'shape': (3,)}`, pad: false, data: payload("<f8", [1.5, 2.5, 3.5]) },
};
try {
	const m = loadNpz(writeNpz(dir, "v2.npz", v2));
	const x = m.get("x");
	ok(
		"v2.0 header: 12-byte prefix parsed",
		x !== undefined && x.dtype === "<f8" && x.shape.join() === "3" && x.data.length === 3 && x.data[0] === 1.5 && x.data[2] === 3.5,
		x ? `dtype=${x.dtype} shape=(${x.shape})` : "member missing"
	);
} catch (err) {
	ok("v2.0 header: 12-byte prefix parsed", false, err.message);
}

// --- (c) dtype mismatch fails even with equal values ---------------------------

const f4 = { x: { major: 1, dict: headerDict("<f4", [3]), data: payload("<f4", [1.5, 2.5, 3.5]) } };
const f8 = { x: { major: 1, dict: headerDict("<f8", [3]), data: payload("<f8", [1.5, 2.5, 3.5]) } };
try {
	const r = compareNpz(writeNpz(dir, "f4.npz", f4), writeNpz(dir, "f8.npz", f8));
	const e = r.arrays[0];
	ok(
		"dtype mismatch: <f4 vs <f8 with equal values fails",
		r.pass === false && e.pass === false && e.dtypeEqual === false,
		`dtypeEqual=${e.dtypeEqual} pass=${e.pass}`
	);
} catch (err) {
	ok("dtype mismatch: <f4 vs <f8 with equal values fails", false, err.message);
}

// --- (d) int64 beyond 2^53: no false pass ---------------------------------------

const i64a = { x: { major: 1, dict: headerDict("<i8", [1]), data: payload("<i8", [2n ** 60n + 1n]) } };
const i64b = { x: { major: 1, dict: headerDict("<i8", [1]), data: payload("<i8", [2n ** 60n + 2n]) } };
try {
	const r = compareNpz(writeNpz(dir, "i64-a.npz", i64a), writeNpz(dir, "i64-b.npz", i64b));
	ok(
		"int64: values beyond 2^53 with a 1-unit difference fail",
		r.pass === false && r.arrays[0].maxAbsDiff === 1,
		`maxAbsDiff=${r.arrays[0].maxAbsDiff}`
	);
} catch (err) {
	ok("int64: values beyond 2^53 with a 1-unit difference fail", false, err.message);
}
const i64c = { x: { major: 1, dict: headerDict("<i8", [1]), data: payload("<i8", [0n]) } };
const i64d = { x: { major: 1, dict: headerDict("<i8", [1]), data: payload("<i8", [2n ** 60n]) } };
try {
	const r = compareNpz(writeNpz(dir, "i64-c.npz", i64c), writeNpz(dir, "i64-d.npz", i64d), { atol: 1e308 });
	ok(
		"int64: difference beyond 2^53 fails even at huge atol",
		r.pass === false && r.arrays[0].maxAbsDiff === Infinity,
		`maxAbsDiff=${r.arrays[0].maxAbsDiff}`
	);
} catch (err) {
	ok("int64: difference beyond 2^53 fails even at huge atol", false, err.message);
}

// --- (e) identical int64 passes ---------------------------------------------------

const i64same = { x: { major: 1, dict: headerDict("<i8", [2]), data: payload("<i8", [2n ** 60n, -7n]) } };
try {
	const r = compareNpz(writeNpz(dir, "i64-same-a.npz", i64same), writeNpz(dir, "i64-same-b.npz", i64same));
	ok(
		"int64: identical large values pass",
		r.pass === true && r.arrays[0].identical === true && r.arrays[0].maxAbsDiff === 0,
		`maxAbsDiff=${r.arrays[0].maxAbsDiff}`
	);
} catch (err) {
	ok("int64: identical large values pass", false, err.message);
}

// --- (f) <U strings -----------------------------------------------------------------

const uSame = { x: { major: 1, dict: headerDict("<U8", [2]), data: unicodePayload(8, ["ab", "hello"]) } };
const uDiff = { x: { major: 1, dict: headerDict("<U8", [2]), data: unicodePayload(8, ["ab", "help"]) } };
try {
	const r = compareNpz(writeNpz(dir, "u-a.npz", uSame), writeNpz(dir, "u-b.npz", uSame));
	ok("unicode: identical <U8 members pass (NUL padding decoded)", r.pass === true && r.arrays[0].identical === true);
} catch (err) {
	ok("unicode: identical <U8 members pass (NUL padding decoded)", false, err.message);
}
try {
	const r = compareNpz(writeNpz(dir, "u-c.npz", uSame), writeNpz(dir, "u-d.npz", uDiff));
	ok("unicode: different <U8 members fail", r.pass === false && r.arrays[0].pass === false);
} catch (err) {
	ok("unicode: different <U8 members fail", false, err.message);
}

// --- (g) fortran_order rejected ------------------------------------------------------

const fortran = { x: { major: 1, dict: headerDict("<f8", [2], true), data: payload("<f8", [1, 2]) } };
ok("fortran_order=True member is rejected", throws(() => loadNpz(writeNpz(dir, "fortran.npz", fortran))));

// --- (h) atol boundary -----------------------------------------------------------------

const half = { x: { major: 1, dict: headerDict("<f8", [1]), data: payload("<f8", [0.5]) } };
const oneAndHalf = { x: { major: 1, dict: headerDict("<f8", [1]), data: payload("<f8", [1.5]) } };
try {
	const r = compareNpz(writeNpz(dir, "atol-a.npz", half), writeNpz(dir, "atol-b.npz", oneAndHalf), { atol: 1 });
	ok("atol: diff == atol passes", r.pass === true && r.arrays[0].maxAbsDiff === 1, `maxAbsDiff=${r.arrays[0].maxAbsDiff}`);
} catch (err) {
	ok("atol: diff == atol passes", false, err.message);
}
try {
	const r = compareNpz(writeNpz(dir, "atol-c.npz", half), writeNpz(dir, "atol-d.npz", oneAndHalf), { atol: 0.999 });
	ok(
		"atol: diff just over atol fails",
		r.pass === false && r.arrays[0].maxAbsDiff === 1,
		`maxAbsDiff=${r.arrays[0].maxAbsDiff}`
	);
} catch (err) {
	ok("atol: diff just over atol fails", false, err.message);
}

// --- (i) ignoreExtra -------------------------------------------------------------------

const base = { x: { major: 1, dict: headerDict("<f8", [1]), data: payload("<f8", [1]) } };
const withExtra = { ...base, y: { major: 1, dict: headerDict("<f8", [1]), data: payload("<f8", [2]) } };
try {
	const r = compareNpz(writeNpz(dir, "extra-a.npz", withExtra), writeNpz(dir, "extra-b.npz", base));
	ok("ignoreExtra: extra member fails by default", r.pass === false && r.onlyInA.join() === "y", `onlyInA=${r.onlyInA}`);
} catch (err) {
	ok("ignoreExtra: extra member fails by default", false, err.message);
}
try {
	const r = compareNpz(writeNpz(dir, "extra-c.npz", withExtra), writeNpz(dir, "extra-d.npz", base), { ignoreExtra: true });
	ok("ignoreExtra: extra member accepted with --ignore-extra", r.pass === true);
} catch (err) {
	ok("ignoreExtra: extra member accepted with --ignore-extra", false, err.message);
}

// --- cleanup ------------------------------------------------------------------------------

rmSync(dir, { recursive: true, force: true });

console.log(`\nfailures: ${failures}`);
process.exit(failures ? 1 : 0);
