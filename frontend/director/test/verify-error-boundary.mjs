// The studio's crash net: root boundary exists and layout writes are guarded.
import { readFileSync } from "node:fs";
const main = readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const boundary = readFileSync(new URL("../src/error-boundary.jsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
let failures = 0;
const ok = (name, pass) => { console.log(`${pass ? "PASS" : "FAIL"} ${name}`); if (!pass) failures += 1; };
ok("main mounts App inside the boundary", main.includes('ErrorBoundary') && main.includes('<ErrorBoundary>') && main.includes('<App />'));
ok("boundary implements getDerivedStateFromError and componentDidCatch", boundary.includes('getDerivedStateFromError') && boundary.includes('componentDidCatch'));
ok("boundary offers a named reload recovery", boundary.includes('window.location.reload') && boundary.includes('ko('));
ok("workspace layout write is try/catch guarded", /localStorage\.setItem\(WORKSPACE_LAYOUT_KEY[\s\S]{0,400}?\}\s*catch/.test(app.replace(/\s+/g,' ')) || app.includes('localStorage.setItem(WORKSPACE_LAYOUT_KEY') && app.includes('workspace layout not saved'));
console.log(failures === 0 ? "all error-boundary checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
