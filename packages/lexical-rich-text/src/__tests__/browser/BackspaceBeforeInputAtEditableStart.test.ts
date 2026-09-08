/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Characterization tests for the browser assumption behind the iOS Backspace
 * carve-out: WebKit fires no `beforeinput` when nothing precedes the caret in
 * the editing host, so the pass-through has nothing to delegate to there
 * (#5841, #8725).
 *
 * That is a claim about the engine, not about Lexical, so these press a real
 * Backspace against a bare `contenteditable`: going through Lexical would
 * suppress the very `beforeinput` being measured.
 *
 * A failing case in either direction means the engine assumption behind the
 * carve-out no longer holds.
 * Run with `VITEST_BROWSER=webkit` — the default CI job is chromium only.
 */

import {IS_APPLE_WEBKIT, IS_IOS, IS_SAFARI} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// WebKit stays silent when nothing precedes the caret;
// Chromium and Firefox both fire there.
const FIRES_WHEN_NOTHING_PRECEDES_CARET = !(
  IS_SAFARI ||
  IS_IOS ||
  IS_APPLE_WEBKIT
);

/**
 * Presses Backspace with the caret at `offset` inside `caretIn`, and reports
 * whether the engine asked for the deletion via `beforeinput`.
 */
async function firesDeleteContentBackward(
  html: string,
  caretIn: (root: HTMLElement) => Node,
  offset: number,
): Promise<boolean> {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.innerHTML = html;
  document.body.appendChild(root);

  let fired = false;
  const record = (event: Event) => {
    if ((event as InputEvent).inputType === 'deleteContentBackward') {
      fired = true;
    }
  };
  root.addEventListener('beforeinput', record);
  onTestFinished(() => {
    root.removeEventListener('beforeinput', record);
    document.body.removeChild(root);
  });

  // Focus first: taking focus programmatically can renormalize the selection
  // (WebKit moves the caret to the editing host's start).
  root.focus();

  const caretNode = caretIn(root);
  const range = document.createRange();
  range.setStart(caretNode, offset);
  range.collapse(true);
  const selection = window.getSelection();
  if (selection === null) {
    throw new Error('expected a DOM selection');
  }
  selection.removeAllRanges();
  selection.addRange(range);

  // Without this the file is non-discriminating in chromium, where every
  // expectation below is `true` wherever the caret landed.
  expect(selection.anchorNode).toBe(caretNode);
  expect(selection.anchorOffset).toBe(offset);

  await userEvent.keyboard('{Backspace}');
  return fired;
}

const quoteText = (root: HTMLElement) =>
  root.querySelector('blockquote')!.firstChild!;
const quote = (root: HTMLElement) => root.querySelector('blockquote')!;
const cellText = (root: HTMLElement) => root.querySelector('td p')!.firstChild!;

describe('native beforeinput for Backspace', () => {
  // Controls: wherever something precedes the caret, every engine asks first.
  test('fires in the middle of a text node', async () => {
    expect(
      await firesDeleteContentBackward(
        '<blockquote>abc</blockquote><p>tail</p>',
        quoteText,
        2,
      ),
    ).toBe(true);
  });

  test('fires at the start of a later block', async () => {
    expect(
      await firesDeleteContentBackward(
        '<p>first</p><blockquote>abc</blockquote>',
        quoteText,
        0,
      ),
    ).toBe(true);
  });

  // The carve-out: nothing precedes the caret, and WebKit stays silent.
  test('start of a non-empty first block', async () => {
    expect(
      await firesDeleteContentBackward(
        '<blockquote>abc</blockquote><p>tail</p>',
        quoteText,
        0,
      ),
    ).toBe(FIRES_WHEN_NOTHING_PRECEDES_CARET);
  });

  test('start of an empty first block', async () => {
    expect(
      await firesDeleteContentBackward(
        '<blockquote><br></blockquote><p>tail</p>',
        quote,
        0,
      ),
    ).toBe(FIRES_WHEN_NOTHING_PRECEDES_CARET);
  });

  // The rule is "nothing precedes the caret", not "the caret is top-level":
  // `$isSelectionCollapsedAtStartOfDocument` deliberately does not match
  // this position.
  test('start of the first cell of a leading table', async () => {
    expect(
      await firesDeleteContentBackward(
        '<table><tbody><tr><td><p>cell</p></td><td><p>b</p></td></tr></tbody></table><p>tail</p>',
        cellText,
        0,
      ),
    ).toBe(FIRES_WHEN_NOTHING_PRECEDES_CARET);
  });
});
