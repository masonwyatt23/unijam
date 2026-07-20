declare module "cloudflare:workers" {
  // Required declaration merge for the Workers Vitest runtime.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Cloudflare.Env {}
}
