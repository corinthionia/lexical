/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Tests for the iOS 10-key (천지인/Chunjiin) Korean IME fix.
 *
 * The iOS 10-key keyboard does NOT fire compositionstart/compositionend.
 * Instead it sends:
 *   1. beforeinput deleteContentBackward with a non-collapsed targetRange
 *   2. beforeinput insertText with the updated syllable
 *
 * Because editor.isComposing() is always false, Lexical would previously
 * dispatch DELETE_CHARACTER_COMMAND which ignores targetRange and deletes
 * the wrong character, leaving orphaned jamo in the editor.
 *
 * The fix applies the targetRange directly via selection.applyDOMRange()
 * when on iOS with a non-collapsed targetRange that stays within one block and
 * contains no decorator. Any other range falls back to DELETE_CHARACTER_COMMAND,
 * so iOS deletes exactly like the other platforms.
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  DELETE_CHARACTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type Point,
} from 'lexical';
import {
  $createTestDecoratorNode,
  invariant,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

class IsolatedDecoratorNode extends TestDecoratorNode {
  $config() {
    return this.config('isolated_decorator', {extends: TestDecoratorNode});
  }

  isIsolated(): boolean {
    return true;
  }
}

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

function mountEditor() {
  const container = document.createElement('div');
  container.contentEditable = 'true';
  document.body.appendChild(container);
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [TestDecoratorNode, IsolatedDecoratorNode],
  });
  editor.setRootElement(container);
  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });
  return {container, editor};
}

function getDOMTextNode(editor: LexicalEditor, textKey: string): Text {
  const span = editor.getElementByKey(textKey);
  assert(span !== null, 'span is null');
  const textNode = span.firstChild;
  assert(
    textNode !== null && textNode.nodeType === Node.TEXT_NODE,
    'expected DOM text node',
  );
  return textNode as Text;
}

function createBeforeInputEvent(
  inputType: string,
  targetRange: StaticRange | null,
): InputEvent {
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType,
  });
  Object.defineProperty(event, 'getTargetRanges', {
    value: () => (targetRange ? [targetRange] : []),
  });
  return event;
}

function createStaticRange(
  startContainer: Node,
  startOffset: number,
  endContainer: Node,
  endOffset: number,
): StaticRange {
  return new StaticRange({
    endContainer,
    endOffset,
    startContainer,
    startOffset,
  });
}

async function setSingleTextNode(
  editor: LexicalEditor,
  text: string,
  cursorOffset: number,
): Promise<string> {
  let textKey = '';
  await editor.update(() => {
    const paragraph = $createParagraphNode();
    const node = $createTextNode(text);
    paragraph.append(node);
    $getRoot().clear().append(paragraph);
    textKey = node.getKey();

    const sel = $createRangeSelection();
    sel.anchor.set(textKey, cursorOffset, 'text');
    sel.focus.set(textKey, cursorOffset, 'text');
    $setSelection(sel);
  });
  return textKey;
}

