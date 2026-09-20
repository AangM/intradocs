/**
 * Fail fast, before the first request.
 *
 * Next calls `register()` once per server process at startup. Until now every
 * `readRuntimeConfig` call sat inside a route handler, so a misconfigured deployment
 * started happily, bound its port, passed a naive "is the port open" check and only
 * produced errors once someone tried to use it. Validating here turns that into what it
 * should be: the process refuses to come up, the orchestrator sees a crash loop, and the
 * previous release keeps serving.
 *
 * The same call also warms the config cache, so nothing is paid twice per request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { readRuntimeConfig, ConfigurationError } = await import('@intradocs/core/config');
  try {
    const config = readRuntimeConfig(process.env);
    console.log(
      `IntraDocs ${process.env.npm_package_version ?? ''} · profil ${config.profile} · ${config.appUrl} · AI ${process.env.AI_PROVIDER}`.trim(),
    );
  } catch (error) {
    // One clear line, not a stack trace: whoever reads the container log needs the rule
    // that was broken, not our call sites.
    const message = error instanceof ConfigurationError ? error.message : String(error);
    console.error(`Konfigurasi ditolak, proses dihentikan: ${message}`);
    process.exit(78); // EX_CONFIG
  }
}
