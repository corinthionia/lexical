/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Tests for the iOS autocomplete suggestion-bar fix.
 *
 * On iOS, calling event.preventDefault() on the Backspace keydown event
 * prevents the system keyboard from refreshing its suggestion bar. The fix
 * makes KEY_BACKSPACE_COMMAND return false (without calling
 * event.preventDefault() on the keydown) when IS_IOS && CAN_USE_BEFORE_INPUT,
 * delegating the actual deletion to the beforeinput deleteContentBackward
 * handler which already fires on iOS and handles it correctly.
 *
 * Tests verify:
 *  1. KEY_BACKSPACE_COMMAND does NOT call event.preventDefault() on iOS.
 *  2. The full Backspace flow (keydown → beforeinput) still deletes the
 *     correct character, leaving editing behavior unchanged.
 *  3. The indented-block outdent path is NOT affected (it must still
 *     preventDefault to avoid the browser moving the caret to the prev line).
 *  4. The pass-through does NOT apply at the very start of the document,
 *     where WebKit fires no beforeinput to delegate to.
 */

import type {AnyLexicalExtension} from '@lexical/extension';

import {$createCodeNode, CodeExtension} from '@lexical/code';
import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$createTableNodeWithDimensions, TableExtension} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  isDOMTextNode,
  isHTMLElement,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditor,
  type LexicalEditorWithDispose,
} from 'lexical';
import {$assertNodeType, invariant} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test, vi} from 'vitest';

// `vi.mock` is hoisted above all imports, so LexicalEvents.ts /
// LexicalConstants.ts observe IS_IOS=true and CAN_USE_BEFORE_INPUT=true.
// Mock the exact module the core imports relatively (`./environment`); the
// `lexical/src/environment` test alias resolves to that same file.
vi.mock('lexical/src/environment', () => ({
  CAN_USE_BEFORE_INPUT: true,
  CAN_USE_DOM: true,
  IS_ANDROID: false,
  IS_ANDROID_CHROME: false,
  IS_APPLE: true,
  IS_APPLE_WEBKIT: false,
  IS_CHROME: false,
  IS_FIREFOX: false,
  IS_IOS: true,
  IS_SAFARI: false,
}));

/**
 * Creates a mock beforeinput InputEvent whose getTargetRanges() returns
 * a single StaticRange built from the provided DOM boundary points.
 */
function createBeforeInputEvent(
  inputType: string,
  targetRange: StaticRange | null,
): InputEvent {
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType,
  });
  // jsdom InputEvent does not expose getTargetRanges; patch it manually.
  Object.defineProperty(event, 'getTargetRanges', {
    value: () => (targetRange ? [targetRange] : []),
  });
  return event;
}

function createKeyboardEvent(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
  });
}

function getFirstTextElement(editor: LexicalEditor): HTMLElement {
  return editor.read('latest', () => {
    const node = $assertNodeType($getRoot().getFirstDescendant(), $isTextNode);
    const el = editor.getElementByKey(node.getKey());
    assert(isHTMLElement(el));
    return el;
  });
}

/**
 * Replaces the editor content with a single paragraph containing `text`
 * and places a collapsed selection at `cursorOffset`. Returns the text node key.
 */
function editorWithTextNode(
  text: string,
  cursorOffset: null | number,
): LexicalEditorWithDispose {
  return editorWithState(() => {
    const node = $createTextNode(text);
    $getRoot().append($createParagraphNode().append(node));
    if (cursorOffset !== null) {
      node.select(cursorOffset, cursorOffset);
    }
  });
}

/** Builds an editor rooted in a real contenteditable from `$initialEditorState`. */
function editorWithState(
  $initialEditorState: () => void,
  extensions: AnyLexicalExtension[] = [RichTextExtension],
): LexicalEditorWithDispose {
  return buildEditorFromExtensions({
    $initialEditorState,
    afterRegistration: editor => {
      const container = document.createElement('div');
      container.setAttribute('data-lexical-editor', 'true');
      container.contentEditable = 'true';
      document.body.appendChild(container);
      editor.setRootElement(container);
      return () => {
        editor.setRootElement(null);
        document.body.removeChild(container);
      };
    },
    dependencies: extensions,
    name: '[test]',
  });
}

