import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDeployOutput, previewLink } from './preview.ts';

const PROJECT = 'ranksmith-connectmachine';
const ESC = String.fromCharCode(27);

describe('reading the deployment URL out of wrangler', () => {
  it('takes the deployment URL, not the branch alias', () => {
    const output = [
      '🌎  Uploading... (12/12)',
      '✨ Success! Uploaded 12 files (1.20 sec)',
      '✨ Deployment complete! Take a peek over at https://a1b2c3d4.ranksmith-connectmachine.pages.dev',
      '✨ Deployment alias URL: https://feat-seo-crm-mcp.ranksmith-connectmachine.pages.dev',
    ].join('\n');

    assert.equal(parseDeployOutput(output, PROJECT), 'https://a1b2c3d4.ranksmith-connectmachine.pages.dev');
  });

  it('still finds the URL when the deploy went to the production branch and has no alias', () => {
    const output = '✨ Deployment complete! Take a peek over at https://ff00aa11.ranksmith-connectmachine.pages.dev\n';

    assert.equal(parseDeployOutput(output, PROJECT), 'https://ff00aa11.ranksmith-connectmachine.pages.dev');
  });

  it('ignores colour codes around the line', () => {
    const output = `${ESC}[32m✨ Deployment complete! Take a peek over at https://a1b2c3d4.ranksmith-connectmachine.pages.dev${ESC}[0m`;

    assert.equal(parseDeployOutput(output, PROJECT), 'https://a1b2c3d4.ranksmith-connectmachine.pages.dev');
  });

  it('returns null when wrangler printed no deployment, or one for another project', () => {
    assert.equal(parseDeployOutput('✘ [ERROR] A request to the Cloudflare API failed.', PROJECT), null);
    assert.equal(parseDeployOutput('✨ Deployment complete! Take a peek over at https://a1b2c3d4.other.pages.dev', PROJECT), null);
    assert.equal(parseDeployOutput('Deployment alias URL: https://feat.ranksmith-connectmachine.pages.dev', PROJECT), null);
  });
});

describe('choosing the link a reviewer opens', () => {
  const deploy = 'https://a1b2c3d4.ranksmith-connectmachine.pages.dev';

  it('points at the changed page when the build has it', () => {
    assert.equal(previewLink(deploy, '/blog/crm-mcp-servers-compared/', true), `${deploy}/blog/crm-mcp-servers-compared/`);
  });

  it('joins one slash however the two halves are written', () => {
    assert.equal(previewLink(`${deploy}/`, '/blog/post', true), `${deploy}/blog/post`);
    assert.equal(previewLink(`${deploy}/`, 'blog/post', true), `${deploy}/blog/post`);
  });

  it('falls back to the site root when the page is missing from the build or was never named', () => {
    assert.equal(previewLink(deploy, '/blog/nope/', false), deploy);
    assert.equal(previewLink(`${deploy}/`, null, true), deploy);
  });
});
