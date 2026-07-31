import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { ToolTrow } from '../tool-activity.js';
import { computerActionLabel } from '../tool-activity/computer-action-label.js';
import { deriveToolActivityPresentation } from '../tool-activity/presentation.js';
import type { ToolActivityItem } from '../materialize.js';
import { LocaleProvider } from '../locale-context.js';

function computerCall(args: Record<string, unknown>, extra?: Partial<ToolActivityItem>): ToolActivityItem {
  return {
    toolUseId: `cu-${String(args.action)}`,
    toolName: 'maka_computer',
    displayName: 'Maka Computer',
    activityKind: 'computer',
    status: 'completed',
    args,
    ...extra,
  };
}

function label(args: Record<string, unknown>, locale: 'zh' | 'en' = 'zh'): string | undefined {
  return computerActionLabel(computerCall(args), locale);
}

function renderRows(items: ToolActivityItem[], locale: 'zh' | 'en' = 'zh'): string {
  return renderReactToStaticMarkup(
    createElement(LocaleProvider, {
      locale,
      children: createElement(ToolTrow, { items, variant: 'rows' }) as ReactNode,
    }),
  );
}

describe('computer action label', () => {
  it('names each semantic action from its own arguments', () => {
    assert.equal(label({ action: 'list_apps' }), '列出打开的应用');
    assert.equal(label({ action: 'launch_app', app: '计算器' }), '打开「计算器」');
    assert.equal(label({ action: 'observe', app: '计算器' }), '观察「计算器」窗口');
    assert.equal(label({ action: 'observe', window_id: 42 }), '观察窗口 42');
    assert.equal(label({ action: 'screenshot', app: '计算器' }), '截图「计算器」窗口');
    assert.equal(label({ action: 'click_element', element_id: 'e12' }), '点击元素 e12');
    assert.equal(label({ action: 'set_value', element_id: 'e12', value: '你好' }), '输入「你好」');
    assert.equal(label({ action: 'select_text', element_id: 'e12', text: 'abc' }), '选择文本「abc」');
    assert.equal(
      label({ action: 'secondary_action', element_id: 'e12', text: '复制' }),
      '执行「复制」：元素 e12',
    );
    assert.equal(
      label({ action: 'scroll_element', element_id: 'e12', scroll_direction: 'down' }),
      '向下滚动元素 e12',
    );
    assert.equal(label({ action: 'press_key', text: 'Return' }), '按下 Return');
  });

  it('names each coordinate action, including the ones with no element', () => {
    assert.equal(label({ action: 'left_click', coordinate: [120, 340] }), '点击 (120, 340)');
    assert.equal(label({ action: 'right_click', coordinate: [1, 2] }), '右键点击 (1, 2)');
    assert.equal(label({ action: 'double_click', coordinate: [1, 2] }), '双击 (1, 2)');
    assert.equal(label({ action: 'mouse_move', coordinate: [1, 2] }), '移动指针到 (1, 2)');
    assert.equal(label({ action: 'left_click_drag', coordinate: [1, 2] }), '拖动到 (1, 2)');
    assert.equal(label({ action: 'type', text: '你好' }), '输入「你好」');
    assert.equal(label({ action: 'key', text: 'Return' }), '按下 Return');
    assert.equal(label({ action: 'hold_key', text: 'Shift', duration: 2 }), '按住 Shift 2 秒');
    assert.equal(label({ action: 'scroll', scroll_direction: 'up' }), '向上滚动');
    assert.equal(label({ action: 'wait', duration: 1.5 }), '等待 1.5 秒');
    assert.equal(label({ action: 'zoom', region: [0, 0, 10, 10] }), '放大查看区域');
    assert.equal(label({ action: 'cursor_position' }), '读取指针位置');
  });

  it('spells out the control labels an element_sequence carries in its arguments', () => {
    assert.equal(
      label({ action: 'element_sequence', steps: [{ label: '7' }, { label: '+' }, { label: '8' }] }),
      '依次操作「7」「+」「8」',
    );
    // Capped at three, with the remainder marked rather than dropped silently.
    assert.equal(
      label({
        action: 'element_sequence',
        steps: [{ label: '7' }, { label: '+' }, { label: '8' }, { label: '=' }],
      }),
      '依次操作「7」「+」「8」…',
    );
    // Steps without usable labels still report how many controls were operated.
    assert.equal(label({ action: 'element_sequence', steps: [{}, {}] }), '依次操作 2 个控件');
  });

  it('falls back to something that still says what happened, never to the tool name', () => {
    // No element_id: the action is still named, the target is generic.
    assert.equal(label({ action: 'click_element' }), '点击该元素');
    assert.equal(label({ action: 'set_value', element_id: 'e12' }), '设置值：元素 e12');
    assert.equal(label({ action: 'observe' }), '观察当前窗口');
    assert.equal(label({ action: 'press_key' }), '按下按键');
    // Unknown, missing, and malformed arguments all land on the generic verb —
    // the noun "Maka Computer" is never the answer for a CU row.
    assert.equal(label({ action: 'teleport' }), '操作电脑');
    assert.equal(label({}), '操作电脑');
    assert.equal(computerActionLabel(computerCall({}, { args: 'not-an-object' }), 'zh'), '操作电脑');
    assert.equal(computerActionLabel(computerCall({}, { args: undefined }), 'zh'), '操作电脑');
  });

  it('localizes every derived label', () => {
    assert.equal(label({ action: 'list_apps' }, 'en'), 'List open apps');
    assert.equal(label({ action: 'observe', app: 'Calculator' }, 'en'), 'Observe the “Calculator” window');
    assert.equal(label({ action: 'observe', window_id: 42 }, 'en'), 'Observe window 42');
    assert.equal(label({ action: 'launch_app', app: 'Calculator' }, 'en'), 'Open “Calculator”');
    assert.equal(label({ action: 'click_element', element_id: 'e12' }, 'en'), 'Click element e12');
    assert.equal(label({ action: 'set_value', element_id: 'e12', value: 'hello' }, 'en'), 'Enter “hello”');
    assert.equal(label({ action: 'press_key', text: 'Return' }, 'en'), 'Press Return');
    assert.equal(
      label({ action: 'scroll_element', element_id: 'e12', scroll_direction: 'down' }, 'en'),
      'Scroll element e12 down',
    );
    assert.equal(
      label({ action: 'element_sequence', steps: [{ label: '7' }, { label: '+' }] }, 'en'),
      'Operate “7”, “+”',
    );
    assert.equal(label({ action: 'wait', duration: 2 }, 'en'), 'Wait 2s');
    assert.equal(label({ action: 'teleport' }, 'en'), 'Use the computer');
  });

  it('redacts and bounds a model-supplied value before it reaches an always-visible row', () => {
    // The display redactor's token shapes — a `set_value` can carry a key.
    const typed = label({ action: 'set_value', element_id: 'e1', value: 'sk-abcdefghijklmnopqrstuvwx' });
    assert.doesNotMatch(typed ?? '', /abcdefghijklmnop/);
    assert.match(typed ?? '', /redacted/i);

    const long = label({ action: 'type', text: 'x'.repeat(200) });
    assert.ok((long ?? '').length < 60, `expected a capped label, got ${long?.length} chars`);
    assert.match(long ?? '', /…」$/);

    // Multi-line input collapses to one row.
    assert.equal(label({ action: 'type', text: 'one\ntwo' }), '输入「one two」');
  });

  it('leaves other tools alone', () => {
    assert.equal(
      computerActionLabel(
        { toolUseId: 't', toolName: 'Bash', status: 'completed', args: { action: 'observe' } },
        'zh',
      ),
      undefined,
    );
  });

  it('keeps a declared intent authoritative so the Pi backend path is unchanged', () => {
    const item = computerCall({ action: 'click_element', element_id: 'e12' }, { intent: '点击等号' });
    assert.equal(deriveToolActivityPresentation(item, 'zh').summary, '点击等号');
  });

  it('renders one turn of Computer Use as three rows that read differently', () => {
    const markup = renderRows([
      computerCall({ action: 'observe', app: '计算器' }, { toolUseId: 'cu-1' }),
      computerCall({ action: 'click_element', element_id: 'e7' }, { toolUseId: 'cu-2' }),
      computerCall({ action: 'observe', app: '计算器' }, { toolUseId: 'cu-3' }),
    ]);

    assert.equal((markup.match(/观察「计算器」窗口/g) ?? []).length, 2);
    assert.match(markup, /点击元素 e7/);
    // The regression this fixes: three identical noun rows.
    assert.doesNotMatch(markup, /Maka Computer/);
  });
});
