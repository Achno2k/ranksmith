import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TUNNEL_FAILED, TUNNEL_URL, waitReachable } from './preview.ts';
import { isTransient } from './retry.ts';

describe('holding the preview URL back until it answers', () => {
  it('waits through unresolvable and 530 answers and returns on the first real one', async () => {
    const answers: (number | null)[] = [null, 530, 200];
    const seen: string[] = [];
    await waitReachable('https://x.trycloudflare.com', {
      pollMs: 1,
      probe: async (url) => {
        seen.push(url);
        const next = answers.shift();
        return next === undefined ? 200 : next;
      },
    });
    assert.equal(seen.length, 3);
  });

  it('gives up with a temporary error so the Engine retries the preview step', async () => {
    await assert.rejects(
      waitReachable('https://x.trycloudflare.com', { timeoutMs: 5, pollMs: 1, probe: async () => null }),
      (error: Error) => isTransient(error) && /not resolvable/.test(error.message),
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