describe('iOS 10-key Korean IME — deleteContentBackward with targetRange', () => {
  test('applyDOMRange resolves a range over in-progress Korean jamo', async () => {
    const {editor} = mountEditor();
    const composingText = '안녕하ᄉᆞ';
    const textKey = await setSingleTextNode(editor, composingText, 5);

    const domText = getDOMTextNode(editor, textKey);
    const targetRange = createStaticRange(domText, 3, domText, 5);

    await editor.update(() => {
      const sel = $getSelection();
      invariant($isRangeSelection(sel), 'expected RangeSelection');
      sel.applyDOMRange(targetRange);

      expect(sel.anchor.key).toBe(textKey);
      expect(sel.anchor.offset).toBe(3);
      expect(sel.focus.key).toBe(textKey);
      expect(sel.focus.offset).toBe(5);
      expect(sel.isCollapsed()).toBe(false);
    });
  });

  test('applyDOMRange + removeText leaves only the assembled syllables', async () => {
    const {editor} = mountEditor();
    const composingText = '안녕하ᄉᆞ';
    const textKey = await setSingleTextNode(editor, composingText, 5);

    const domText = getDOMTextNode(editor, textKey);
    const targetRange = createStaticRange(domText, 3, domText, 5);

    await editor.update(() => {
      const sel = $getSelection();
      invariant($isRangeSelection(sel), 'expected RangeSelection');
      sel.applyDOMRange(targetRange);
      sel.removeText();
    });

    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('안녕하');
    });
  });

  test('deleteContentBackward with non-collapsed targetRange deletes the targetRange text', async () => {
    const {container, editor} = mountEditor();
    const composingText = '안녕하ᄉᆞ';
    const textKey = await setSingleTextNode(editor, composingText, 5);

    const domText = getDOMTextNode(editor, textKey);
    const targetRange = createStaticRange(domText, 3, domText, 5);
    const event = createBeforeInputEvent('deleteContentBackward', targetRange);

    container.dispatchEvent(event);

    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('안녕하');
    });
  });

  test('applyDOMRange with collapsed targetRange leaves selection collapsed — iOS fast path is skipped', async () => {
    const {editor} = mountEditor();
    const text = '안녕하세요';
    const textKey = await setSingleTextNode(editor, text, 5);

    const domText = getDOMTextNode(editor, textKey);

    await editor.update(() => {
      const sel = $getSelection();
      invariant($isRangeSelection(sel), 'expected RangeSelection');
      const collapsedRange = createStaticRange(domText, 5, domText, 5);
      sel.applyDOMRange(collapsedRange);
      expect(sel.isCollapsed()).toBe(true);
    });

    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('안녕하세요');
    });
  });

  test('applyDOMRange handles a targetRange that straddles two adjacent text nodes', async () => {
    const {editor} = mountEditor();
    let key1 = '';
    let key2 = '';

    await editor.update(() => {
      const paragraph = $createParagraphNode();
      const node1 = $createTextNode('안녕').setStyle('--x:0');
      const node2 = $createTextNode('하세요');
      paragraph.append(node1, node2);
      $getRoot().clear().append(paragraph);
      key1 = node1.getKey();
      key2 = node2.getKey();

      const sel = $createRangeSelection();
      sel.anchor.set(key2, 3, 'text');
      sel.focus.set(key2, 3, 'text');
      $setSelection(sel);
    });

    const domText1 = getDOMTextNode(editor, key1);
    const domText2 = getDOMTextNode(editor, key2);
    const straddleRange = createStaticRange(domText1, 1, domText2, 1);

    await editor.update(() => {
      const sel = $getSelection();
      invariant($isRangeSelection(sel), 'expected RangeSelection');
      sel.applyDOMRange(straddleRange);

      expect(sel.anchor.key).toBe(key1);
      expect(sel.anchor.offset).toBe(1);
      expect(sel.focus.key).toBe(key2);
      expect(sel.focus.offset).toBe(1);
      expect(sel.isCollapsed()).toBe(false);

      sel.removeText();
    });

    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('안세요');
    });
  });
});

// Node keys differ between the two editors a case is run in, so a point is
// identified by its index path from the root rather than by key.
function pointSnapshot(point: Point) {
  const path = [];
  for (
    let node = point.getNode();
    node.getParent() !== null;
    node = node.getParent()!
  ) {
    path.unshift(node.getIndexWithinParent());
  }
  return {
    offset: point.offset,
    path: path.join('/'),
    text: point.getNode().getTextContent(),
    type: point.type,
  };
}

function snapshot(editor: LexicalEditor) {
  return editor.read(() => {
    const selection = $getSelection();
    return {
      json: editor.getEditorState().toJSON(),
      selection: $isNodeSelection(selection)
        ? {nodes: selection.getNodes().map(n => n.getType())}
        : $isRangeSelection(selection)
          ? {
              anchor: pointSnapshot(selection.anchor),
              focus: pointSnapshot(selection.focus),
              isCollapsed: selection.isCollapsed(),
            }
          : null,
    };
  });
}

