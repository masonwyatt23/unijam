import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const EVIDENCE_NAMES = Object.freeze([
  "candidate", "preflight", "hibernation", "smoke", "soak", "providers", "accessibility", "telemetry", "rollback",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export async function readPrivateEvidenceFile(path, label) {
  const metadata = await lstat(path);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file, not a symlink`);
  requireValue((metadata.mode & 0o077) === 0, `${label} must not be readable or writable by group or others`);
  requireValue(metadata.size > 0 && metadata.size <= MAX_FILE_BYTES, `${label} must be between 1 byte and 2 MiB`);
  return readFile(path);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

function evidencePath(base, reference, manifestPath) {
  const path = resolve(base, reference);
  const fromBase = relative(base, path);
  requireValue(!isAbsolute(reference) && !isAbsolute(fromBase) && fromBase !== "" && fromBase !== ".." && !fromBase.startsWith(`..${sep}`), "Evidence path must remain inside the manifest directory");
  requireValue(path !== manifestPath, "Evidence path must not reference the acceptance manifest itself");
  return path;
}

export async function createEvidenceSeal(manifestPath) {
  manifestPath = resolve(manifestPath);
  const manifestBytes = await readPrivateEvidenceFile(manifestPath, "Acceptance manifest");
  const manifest = parseJson(manifestBytes, "Acceptance manifest");
  requireValue(manifest?.schemaVersion === 1 && manifest?.kind === "unijam-pilot-acceptance-manifest", "Acceptance manifest has the wrong schema");
  requireValue(Object.keys(manifest.evidence ?? {}).length === EVIDENCE_NAMES.length, "Acceptance manifest must reference exactly nine evidence files");
  const base = dirname(manifestPath);
  const resolved = new Set();
  const evidence = {};
  let candidate;
  for (const name of EVIDENCE_NAMES) {
    const reference = manifest.evidence?.[name];
    requireValue(typeof reference === "string" && reference.length > 0 && reference.length <= 512, `Acceptance manifest is missing ${name}`);
    const path = evidencePath(base, reference, manifestPath);
    requireValue(!resolved.has(path), `Acceptance manifest reuses one file for multiple evidence entries`);
    resolved.add(path);
    const bytes = await readPrivateEvidenceFile(path, `${name} evidence`);
    evidence[name] = { path: reference, sha256: sha256(bytes), bytes: bytes.byteLength };
    if (name === "candidate") {
      const parsed = parseJson(bytes, "candidate evidence");
      candidate = {
        commit: parsed?.commit,
        webVersionId: parsed?.workers?.web?.versionId,
        connectorVersionId: parsed?.workers?.connectors?.versionId,
      };
    }
  }
  requireValue(typeof candidate?.commit === "string" && /^[a-f0-9]{40}$/.test(candidate.commit), "Candidate evidence commit is malformed");
  requireValue(typeof candidate.webVersionId === "string" && typeof candidate.connectorVersionId === "string", "Candidate evidence Worker versions are missing");
  return {
    schemaVersion: 1,
    kind: "unijam-pilot-evidence-seal",
    candidate,
    createdAt: new Date().toISOString(),
    manifest: { path: basename(manifestPath), sha256: sha256(manifestBytes), bytes: manifestBytes.byteLength },
    evidence,
  };
}

export async function verifyEvidenceSeal(manifestPath, sealPath) {
  manifestPath = resolve(manifestPath);
  sealPath = resolve(sealPath);
  const [manifestBytes, sealBytes] = await Promise.all([
    readPrivateEvidenceFile(manifestPath, "Acceptance manifest"),
    readPrivateEvidenceFile(sealPath, "Acceptance evidence seal"),
  ]);
  const manifest = parseJson(manifestBytes, "Acceptance manifest");
  const seal = parseJson(sealBytes, "Acceptance evidence seal");
  requireValue(seal?.schemaVersion === 1 && seal?.kind === "unijam-pilot-evidence-seal", "Acceptance evidence seal has the wrong schema");
  requireValue(/^[a-f0-9]{40}$/.test(seal.candidate?.commit ?? ""), "Evidence seal candidate commit is malformed");
  requireValue(UUID.test(seal.candidate?.webVersionId ?? "") && UUID.test(seal.candidate?.connectorVersionId ?? ""), "Evidence seal candidate Worker versions are malformed");
  requireValue(seal.manifest?.path === basename(manifestPath), "Evidence seal belongs to a different manifest path");
  requireValue(SHA256.test(seal.manifest?.sha256 ?? "") && seal.manifest.sha256 === sha256(manifestBytes), "Acceptance manifest SHA-256 does not match its seal");
  requireValue(seal.manifest.bytes === manifestBytes.byteLength, "Acceptance manifest byte count does not match its seal");
  requireValue(manifest?.schemaVersion === 1 && manifest?.kind === "unijam-pilot-acceptance-manifest", "Acceptance manifest has the wrong schema");
  requireValue(Object.keys(manifest.evidence ?? {}).length === EVIDENCE_NAMES.length, "Acceptance manifest must reference exactly nine evidence files");
  requireValue(Object.keys(seal.evidence ?? {}).length === EVIDENCE_NAMES.length, "Evidence seal must cover exactly nine evidence files");
  const base = dirname(manifestPath);
  const bundle = {};
  const hashes = {};
  const resolved = new Set();
  for (const name of EVIDENCE_NAMES) {
    const reference = manifest.evidence?.[name];
    const sealed = seal.evidence?.[name];
    requireValue(typeof reference === "string" && sealed?.path === reference, `${name} evidence path does not match its seal`);
    requireValue(SHA256.test(sealed?.sha256 ?? ""), `${name} evidence seal SHA-256 is malformed`);
    const path = evidencePath(base, reference, manifestPath);
    requireValue(!resolved.has(path), `Acceptance manifest reuses one file for multiple evidence entries`);
    resolved.add(path);
    const bytes = await readPrivateEvidenceFile(path, `${name} evidence`);
    requireValue(sealed.bytes === bytes.byteLength, `${name} evidence byte count does not match its seal`);
    requireValue(sealed.sha256 === sha256(bytes), `${name} evidence SHA-256 does not match its seal`);
    bundle[name] = parseJson(bytes, `${name} evidence`);
    hashes[name] = sealed.sha256;
  }
  requireValue(
    bundle.candidate?.commit === seal.candidate?.commit && bundle.candidate?.workers?.web?.versionId === seal.candidate?.webVersionId &&
    bundle.candidate?.workers?.connectors?.versionId === seal.candidate?.connectorVersionId,
    "Evidence seal candidate identity does not match candidate evidence",
  );
  return { manifest, seal, bundle, hashes, manifestSha256: seal.manifest.sha256 };
}
