import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyHost, readAccessConfig, resetAccessKeyCache, verifyAccessJwt, type AccessConfig, type JwksFetcher } from './access-guard';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'aud-tag-0123456789abcdef';
const config: AccessConfig = { publicHost: 'lookout.example.com', teamDomain: TEAM, audience: AUD, allowedEmails: ['owner@example.com'] };
const NOW = Date.UTC(2026, 8, 17, 8, 0, 0);

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : data).toString('base64url');

let good: CryptoKeyPair;
let stranger: CryptoKeyPair;
let jwks: { keys: (JsonWebKey & { kid: string })[] };

async function keyPair() {
  return crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
}

async function sign(claims: Record<string, unknown>, { key = good.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const head = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000), email: 'Owner@Example.com', ...over,
});

const fetchJwks: JwksFetcher = async () => jwks;
const verify = (token: string | null, cfg = config) => verifyAccessJwt(token, cfg, { now: NOW, fetchJwks });

beforeAll(async () => {
  good = await keyPair();
  stranger = await keyPair();
  jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', good.publicKey)), kid: 'k1' }] };
});
beforeEach(() => resetAccessKeyCache());

describe('classifyHost', () => {
  it('recognises loopback in every spelling, with or without a port', () => {
    for (const h of ['127.0.0.1:4610', 'localhost:4610', 'LOCALHOST', '[::1]:4610', '[::1]']) expect(classifyHost(h, 'lookout.example.com')).toBe('loopback');
  });
  it('recognises the public hostname only when one is configured', () => {
    expect(classifyHost('Lookout.Example.com', 'lookout.example.com')).toBe('public');
    expect(classifyHost('lookout.example.com', '')).toBe('other');
  });
  it('treats LAN addresses, Bonjour names, look-alikes and a missing header as other', () => {
    // A bare ::1 is not a legal Host header (IPv6 must be bracketed), so it is refused too.
    for (const h of ['192.168.1.180:4610', 'm5max.local:4610', 'lookout.example.com.evil.net', '127.0.0.1.evil.net', '::1', '', null]) {
      expect(classifyHost(h, 'lookout.example.com')).toBe('other');
    }
  });
});

describe('readAccessConfig', () => {
  it('normalises what the environment gives it', () => {
    expect(readAccessConfig({ LOOKOUT_PUBLIC_HOST: ' Lookout.Example.com ', LOOKOUT_CF_TEAM_DOMAIN: 'https://Example.cloudflareaccess.com/', LOOKOUT_CF_ACCESS_AUD: ` ${AUD} `, LOOKOUT_ALLOWED_EMAILS: 'A@x.com, b@x.com ,' }))
      .toEqual({ publicHost: 'lookout.example.com', teamDomain: TEAM, audience: AUD, allowedEmails: ['a@x.com', 'b@x.com'] });
  });
});

describe('verifyAccessJwt', () => {
  it('accepts a correctly signed token for this application and owner', async () => {
    expect(await verify(await sign(claims()))).toEqual({ ok: true, email: 'owner@example.com' });
  });

  it('fails closed when verification is not configured', async () => {
    const token = await sign(claims());
    expect((await verify(token, { ...config, audience: '' })).ok).toBe(false);
    expect((await verify(token, { ...config, teamDomain: '' })).ok).toBe(false);
  });

  it('rejects a missing or malformed token', async () => {
    for (const t of [null, '', 'abc', 'a.b', 'a.b.c']) expect((await verify(t)).ok).toBe(false);
  });

  it('rejects a token signed by someone else, even with a known key id', async () => {
    expect(await verify(await sign(claims(), { key: stranger.privateKey }))).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects a payload swapped under a genuine signature', async () => {
    const [h, , s] = (await sign(claims())).split('.');
    const forged = `${h}.${b64url(JSON.stringify(claims({ email: 'intruder@example.com' })))}.${s}`;
    expect((await verify(forged)).ok).toBe(false);
  });

  it('refuses any algorithm but RS256, including "none"', async () => {
    const head = b64url(JSON.stringify({ alg: 'none', kid: 'k1' }));
    expect((await verify(`${head}.${b64url(JSON.stringify(claims()))}.`)).ok).toBe(false);
    expect((await verify(await sign(claims(), { alg: 'HS256' }))).ok).toBe(false);
  });

  it('rejects a token minted for a different Access application', async () => {
    expect(await verify(await sign(claims({ aud: ['some-other-app'] })))).toEqual({ ok: false, reason: 'token is for a different application' });
  });

  it('rejects the wrong issuer and an expired token', async () => {
    expect((await verify(await sign(claims({ iss: 'https://evil.cloudflareaccess.com' })))).ok).toBe(false);
    expect(await verify(await sign(claims({ exp: Math.floor(NOW / 1000) - 1 })))).toEqual({ ok: false, reason: 'token expired' });
  });

  it('rejects an identity that is not on the allow list, and admits anyone when the list is empty', async () => {
    const token = await sign(claims({ email: 'guest@example.com' }));
    expect(await verify(token)).toEqual({ ok: false, reason: 'identity not allowed' });
    expect(await verify(token, { ...config, allowedEmails: [] })).toEqual({ ok: true, email: 'guest@example.com' });
  });

  it('refetches signing keys once when it meets an unknown key id (rotation)', async () => {
    let calls = 0;
    const rotating: JwksFetcher = async () => (++calls === 1 ? { keys: [] } : jwks);
    expect((await verifyAccessJwt(await sign(claims()), config, { now: NOW, fetchJwks: rotating })).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('fails closed when the signing keys cannot be loaded', async () => {
    const down: JwksFetcher = async () => { throw new Error('network down'); };
    const verdict = await verifyAccessJwt(await sign(claims()), config, { now: NOW, fetchJwks: down });
    expect(verdict.ok).toBe(false);
  });
});
