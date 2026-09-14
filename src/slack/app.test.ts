import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isStopCommand, promptFromMention, threadForMention } from './app.ts';

describe('placing a mentioned Job', () => {
  it('uses a root mention as the pipeline thread', () => {
    assert.equal(threadForMention({ ts: '100.001' }), '100.001');
  });

  it('keeps a threaded mention in its existing thread', () => {
    assert.equal(threadForMention({ ts: '100.002', thread_ts: '100.001' }), '100.001');
  });
});

describe('recognizing an explicit stop command', () => {
  it('accepts stop by itself regardless of case or trailing punctuation', () => {
    assert.equal(isStopCommand('stop'), true);
    assert.equal(isStopCommand('STOP!'), true);
  });

  it('does not cancel ordinary content requests that happen to contain stop', () => {
    assert.equal(isStopCommand('research when users stop following up'), false);
    assert.equal(isStopCommand('stop comparing NFC cards and software'), false);
  });
});

describe('parsing an app mention', () => {
  it('turns a direct mention into a research prompt', () => {
    assert.equal(
      promptFromMention('<@URANKSMITH> research event lead capture', 'URANKSMITH'),
      'research event lead capture',
    );
  });

  it('works when RankSmith is mentioned in the middle of a sentence', () => {
    assert.equal(
      promptFromMention('Please <@URANKSMITH> compare digital card platforms', 'URANKSMITH'),
      'Please compare digital card platforms',
    );
  });

  it('preserves mentions of people who are part of the prompt', () => {
    assert.equal(
      promptFromMention('<@URANKSMITH> use the brief from <@UREVIEWER>', 'URANKSMITH'),
      'use the brief from <@UREVIEWER>',
    );
  });

  it('falls back to the first mention when Bolt has no bot user ID', () => {
    assert.equal(promptFromMention('<@URANKSMITH> find a topic', undefined), 'find a topic');
  });
});
