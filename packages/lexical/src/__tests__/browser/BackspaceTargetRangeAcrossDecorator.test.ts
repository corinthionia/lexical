/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Characterization test for the browser behavior behind the block check on
 * the iOS non-collapsed targetRange path in `onBeforeInput`
 * (deleteContentBackward): at the start of a block that follows a
 * contenteditable=false block, the engine reports a targetRange from the end
 * of the previous editable text to the caret, so the range contains the
 * non-editable block. Deleting that range verbatim would delete the block.
 *
 * This is a claim about the engine, not about Lexical, so a real Backspace is
 * pressed against a plain `contenteditable` with no editor attached. It runs
 * on WebKit only, the engine behind IS_IOS; the default CI job is chromium, so
 * the signal comes from the macOS + webkit job in the extended matrix.
 */

import {IS_APPLE_WEBKIT, IS_IOS, IS_SAFARI} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

async function backspaceTargetRange(html: string): Promise<{
  range: StaticRange;
  root: HTMLElement;
}> {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.innerHTML = html;
  document.body.appendChild(root);
  onTestFinished(() => {
    document.body.removeChild(root);
  });

  let range: StaticRange | undefined;
  root.addEventListener('beforeinput', event => {
    if ((event as InputEvent).inputType === 'deleteContentBackward') {
      range = (event as InputEvent).getTargetRanges()[0];
      event.preventDefault();
    }
  });

  const last = root.lastElementChild!;
  const caret = document.createRange();
  caret.setStart(
    last.firstChild!.nodeType === Node.TEXT_NODE ? last.firstChild! : last,
    0,
  );
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(caret);
  root.focus();

  await userEvent.keyboard('{Backspace}');
  expect(range).toBeDefined();
  return {range: range!, root};
}

describe.runIf(IS_SAFARI || IS_IOS || IS_APPLE_WEBKIT)(
  'deleteContentBackward targetRange after a contenteditable=false block',
  () => {
    for (const [name, lastBlock] of [
      ['an empty paragraph', '<p><br></p>'],
      ['a text paragraph', '<p>def</p>'],
    ]) {
      test(`spans the non-editable block from ${name}`, async () => {
        const {range, root} = await backspaceTargetRange(
          `<p>abc</p><div contenteditable="false">X</div>${lastBlock}`,
        );
        const decorator = root.children[1];
        expect(range.collapsed).toBe(false);
        const live = document.createRange();
        live.setStart(range.startContainer, range.startOffset);
        live.setEnd(range.endContainer, range.endOffset);
        expect(live.intersectsNode(decorator)).toBe(true);
      });
    }
  },
);
