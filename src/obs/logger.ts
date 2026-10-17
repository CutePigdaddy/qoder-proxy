import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
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

const SECRET_PATTERN = /\b(?:pt|jt|jrt)-[A-Za-z0-9._~+/=-]+/g;

/** Strip any accidental credential material before it reaches a log sink. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[redacted]');
}
