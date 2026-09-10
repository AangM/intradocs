const operatingSystemKeys = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'PNPM_HOME',
  'TERM',
  'FORCE_COLOR',
];
export function childEnvironment(
  source: NodeJS.ProcessEnv,
  target: 'web' | 'worker',
): NodeJS.ProcessEnv {
  const shared = ['APP_PROFILE', 'AI_PROVIDER', 'INTRADOCS_ROOT'];
  const keys =
    target === 'web'
      ? [
          'APP_URL',
          'AUTH_MODE',
          'STORAGE_DRIVER',
          'STORAGE_ROOT',
          'DATABASE_URL',
          'AUTH_DATABASE_URL',
          'BETTER_AUTH_SECRET',
          'CLAMAV_PORT',
          'KNOWLEDGE_PORT',
          'KNOWLEDGE_TOKEN',
        ]
      : ['WORKER_DATABASE_URL', 'STORAGE_ROOT'];
  const result: NodeJS.ProcessEnv = { NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of [...operatingSystemKeys, ...shared, ...keys])
    if (source[key] !== undefined) result[key] = source[key];
  if (target === 'web')
    result.PORT = new URL(source.APP_URL ?? 'http://localhost:3000').port || '80';
  return result;
}
