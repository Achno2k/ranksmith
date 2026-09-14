import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttachmentInput } from '../engine/jobs.ts';

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private?: string;
  url_private_download?: string;
}

/**
 * Downloads Slack files into a directory and returns metadata the Engine can copy into
 * the Job's workspace. Files without a private download URL are skipped — public URLs
 * are rare in practice and usually mean the file is already hosted elsewhere.
 */
export async function downloadAttachments(
  files: SlackFile[],
  destinationDir: string,
  botToken: string,
): Promise<AttachmentInput[]> {
  if (files.length === 0) return [];
  await mkdir(destinationDir, { recursive: true });

  const attachments: AttachmentInput[] = [];
  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      console.error(`[attachments] skipping ${file.name}: no private URL`);
      continue;
    }

    const filename = sanitizeFilename(file.name);
    const target = join(destinationDir, filename);

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!response.ok) {
        console.error(`[attachments] failed to download ${file.name}: ${response.status} ${response.statusText}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(target, buffer);
      attachments.push({ name: filename, mimetype: file.mimetype, sourcePath: target });
    } catch (error) {
      console.error(`[attachments] error downloading ${file.name}:`, error);
    }
  }

  return attachments;
}

function sanitizeFilename(name: string): string {
  // Keep the name readable but avoid path traversal and shell-unfriendly characters.
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
