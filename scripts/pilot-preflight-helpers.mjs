export function pendingMigrationNames(result) {
  if (!result || result.status !== 0 || typeof result.stdout !== "string") return undefined;
  if (/\bNo migrations to apply!\s*$/m.test(result.stdout)) return [];
  const names = [...result.stdout.matchAll(/\b\d{4}[a-zA-Z0-9._-]*\.sql\b/g)].map((match) => match[0]);
  return names.length > 0 ? [...new Set(names)] : undefined;
}

export function activeVersionIds(result) {
  if (!result || result.status !== 0 || typeof result.stdout !== "string") return undefined;
  let deployment;
  try { deployment = JSON.parse(result.stdout); }
  catch { return undefined; }
  if (!deployment || typeof deployment !== "object" || !Array.isArray(deployment.versions)) return undefined;
  const versions = deployment.versions
    .filter((entry) => entry && typeof entry.version_id === "string" && Number(entry.percentage) > 0)
    .map((entry) => entry.version_id);
  return versions.length > 0 ? [...new Set(versions)] : undefined;
}

function hasExpectedProperties(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

export function deployedVersionMismatches(value, expected) {
  const handlers = value?.resources?.script?.handlers;
  const rawNamedHandlers = value?.resources?.script?.named_handlers;
  const namedHandlers = rawNamedHandlers === undefined ? [] : rawNamedHandlers;
  const bindings = value?.resources?.bindings;
  if (!Array.isArray(handlers) || !Array.isArray(namedHandlers) || !Array.isArray(bindings)) {
    return ["deployed version resources are unreadable"];
  }
  const mismatches = [];
  for (const handler of expected.handlers) {
    if (!handlers.includes(handler)) mismatches.push(`handler ${handler} is missing`);
  }
  for (const namedHandler of expected.namedHandlers) {
    const deployed = namedHandlers.find((candidate) => candidate?.name === namedHandler.name);
    if (!deployed || !namedHandler.handlers.every((handler) => deployed.handlers?.includes(handler))) {
      mismatches.push(`named handler ${namedHandler.name} is missing or incompatible`);
    }
  }
  for (const expectedBinding of expected.bindings) {
    if (!bindings.some((binding) => hasExpectedProperties(binding, expectedBinding))) {
      mismatches.push(`binding ${expectedBinding.name} is missing or mismatched`);
    }
  }
  return mismatches;
}