describe('iOS keyboard suggestion-bar fix — KEY_BACKSPACE_COMMAND pass-through', () => {
  // -------------------------------------------------------------------------
  // 1. KEY_BACKSPACE_COMMAND does NOT preventDefault on iOS
  // -------------------------------------------------------------------------

  test('KEY_BACKSPACE_COMMAND returns false and does not call event.preventDefault() on iOS', () => {
    using editor = editorWithTextNode('hello', 5);

    const event = createKeyboardEvent('Backspace');
    const handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);

    // Command must NOT be handled — return false so the keydown default is
    // left uncancelled and iOS can refresh its suggestion bar.
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Full Backspace flow: keydown → beforeinput still deletes correctly
  // -------------------------------------------------------------------------

  test('deleteContentBackward beforeinput with collapsed targetRange deletes one character', () => {
    using editor = editorWithTextNode('hello', 5);

    // Step 1: keydown Backspace (should not preventDefault).
    const keyEvent = createKeyboardEvent('Backspace');
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, keyEvent);
    expect(keyEvent.defaultPrevented).toBe(false);

    // Step 2: iOS fires beforeinput deleteContentBackward with a collapsed
    // targetRange (one character before the cursor).
    const span = getFirstTextElement(editor);
    const textNode = span.firstChild;
    assert(isDOMTextNode(textNode));
    const targetRange = new StaticRange({
      endContainer: textNode,
      endOffset: 5,
      startContainer: textNode,
      startOffset: 4,
    });
    const beforeInputEvent = createBeforeInputEvent(
      'deleteContentBackward',
      targetRange,
    );
    editor.getRootElement()!.dispatchEvent(beforeInputEvent);
    expect(editor.read('force-commit', () => $getRoot().getTextContent())).toBe(
      'hell',
    );
  });

  test('KEY_BACKSPACE_COMMAND does not preventDefault regardless of the language locale', () => {
    // Verify that the fix is not locale-gated: any iOS keyboard (not only
    // Korean) must skip event.preventDefault() on keydown.
    const originalLanguage = navigator.language;
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      get: () => 'en-US',
    });
    using editor = editorWithTextNode('hello', 5);
    try {
      const event = createKeyboardEvent('Backspace');
      const handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        get: () => originalLanguage,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Non-iOS path is unaffected: KEY_BACKSPACE_COMMAND still handles it
  //    (tested indirectly — the mock sets IS_IOS=true throughout this file,
  //    so we verify the ios=false branch in the separate non-iOS test below)
  // -------------------------------------------------------------------------

  test('cursor at start of text does not delete (nothing to delete)', () => {
    using editor = editorWithTextNode('hello', 0);

    const keyEvent = createKeyboardEvent('Backspace');
    // Carve-out applies, but there is nothing before the caret to delete.
    const handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, keyEvent);
    expect(handled).toBe(true);
    expect(keyEvent.defaultPrevented).toBe(true);

    expect(editor.read('force-commit', () => $getRoot().getTextContent())).toBe(
      'hello',
    );
  });

  // -------------------------------------------------------------------------
  // 4. Empty selection: KEY_BACKSPACE_COMMAND returns false (no selection)
  // -------------------------------------------------------------------------

  test('returns false when there is no selection', () => {
    using editor = editorWithTextNode('hello', null);

    const event = createKeyboardEvent('Backspace');
    const handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
    expect(handled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. Integration: multiple Backspaces via beforeinput
  // -------------------------------------------------------------------------

  test('repeated beforeinput deleteContentBackward events delete characters one by one', () => {
    using editor = editorWithTextNode('abc', 3);

    for (let i = 3; i > 0; i--) {
      editor.dispatchCommand(
        KEY_BACKSPACE_COMMAND,
        createKeyboardEvent('Backspace'),
      );

      editor.read('force-commit', () => {
        invariant(
          $isRangeSelection($getSelection()),
          'expected RangeSelection',
        );
        // Advance the cursor position check inline — the beforeinput handler
        // will move the cursor, so just fire the event.
      });

      const span = getFirstTextElement(editor);
      const textNode = span.firstChild;
      if (!isDOMTextNode(textNode)) {
        // All text deleted — done.
        break;
      }
      const targetRange = new StaticRange({
        endContainer: textNode,
        endOffset: i,
        startContainer: textNode,
        startOffset: i - 1,
      });
      editor
        .getRootElement()!
        .dispatchEvent(
          createBeforeInputEvent('deleteContentBackward', targetRange),
        );
    }

    expect(editor.read(() => $getRoot().getTextContent())).toBe('');
  });
});

describe('iOS Backspace at the start of the first block', () => {
  test('an empty first-block quote collapses to a paragraph', () => {
    using editor = editorWithState(() => {
      const quote = $createQuoteNode();
      $getRoot().append(quote);
      quote.select(0, 0);
    });

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    editor.read('force-commit', () => {
      expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
    });
  });

  test('a non-empty first-block quote collapses and keeps its text', () => {
    using editor = editorWithState(() => {
      const text = $createTextNode('quoted');
      $getRoot().append($createQuoteNode().append(text));
      text.select(0, 0);
    });

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    editor.read('force-commit', () => {
      expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
      expect($getRoot().getTextContent()).toBe('quoted');
    });
  });

  // Unlike quote, HeadingNode.collapseAtStart only converts when empty.

  test('an empty first-block heading collapses to a paragraph', () => {
    using editor = editorWithState(() => {
      const heading = $createHeadingNode('h1');
      $getRoot().append(heading);
      heading.select(0, 0);
    });

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    editor.read('force-commit', () => {
      expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
    });
  });

  test('a non-empty first-block heading is handled but does not collapse', () => {
    using editor = editorWithState(() => {
      const text = $createTextNode('title');
      $getRoot().append($createHeadingNode('h1').append(text));
      text.select(0, 0);
    });

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    editor.read('force-commit', () => {
      const first = $getRoot().getFirstChild();
      invariant($isElementNode(first), 'expected an element');
      expect(first.getType()).toBe('heading');
      expect($getRoot().getTextContent()).toBe('title');
    });
  });

  // A different node package on the same generic DELETE_CHARACTER_COMMAND
  // path: @lexical/code registers no Backspace handler of its own, so without
  // the carve-out this position does nothing on iOS.
  test('a non-empty first-block code node collapses to a paragraph', () => {
    using editor = editorWithState(() => {
      const text = $createTextNode('const x = 1;');
      $getRoot().append($createCodeNode().append(text));
      text.select(0, 0);
    }, [RichTextExtension, CodeExtension]);

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    editor.read('force-commit', () => {
      expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
      expect($getRoot().getTextContent()).toBe('const x = 1;');
    });
  });

  test('an indented first-block quote still outdents instead of collapsing', () => {
    // The outdent branch runs before the iOS pass-through, so both predicates
    // are true here and source order decides.
    using editor = editorWithState(() => {
      const quote = $createQuoteNode().append($createTextNode('quoted'));
      quote.setIndent(1);
      $getRoot().append(quote);
      quote.selectStart();
    });

    expect(
      editor.dispatchCommand(
        KEY_BACKSPACE_COMMAND,
        createKeyboardEvent('Backspace'),
      ),
    ).toBe(true);
    editor.read('force-commit', () => {
      const first = $getRoot().getFirstChild();
      invariant($isElementNode(first), 'expected an element');
      expect(first.getType()).toBe('quote');
      expect(first.getIndent()).toBe(0);
    });
  });

  // Below: beforeinput does fire at these positions, so handling the keydown
  // too would delete twice.

  test('the start of a later block passes through', () => {
    using editor = editorWithState(() => {
      const text = $createTextNode('tail');
      $getRoot().append(
        $createQuoteNode().append($createTextNode('quoted')),
        $createParagraphNode().append(text),
      );
      text.select(0, 0);
    });

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test('a non-collapsed selection anchored at the first block start passes through', () => {
    using editor = editorWithState(() => {
      const text = $createTextNode('quoted');
      $getRoot().append($createQuoteNode().append(text));
      text.select(0, 3);
    });

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test('a later child of the first block passes through', () => {
    using editor = editorWithState(() => {
      const second = $createTextNode('second');
      $getRoot().append(
        $createQuoteNode().append(
          $createParagraphNode().append($createTextNode('first')),
          $createParagraphNode().append(second),
        ),
      );
      second.select(0, 0);
    });

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test('the first cell of a leading table passes through', () => {
    // $isAtStartOfNode alone matches here (it does not stop at shadow roots);
    // the guard's root-or-shadow-root check is what keeps the carve-out off.
    using editor = editorWithState(() => {
      const table = $createTableNodeWithDimensions(2, 2, false);
      $getRoot().append(
        table,
        $createParagraphNode().append($createTextNode('after')),
      );
      table.getFirstDescendant()?.selectStart();
    }, [RichTextExtension, TableExtension]);

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test('the start of a shadow-root block mid-document passes through', () => {
    using editor = editorWithState(() => {
      const inner = $createTextNode('inner');
      $getRoot().append(
        $createParagraphNode().append($createTextNode('first')),
        $createQuoteNode({shadowRoot: true}).append(
          $createParagraphNode().append(inner),
        ),
      );
      inner.select(0, 0);
    });

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('@lexical/plain-text carries the same carve-out', () => {
  // plain-text registers no nodes of its own, so ParagraphNode's is the only
  // collapseAtStart that can run: a blank first paragraph before another block.

  test('a blank first paragraph before another block is removed', () => {
    using editor = editorWithState(() => {
      const blank = $createParagraphNode();
      $getRoot().append(
        blank,
        $createParagraphNode().append($createTextNode('tail')),
      );
      blank.select(0, 0);
    }, [PlainTextExtension]);

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    editor.read('force-commit', () => {
      expect($getRoot().getChildrenSize()).toBe(1);
      expect($getRoot().getTextContent()).toBe('tail');
    });
  });

  test('the start of a later paragraph passes through', () => {
    using editor = editorWithState(() => {
      const tail = $createTextNode('tail');
      $getRoot().append(
        $createParagraphNode().append($createTextNode('first')),
        $createParagraphNode().append(tail),
      );
      tail.select(0, 0);
    }, [PlainTextExtension]);

    const event = createKeyboardEvent('Backspace');
    expect(editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
