import { createHash, randomBytes } from "node:crypto";

const raw = randomBytes(12).toString("hex").toUpperCase();
const code = `UJ-${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16)}`;
const codeHash = createHash("sha256").update(code).digest("hex");
process.stdout.write(`${JSON.stringify({ code, codeHash }, null, 2)}\n`);
