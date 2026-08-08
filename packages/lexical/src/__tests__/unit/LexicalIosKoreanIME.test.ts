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
 * when on iOS with a non-collapsed targetRange.
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  FORMAT_TEXT_COMMAND,
  IS_BOLD,
  type LexicalEditor,
  type TextFormatType,
} from 'lexical';
import {invariant} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

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
  data: string | null = null,
): InputEvent {
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data,
    inputType,
  });
  Object.defineProperty(event, 'getTargetRanges', {
    value: () => (targetRange ? [targetRange] : []),
  });
  return event;
}

function textNodes(editor: LexicalEditor): [number, string][] {
  return editor.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(node => [node.getFormat(), node.getTextContent()]),
  );
}

function lastDOMTextNode(editor: LexicalEditor): Text {
  const root = editor.getRootElement();
  assert(root !== null, 'root element is null');
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let last: Node | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    last = node;
  }
  assert(last !== null, 'expected a DOM text node');
  return last as Text;
}

function imeKeystroke(
  container: HTMLElement,
  editor: LexicalEditor,
  key: string,
  removeCount: number,
  insertData: string,
): void {
  editor.read(() => {});
  container.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key}));
  const domText = lastDOMTextNode(editor);
  const end = domText.nodeValue!.length;
  container.dispatchEvent(
    createBeforeInputEvent(
      'deleteContentBackward',
      createStaticRange(domText, end - removeCount, domText, end),
    ),
  );
  container.dispatchEvent(
    createBeforeInputEvent('insertText', null, insertData),
  );
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
  format: TextFormatType | null = null,
): Promise<string> {
  let textKey = '';
  await editor.update(() => {
    const paragraph = $createParagraphNode();
    const node = $createTextNode(text);
    if (format !== null) {
      node.toggleFormat(format);
    }
    paragraph.append(node);
    $getRoot().clear().append(paragraph);
    textKey = node.getKey();

    const sel = $createRangeSelection();
    sel.anchor.set(textKey, cursorOffset, 'text');
    sel.focus.set(textKey, cursorOffset, 'text');
    sel.setFormat(node.getFormat());
    sel.setStyle(node.getStyle());
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

describe('iOS Korean IME — format toggle during syllable rewriting', () => {
  test('bold applies only to text typed after the toggle', async () => {
    const {container, editor} = mountEditor();
    await setSingleTextNode(editor, '가나', 2);

    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');

    imeKeystroke(container, editor, 'ㄷ', 1, '낟');
    expect(textNodes(editor)).toEqual([[0, '가낟']]);

    imeKeystroke(container, editor, 'ㅏ', 1, '나다');
    expect(textNodes(editor)).toEqual([
      [0, '가나'],
      [IS_BOLD, '다'],
    ]);
  });

  test('unbold preserves the old text as bold', async () => {
    const {container, editor} = mountEditor();
    await setSingleTextNode(editor, '가나', 2, 'bold');

    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    imeKeystroke(container, editor, 'ㄷ', 1, '낟');
    imeKeystroke(container, editor, 'ㅏ', 1, '나다');

    expect(textNodes(editor)).toEqual([
      [IS_BOLD, '가나'],
      [0, '다'],
    ]);
  });

  test('a syllable with a final consonant inserts the next jamo directly', async () => {
    const {container, editor} = mountEditor();
    await setSingleTextNode(editor, '안녕', 2);

    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    container.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ㅎ'}),
    );
    container.dispatchEvent(createBeforeInputEvent('insertText', null, 'ㅎ'));
    expect(textNodes(editor)).toEqual([
      [0, '안녕'],
      [IS_BOLD, 'ㅎ'],
    ]);

    imeKeystroke(container, editor, 'ㅏ', 1, '하');
    expect(textNodes(editor)).toEqual([
      [0, '안녕'],
      [IS_BOLD, '하'],
    ]);
  });

  test('a new keydown discards an abandoned rewrite', async () => {
    const {container, editor} = mountEditor();
    await setSingleTextNode(editor, '가나', 2);

    editor.read(() => {});
    container.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ㄷ'}),
    );
    const domText = lastDOMTextNode(editor);
    container.dispatchEvent(
      createBeforeInputEvent(
        'deleteContentBackward',
        createStaticRange(domText, 1, domText, 2),
      ),
    );

    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    container.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'X'}),
    );
    container.dispatchEvent(createBeforeInputEvent('insertText', null, 'X'));

    expect(textNodes(editor)).toEqual([
      [0, '가'],
      [IS_BOLD, 'X'],
    ]);
  });

  test('a handled selection insertion discards an abandoned rewrite', async () => {
    const {container, editor} = mountEditor();
    await setSingleTextNode(editor, '가나', 2);

    editor.read(() => {});
    const domText = lastDOMTextNode(editor);
    container.dispatchEvent(
      createBeforeInputEvent(
        'deleteContentBackward',
        createStaticRange(domText, 1, domText, 2),
      ),
    );
    expect(editor._inputState.imeReplacedText).not.toBeNull();

    editor._inputState.isInsertTextAfterHandledSelectionCommand = true;
    container.dispatchEvent(createBeforeInputEvent('insertText', null, 'X'));

    expect(editor._inputState.imeReplacedText).toBeNull();
  });

  test('does not split a growing Hangul grapheme across formats', async () => {
    const {container, editor} = mountEditor();
    await setSingleTextNode(editor, 'ᄉ', 1);

    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    imeKeystroke(container, editor, 'ㆍ', 1, 'ᄉᆞ');

    expect(textNodes(editor)).toEqual([[0, 'ᄉᆞ']]);

    container.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'X'}),
    );
    container.dispatchEvent(createBeforeInputEvent('insertText', null, 'X'));
    expect(textNodes(editor)).toEqual([
      [0, 'ᄉᆞ'],
      [IS_BOLD, 'X'],
    ]);
  });

  test('a non-range insertion discards an abandoned rewrite', async () => {
    const {container, editor} = mountEditor();
    const textKey = await setSingleTextNode(editor, '가나', 2);

    editor.read(() => {});
    const domText = lastDOMTextNode(editor);
    container.dispatchEvent(
      createBeforeInputEvent(
        'deleteContentBackward',
        createStaticRange(domText, 1, domText, 2),
      ),
    );
    expect(editor._inputState.imeReplacedText).not.toBeNull();

    await editor.update(() => {
      const selection = $createNodeSelection();
      selection.add(textKey);
      $setSelection(selection);
    });
    container.dispatchEvent(createBeforeInputEvent('insertText', null, 'X'));

    expect(editor._inputState.imeReplacedText).toBeNull();
  });
});
