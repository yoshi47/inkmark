// A drag that ends inside the element it started in still fires a click, so a
// user copying text would otherwise be answered with a scroll. Callers ask this
// first and stay put while a selection stands.
export function hasTextSelection(): boolean {
  const sel = window.getSelection();
  return sel !== null && !sel.isCollapsed && sel.toString().trim().length > 0;
}
