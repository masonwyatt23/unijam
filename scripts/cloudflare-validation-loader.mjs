/** Lets Node inspect a workerd bundle without executing native binding imports. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export const env = Object.freeze({});",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
