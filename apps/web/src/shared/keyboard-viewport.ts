// visualViewport shrinks for both zoom and a keyboard. Only an editable
// focus and a loss of height after undoing zoom provide keyboard evidence.
export function keyboardViewportOpen(input: {
  layoutHeight: number;
  viewportHeight: number;
  scale: number;
  editable: boolean;
}) {
  return (
    input.editable &&
    Number.isFinite(input.layoutHeight) &&
    Number.isFinite(input.viewportHeight) &&
    Number.isFinite(input.scale) &&
    input.scale > 0 &&
    input.layoutHeight - input.viewportHeight * input.scale > 160
  );
}

export function hasEditableFocus(target: Element | null) {
  if (!target) return false;
  if (target.closest('[contenteditable="true"], [contenteditable=""]'))
    return true;
  if (target.matches("textarea:not([disabled]):not([readonly])")) return true;
  return (
    target.matches("input:not([disabled]):not([readonly])") &&
    !/^(button|submit|reset|checkbox|radio|range|color|file|hidden)$/i.test(
      target.getAttribute("type") ?? "text",
    )
  );
}
