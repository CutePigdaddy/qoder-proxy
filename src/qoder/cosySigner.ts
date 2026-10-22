import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * COSY request signing.
 *
 * The gateway accepts a request only when the `Cosy-*` bag matches what the
 * official qoderclicn client sends. The scheme is:
 *   - a random 16-char AES-128-CBC key, used with itself as IV, encrypting the
 *     JSON user envelope ({uid, security_oauth_token, name, aid, email});
 *   - that AES key RSA-encrypted (PKCS#1 v1.5) into `Cosy-Key`;
 *   - `Authorization: Bearer COSY.<payloadB64>.<md5(payloadB64\ncosyKey\ntimestamp\nbody\nsigPath)>`;
 * where `body` is the *WAF-encoded* body actually sent, and `sigPath` is the
 * request path with the `/algo` prefix stripped.
 *
 * All constants here are wire facts mirrored from the official client. They are
 * not tunables: changing one silently breaks every request.
 */

const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const COSY_IDE_VERSION = '1.0.0';
const COSY_CLIENT_TYPE = '5';
const COSY_DATA_POLICY = 'disagree';
const COSY_LOGIN_VERSION = 'v2';
const COSY_MACHINE_OS = 'x86_64_windows';
const COSY_MACHINE_TYPE = '5';

export interface CosyCredentials {
  userID: string;
  authToken: string;
  name: string;
  email: string;
  machineID: string;
  /**
   * `Cosy-Clienttype` 的取值，缺省用 CLI(=5)。
   *
   * 2026-10-22 实测：这个头决定上游按哪条通道结算。5 走计费通道（账号
   * credits 为 0 时直接 `code 112` 拒绝）；1–4 走另一条通道，不消耗 credits。
   * 它不参与签名计算，只是身份声明——所以是否改由调用方决定，见
   * `QODER_CLIENT_TYPE`。
   */
  clientType?: string;
}

function rsaEncryptBase64(data: string): string {
  return crypto
    .publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(data))
    .toString('base64');
}

function aesEncryptCbcBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyStr), Buffer.from(keyStr));
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

/** The path the gateway signs: request path with a leading `/algo` removed. */
export function computeSignaturePath(requestUrl: string): string {
  const parsed = new URL(requestUrl);
  const path = parsed.pathname;
  return path.startsWith('/algo') ? path.slice('/algo'.length) : path;
}

export function buildCosyHeaders(
  body: Buffer | string | null,
  requestUrl: string,
  creds: CosyCredentials,
): Record<string, string> {
  if (!creds.userID) throw new Error('cosy: user id is empty');
  if (!creds.authToken) throw new Error('cosy: auth token is empty');

  const aesKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name,
    aid: '',
    email: creds.email,
  };

  const infoB64 = aesEncryptCbcBase64(JSON.stringify(userInfo), aesKey);
  const cosyKey = rsaEncryptBase64(aesKey);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    version: 'v1',
    requestId: crypto.randomUUID(),
    info: infoB64,
    cosyVersion: COSY_IDE_VERSION,
    ideVersion: '',
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sigPath = computeSignaturePath(requestUrl);
  const bodyBuffer = body === null ? Buffer.alloc(0) : Buffer.from(body);
  const bodyStr = bodyBuffer.toString('utf8');

  const signature = crypto
    .createHash('md5')
    .update(`${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`)
    .digest('hex');

  const bodyHash = crypto.createHash('md5').update(bodyBuffer).digest('hex');

  return {
    Authorization: `Bearer COSY.${payloadB64}.${signature}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': COSY_IDE_VERSION,
    'Cosy-Machineid': creds.machineID,
    'Cosy-Machinetoken': creds.machineID,
    'Cosy-Machinetype': COSY_MACHINE_TYPE,
    'Cosy-Machineos': COSY_MACHINE_OS,
    'Cosy-Clienttype': creds.clientType ?? COSY_CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': String(bodyBuffer.length),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': COSY_DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': COSY_LOGIN_VERSION,
    'X-Request-Id': crypto.randomUUID(),
  };
}

/**
 * Read an existing machine id (so the gateway sees a stable device) or mint and
 * persist one. Losing this file only means the gateway treats the host as a new
 * device; it does not invalidate credentials.
 */
export function getOrCreateMachineId(cacheDir: string): string {
  const path = join(cacheDir, 'machine-id');
  if (existsSync(path)) {
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value) return value;
    } catch {
      // Fall through to generation.
    }
  }
  const id = crypto.randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id, 'utf8');
  } catch {
    // Persistence is best-effort; the in-memory id still signs this process.
  }
  return id;
}

/** Convenience wrapper mapping a stored credential onto the COSY identity shape. */
export function buildCosyHeadersFor(
  body: Buffer | string | null,
  requestUrl: string,
  creds: {
    userID: string;
    jobToken: string;
    name: string;
    email: string;
    machineID: string;
    clientType?: string;
  },
): Record<string, string> {
  return buildCosyHeaders(body, requestUrl, {
    userID: creds.userID,
    authToken: creds.jobToken,
    name: creds.name,
    email: creds.email,
    machineID: creds.machineID,
    ...(creds.clientType ? { clientType: creds.clientType } : {}),
  });
}
