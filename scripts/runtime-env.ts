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
  // Both processes talk to WeKnora: web for retrieval, worker for export. The key is a
  // server-side credential and reaches neither the browser bundle nor any response.
  const weknora = [
    'AI_GENERATION',
    'AI_GENERATION_LOCATION',
    'AI_EXTERNAL_ACKNOWLEDGED',
    'WEKNORA_BASE_URL',
    'WEKNORA_API_KEY',
    'WEKNORA_KNOWLEDGE_BASE_ID',
    'WEKNORA_TENANT_ID',
    'WEKNORA_REQUEST_TIMEOUT_MS',
    'WEKNORA_SEARCH_TIMEOUT_MS',
    'WEKNORA_CHAT_TIMEOUT_MS',
    'WEKNORA_MAX_CANDIDATES',
    'WEKNORA_MAX_SCOPE_DOCUMENTS',
    'WEKNORA_MAX_RESPONSE_BYTES',
    'WEKNORA_EXPORT_BATCH_SIZE',
    'WEKNORA_EXPORT_MAX_ATTEMPTS',
    'WEKNORA_MAX_QUESTION_CHARS',
    'WEKNORA_MAX_SNIPPET_CHARS',
    'WEKNORA_MAX_ANSWER_CHARS',
    'WEKNORA_MIN_RELEVANCE',
    'WEKNORA_GENERATION_MODEL_ID',
    'WEKNORA_AGENT_ID',
  ];
  const keys =
    target === 'web'
      ? [
          'APP_URL',
          'AUTH_MODE',
          'OIDC_ISSUER',
          'OIDC_CLIENT_ID',
          'OIDC_CLIENT_SECRET',
          'OIDC_LABEL',
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
  for (const key of [...operatingSystemKeys, ...shared, ...weknora, ...keys])
    if (source[key] !== undefined) result[key] = source[key];
  if (target === 'web')
    result.PORT = new URL(source.APP_URL ?? 'http://localhost:3000').port || '80';
  return result;
}
