import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TUNNEL_FAILED, TUNNEL_REGISTERED, TUNNEL_URL, waitReachable } from './preview.ts';
import { isTransient } from './retry.ts';

describe('holding the preview URL back until it answers', () => {
  it('asks Cloudflare DNS first and probes over HTTP only once the record exists', async () => {
    const dns = [false, false, true];
    const http: (number | null)[] = [530, 200];
    const order: string[] = [];
    await waitReachable('https://x.trycloudflare.com/', {
      pollMs: 1,
      resolve: async (host) => {
        order.push(`dns ${host}`);
        return dns.shift() ?? true;
      },
      probe: async () => {
        order.push('http');
        const next = http.shift();
        return next === undefined ? 200 : next;
      },
    });
    assert.deepEqual(order, ['dns x.trycloudflare.com', 'dns x.trycloudflare.com', 'dns x.trycloudflare.com', 'http', 'http']);
  });

  it('gives up on a name Cloudflare never publishes, as a temporary error', async () => {
    await assert.rejects(
      waitReachable('https://x.trycloudflare.com', { resolveTimeoutMs: 5, pollMs: 1, resolve: async () => false }),
      (error: Error) => isTransient(error) && /no record/.test(error.message),
    );
  });

  it('gives up on a name that resolves but never answers, as a temporary error', async () => {
    await assert.rejects(
      waitReachable('https://x.trycloudflare.com', { timeoutMs: 5, pollMs: 1, resolve: async () => true, probe: async () => 530 }),
      (error: Error) => isTransient(error) && /HTTP 530/.test(error.message),
    );
  });
});

describe('reading cloudflared output', () => {
  it('recognises the registration line that means traffic can flow', () => {
    assert.match(
      'INF Registered tunnel connection connIndex=0 connection=ebe38fe6 event=0 ip=198.41.192.77 location=arn06 protocol=quic',
      TUNNEL_REGISTERED,
    );
  });
});

describe('reading the preview URL out of cloudflared', () => {
  it('takes the quick tunnel hostname', () => {
    const line = '|  https://dad-amendment-promptly-run.trycloudflare.com  |';
    assert.equal(line.match(TUNNEL_URL)?.[0], 'https://dad-amendment-promptly-run.trycloudflare.com');
  });

  it('never takes the API host cloudflared names when the request fails', () => {
    const line =
      'ERR failed to request quick Tunnel error="Post \\"https://api.trycloudflare.com/tunnel\\": context deadline exceeded"';
    assert.equal(line.match(TUNNEL_URL), null);
    assert.match(line, TUNNEL_FAILED);
  });

  it('reports that failure in words the retry policy treats as temporary', () => {
    assert.ok(isTransient(new Error('cloudflared exited early: ERR failed to request quick Tunnel')));
  });
});
