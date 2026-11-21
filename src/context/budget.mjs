import { createHash } from 'node:crypto';

export function contextError(code, message, details) {
  return Object.assign(new Error(message), {code, ...(details === undefined ? {} : {details})});
}
export const DEFAULT_CONTEXT = Object.freeze({
  reviewEverySteps: 6, reviewMaxTokens: 4096, checkpointMaxBytes: 10000,
  segmentMaxEvents: 1200, queryLimit: 20, queryMaxBytes: 10000,
  debug: false, debugMaxBytes: 2097152, debugFiles: 4,
});
export function contextConfig(value = {}) {
  const config = {...DEFAULT_CONTEXT};
  for (const [key,item] of Object.entries(value ?? {})) {
    if (Object.hasOwn(DEFAULT_CONTEXT,key) || key === 'httpProviders') config[key] = item;
  }
  for (const key of Object.keys(DEFAULT_CONTEXT).filter(key => key !== 'debug')) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw contextError('LOOM_CONTEXT_CONFIG',`${key} must be a positive integer`);
  }
  if (typeof config.debug !== 'boolean') throw contextError('LOOM_CONTEXT_CONFIG','debug must be a boolean');
  return config;
}
export const jsonBytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));

const credentialKey = /^(?:authorization|proxy.authorization|cookie|set.cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|account[-_]?token|token|password|passwd|secret|credential|client[-_]?secret)$/i;
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join('[REDACTED]');
    return result.replace(/\bBearer\s+[^\s"'<>;,]+/gi,'Bearer [REDACTED]')
      .replace(/\b(?:sk|sess)-[a-z0-9_-]{12,}/gi,'[REDACTED]')
      .replace(/\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)\s*[=:]\s*["']?)[^\s"'<>;,}]+/gi,'$1[REDACTED]')
      .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,'[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item,secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,credentialKey.test(key) ? '[REDACTED]' : redact(item,secrets)]));
  return value;
}
export function safeUrl(value) {
  const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString();
}
export const prefixDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
