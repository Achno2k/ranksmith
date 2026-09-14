import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { downloadAttachments, type SlackFile } from './attachments.ts';

const botToken = 'xoxb-test-token';

describe('downloading Slack attachments', () => {
  it('downloads files with a private download URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ranksmith-attachments-test-'));
    try {
      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        assert.equal(url, 'https://files.slack.test/download/1');
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          arrayBuffer: async () => new TextEncoder().encode('hello world').buffer,
        } as Response;
      };

      const files: SlackFile[] = [
        { id: 'F1', name: 'notes.md', mimetype: 'text/markdown', url_private_download: 'https://files.slack.test/download/1' },
      ];

      try {
        const attachments = await downloadAttachments(files, dir, botToken);

        assert.equal(attachments.length, 1);
        assert.equal(attachments[0]?.name, 'notes.md');
        assert.equal(attachments[0]?.mimetype, 'text/markdown');
        assert.equal(attachments[0]?.sourcePath, join(dir, 'notes.md'));
        assert.equal(await readFile(join(dir, 'notes.md'), 'utf8'), 'hello world');
      } finally {
        global.fetch = originalFetch;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to url_private when url_private_download is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ranksmith-attachments-test-'));
    try {
      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          arrayBuffer: async () => new TextEncoder().encode('image bytes').buffer,
        } as Response);

      const files: SlackFile[] = [
        { id: 'F2', name: 'screenshot.png', mimetype: 'image/png', url_private: 'https://files.slack.test/private/2' },
      ];

      try {
        const attachments = await downloadAttachments(files, dir, botToken);

        assert.equal(attachments.length, 1);
        assert.equal(attachments[0]?.name, 'screenshot.png');
      } finally {
        global.fetch = originalFetch;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips files without any private URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ranksmith-attachments-test-'));
    try {
      const files: SlackFile[] = [{ id: 'F3', name: 'orphan.txt', mimetype: 'text/plain' }];

      const attachments = await downloadAttachments(files, dir, botToken);

      assert.equal(attachments.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes filenames so they are safe on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ranksmith-attachments-test-'));
    try {
      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response);

      const files: SlackFile[] = [
        { id: 'F4', name: '../../etc/passwd', mimetype: 'text/plain', url_private_download: 'https://files.slack.test/4' },
      ];

      try {
        const attachments = await downloadAttachments(files, dir, botToken);

        assert.equal(attachments[0]?.name, '.._.._etc_passwd');
        assert.equal(attachments[0]?.sourcePath, join(dir, '.._.._etc_passwd'));
      } finally {
        global.fetch = originalFetch;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