describe('iOS deleteContentBackward with a targetRange that DELETE_CHARACTER_COMMAND would treat differently', () => {
  // WebKit reports a range from the previous editable position to the caret,
  // skipping any contenteditable=false node in between. Each case runs the same
  // document through the iOS targetRange path and through
  // DELETE_CHARACTER_COMMAND (what every other platform does).
  async function compare(
    setUp: () => void,
    getTargetRange: (root: HTMLElement) => StaticRange,
  ) {
    const ios = mountEditor();
    await ios.editor.update(setUp);
    ios.container.dispatchEvent(
      createBeforeInputEvent(
        'deleteContentBackward',
        getTargetRange(ios.container),
      ),
    );
    const other = mountEditor();
    await other.editor.update(setUp);
    await other.editor.update(() => {
      other.editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    return {actual: snapshot(ios.editor), expected: snapshot(other.editor)};
  }

  // [paragraph "abc"] ...blocks, caret at the start of the last block.
  function $abcThen(...blocks: LexicalNode[]) {
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createTextNode('abc')), ...blocks);
    blocks[blocks.length - 1].selectStart();
  }

  // What WebKit reports here: the end of "abc" to the start of the last block.
  const fromAbcEnd = (root: HTMLElement) =>
    createStaticRange(
      root.querySelector('span')!.firstChild!,
      3,
      root.lastElementChild!,
      0,
    );

  test('keeps the block decorator and selects it when backspacing an empty paragraph after it', async () => {
    const {actual, expected} = await compare(
      () =>
        $abcThen(
          $createTestDecoratorNode().setIsInline(false),
          $createParagraphNode(),
        ),
      fromAbcEnd,
    );
    expect(actual).toEqual(expected);
    expect(actual.json.root.children.map(n => n.type)).toEqual([
      'paragraph',
      'test_decorator',
    ]);
    expect(actual.selection).toEqual({nodes: ['test_decorator']});
  });

  test('matches DELETE_CHARACTER_COMMAND at the start of a text paragraph after a block decorator', async () => {
    const {actual, expected} = await compare(
      () =>
        $abcThen(
          $createTestDecoratorNode().setIsInline(false),
          $createParagraphNode().append($createTextNode('def')),
        ),
      fromAbcEnd,
    );
    expect(actual).toEqual(expected);
  });

  test('matches DELETE_CHARACTER_COMMAND at a plain paragraph boundary', async () => {
    const {actual, expected} = await compare(
      () => $abcThen($createParagraphNode().append($createTextNode('def'))),
      fromAbcEnd,
    );
    expect(actual).toEqual(expected);
  });
  test('keeps an isolated inline decorator that the range skips over', async () => {
    // WebKit reports #text(ab)@2..SPAN@0 across an inline contenteditable=false
    // element, all within one paragraph.
    const {actual, expected} = await compare(
      () => {
        const cd = $createTextNode('cd');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('ab'),
              new IsolatedDecoratorNode(),
              cd,
            ),
          );
        cd.select(0, 0);
      },
      root => {
        const [ab, , cd] = Array.from(root.querySelector('p')!.children);
        return createStaticRange(ab.firstChild!, 2, cd, 0);
      },
    );
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual.json)).toContain('isolated_decorator');
  });

  test('keeps the heading when backspacing at its start after an empty paragraph', async () => {
    const {actual, expected} = await compare(
      () => {
        const abc = $createTextNode('abc');
        $getRoot()
          .clear()
          .append($createParagraphNode(), $createHeadingNode('h1').append(abc));
        abc.select(0, 0);
      },
      root => {
        const [paragraph, heading] = Array.from(root.children);
        return createStaticRange(
          paragraph,
          0,
          heading.querySelector('span')!.firstChild!,
          0,
        );
      },
    );
    expect(actual).toEqual(expected);
    expect(actual.json.root.children.map(n => n.type)).toEqual(['heading']);
  });
});
