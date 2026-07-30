import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MakaTool } from '@maka/runtime';
import { computerUseToolsForModel } from '../computer-use-model-tools.js';

const tool = (name: string): MakaTool => ({ name } as MakaTool);

describe('Computer Use model tool visibility', () => {
  const computer = tool('maka_computer');
  const shell = tool('Bash');

  it('removes screenshot-returning Computer Use tools for text-only models', () => {
    assert.deepEqual(
      computerUseToolsForModel([shell, computer], [computer], false).map((candidate) => candidate.name),
      ['Bash'],
    );
  });

  it('preserves the complete tool surface for visual models', () => {
    assert.deepEqual(
      computerUseToolsForModel([shell, computer], [computer], true).map((candidate) => candidate.name),
      ['Bash', 'maka_computer'],
    );
  });

  it('withholds the tools entirely until the user turns Computer Use on', () => {
    // A different reason from the vision filter, and a heavier one: a model
    // without vision would waste the turn, but a user who has not turned this
    // on has not agreed to Maka reading their screen and pressing their buttons
    // at all. Withheld from the surface rather than refused at dispatch, so a
    // model never sees a capability it may not use.
    assert.deepEqual(
      computerUseToolsForModel([shell, computer], [computer], true, false).map(
        (candidate) => candidate.name,
      ),
      ['Bash'],
    );
    assert.deepEqual(
      computerUseToolsForModel([shell, computer], [computer], true, true).map(
        (candidate) => candidate.name,
      ),
      ['Bash', 'maka_computer'],
    );
  });
});
