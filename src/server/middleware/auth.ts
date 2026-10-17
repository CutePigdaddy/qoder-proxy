import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from '../../config.js';

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn one comparison so length is not the only thing leaking.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Bearer-key gate for `/v1/*`.
 *
 * Fail-closed: when PROXY_API_KEY is empty every request is refused with 503
 * rather than being let through unauthenticated.
 */
export function authMiddleware(config: AppConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!config.authEnabled) {
      return c.json(
        {
          error: {
            message: 'Gateway is not configured: PROXY_API_KEY is empty',
            type: 'configuration_error',
          },
        },
        503,
      );
    }

    const header = c.req.header('authorization') ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token || !constantTimeEquals(token, config.proxyApiKey)) {
      return c.json(
        {
          error: {
            message: 'Invalid API key',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401,
      );
    }

    await next();
  };
}
