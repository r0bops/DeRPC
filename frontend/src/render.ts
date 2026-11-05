export interface StatusPart {
  text: string;
  className?: string;
}

export function renderStatus(el: HTMLElement, parts: StatusPart[]): void {
  el.replaceChildren(
    ...parts.map((part) => {
      if (!part.className) return document.createTextNode(part.text);
      const span = document.createElement("span");
      span.className = part.className;
      span.textContent = part.text;
      return span;
    }),
  );
}

export function renderWorkerFailure(el: HTMLElement, detail: string | undefined): void {
  renderStatus(el, [
    { text: "failed", className: "bad" },
    { text: ` — ${detail ?? "unknown error"} (no direct fallback)` },
  ]);
}

export function textCell(text: string, className?: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

export function tableRow(cells: { text: string; className?: string }[]): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.append(...cells.map((cell) => textCell(cell.text, cell.className)));
  return row;
}
