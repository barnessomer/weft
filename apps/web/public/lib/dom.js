// @ts-check
// Tiny DOM helpers. All text goes through textContent (never innerHTML), so event content
// from agents (summaries, intents, diffs) cannot inject markup.

/**
 * @param {string} tag  "div.cls.cls2" shorthand allowed
 * @param {Record<string, any> | null} [attrs]
 * @param {...any} children strings, nodes, arrays, null/false (skipped)
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const [head, ...classes] = tag.split(".");
  const [name, id] = (head ?? "").split("#");
  const el = document.createElement(name || "div");
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(" ");
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = [el.className, v].filter(Boolean).join(" ");
      else if (k === "style" && typeof v === "object") {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith("--")) el.style.setProperty(prop, String(val));
          else /** @type {any} */ (el.style)[prop] = val;
        }
      }
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

/** @param {Node} el @param {any[]} children */
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === "") continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace all children. @param {Element} el @param {...any} children */
export function mount(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** SVG icon from a small inline set (stroke icons, 16px grid). */
const ICONS = /** @type {Record<string,string>} */ ({
  edit: "M3 13l1-4 7-7 3 3-7 7-4 1z",
  push: "M8 13V3M4 7l4-4 4 4",
  claim: "M3 3h7l3 3v7H3z",
  release: "M4 8h8",
  land: "M2 12h12M8 2v7M5 6l3 3 3-3",
  revert: "M5 4L2 7l3 3M2 7h7a4 4 0 010 8H6",
  join: "M8 3v10M3 8h10",
  leave: "M3 8h10",
  message: "M2 3h12v8H6l-3 3v-3H2z",
  control: "M5 3v10M11 3v10",
  propose: "M2 8h9M8 4l4 4-4 4",
  intent: "M8 2a4 4 0 014 4c0 2-2 3-2 5H6c0-2-2-3-2-5a4 4 0 014-4zM6 14h4",
  live: "M8 8m-3 0a3 3 0 106 0 3 3 0 10-6 0",
  board: "M2 2h4v12H2zM7 2h4v8H7zM12 2h2v5h-2z",
  ops: "M3 4h10M3 8h10M3 12h6",
  replay: "M4 3l9 5-9 5z",
  pause: "M5 3v10M11 3v10",
  ext: "M9 2h5v5M14 2L7 9M12 9v5H2V4h5",
  close: "M3 3l10 10M13 3L3 13",
  check: "M3 8l3 3 7-7",
  undo: "M5 4L2 7l3 3M2 7h7a4 4 0 010 8H6",
});

/** @param {string} name */
export function icon(name, cls = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `icon ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", ICONS[name] ?? ICONS.edit);
  svg.appendChild(p);
  return svg;
}
