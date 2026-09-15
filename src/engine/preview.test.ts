import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TUNNEL_FAILED, TUNNEL_URL } from './preview.ts';
import { isTransient } from './retry.ts';

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
