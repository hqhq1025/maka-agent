export const CU_E2E_ACTION_CONTRACTS = Object.freeze({
  screenshot: {
    support: 'verified-success',
    atomicCases: ['desktop.screenshot'],
  },
  cursor_position: {
    support: 'expected-fail-closed',
    atomicCases: ['cursor_position.unsupported'],
  },
  mouse_move: {
    support: 'visual-only',
    atomicCases: ['cursor.mouse_move'],
  },
  left_click: {
    support: 'verified-success',
    atomicCases: [
      'textarea.left_click',
      'button.left_click',
      'checkbox.left_click',
      'empty_desktop.left_click.refused',
    ],
  },
  right_click: {
    support: 'verified-success',
    atomicCases: ['button.right_click'],
  },
  middle_click: {
    support: 'verified-success',
    atomicCases: ['button.middle_click'],
  },
  double_click: {
    support: 'verified-success',
    atomicCases: ['button.double_click'],
  },
  triple_click: {
    support: 'verified-success',
    atomicCases: ['button.triple_click'],
  },
  left_mouse_down: {
    support: 'expected-fail-closed',
    atomicCases: ['left_mouse_down.unsupported'],
  },
  left_mouse_up: {
    support: 'expected-fail-closed',
    atomicCases: ['left_mouse_up.unsupported'],
  },
  left_click_drag: {
    support: 'verified-success',
    atomicCases: [
      'range.left_click_drag',
      'cross_window.left_click_drag.refused',
    ],
  },
  type: {
    support: 'state-dependent',
    atomicCases: [
      'type.no_target.refused',
      'textarea.type',
      'non_text.type.refused',
    ],
  },
  key: {
    support: 'expected-fail-closed',
    atomicCases: ['key.chord.refused'],
  },
  hold_key: {
    support: 'expected-fail-closed',
    atomicCases: ['hold_key.unsupported'],
  },
  scroll: {
    support: 'verified-success',
    atomicCases: [
      'scroll.down',
      'scroll.up',
      'scroll.right',
      'scroll.left',
      'empty_desktop.scroll.refused',
    ],
  },
  wait: {
    support: 'verified-success',
    atomicCases: ['wait.duration'],
  },
  zoom: {
    support: 'verified-success',
    atomicCases: [
      'window.zoom',
      'cross_window.zoom.refused',
    ],
  },
});

export const CU_E2E_SEQUENCE_CASES = Object.freeze([
  {
    caseId: 'sequence.click_type_same_page',
    actions: ['left_click', 'type'],
    oracle: 'text lands only in the clicked page',
  },
  {
    caseId: 'sequence.switch_page_click_type',
    actions: ['left_click', 'type', 'left_click', 'type'],
    oracle: 'keyboard ownership follows the second page without contaminating the first',
  },
  {
    caseId: 'sequence.non_text_revokes_type',
    actions: ['left_click', 'left_click', 'type'],
    oracle: 'a non-editable click leaves type fail-closed',
  },
  {
    caseId: 'sequence.failed_click_revokes_type',
    actions: ['left_click', 'left_click', 'type'],
    oracle: 'a failed click cannot leave stale keyboard ownership',
  },
  {
    caseId: 'sequence.scroll_then_type',
    actions: ['left_click', 'scroll', 'type'],
    oracle: 'scroll does not transfer keyboard ownership',
  },
  {
    caseId: 'sequence.drag_then_type',
    actions: ['left_click', 'left_click_drag', 'type'],
    oracle: 'drag does not transfer keyboard ownership',
  },
  {
    caseId: 'sequence.zoom_then_click',
    actions: ['zoom', 'left_click'],
    oracle: 'capture-only zoom does not alter pointer targeting',
  },
  {
    caseId: 'sequence.refused_key_then_click',
    actions: ['key', 'left_click'],
    oracle: 'a refused key chord has no side effect on the next pointer action',
  },
]);

export function coverageSummary(executedCaseIds) {
  const executed = new Set(executedCaseIds);
  const actions = Object.fromEntries(
    Object.entries(CU_E2E_ACTION_CONTRACTS).map(([action, contract]) => {
      const missingCases = contract.atomicCases.filter((caseId) => !executed.has(caseId));
      return [action, {
        support: contract.support,
        requiredCases: contract.atomicCases,
        missingCases,
        covered: missingCases.length === 0,
      }];
    }),
  );
  return {
    actions,
    coveredActions: Object.values(actions).filter((entry) => entry.covered).length,
    totalActions: Object.keys(actions).length,
  };
}

export function sequenceSummary(executedCaseIds) {
  const executed = new Set(executedCaseIds);
  const missingCases = CU_E2E_SEQUENCE_CASES
    .map((entry) => entry.caseId)
    .filter((caseId) => !executed.has(caseId));
  return {
    requiredCases: CU_E2E_SEQUENCE_CASES.map((entry) => entry.caseId),
    missingCases,
    covered: missingCases.length === 0,
  };
}
