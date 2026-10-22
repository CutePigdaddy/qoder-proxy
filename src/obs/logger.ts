import pino from 'pino';

// Bootstraps the logger at import time, which is earlier than `.env` is read, so
// the level here is only a placeholder: `applyLogLevel` re-applies the validated
// configuration once it exists (see src/index.ts).
const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino.default({
  level,
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'pat',
      '*.pat',
      'token',
      '*.token',
      'jobToken',
      '*.jobToken',
      'refreshToken',
      '*.refreshToken',
      'accessToken',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
});

/** Apply the validated `LOG_LEVEL` after `.env` and config parsing have run. */
export function applyLogLevel(level: string): void {
  logger.level = level;
}

const SECRET_PATTERN = /\b(?:pt|jt|jrt)-[A-Za-z0-9._~+/=-]+/g;

/** Strip any accidental credential material before it reaches a log sink. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[redacted]');
}
