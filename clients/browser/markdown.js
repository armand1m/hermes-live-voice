// Minimal markdown renderer for the task log.
//
// The on-device narrator (task-narrator.js) rewrites raw task telemetry into
// a small, predictable markdown dialect; this module turns that text into
// DOM. It is the page's react-markdown stand-in: the browser client ships as
// plain, dependency-free ES modules served by the gateway itself, so pulling
// React in for one drawer would cost the page its fully-local, offline-first
// character. Safety comes from construction, the same way react-markdown
// earns it: every piece of source text lands in a text node via textContent
// and every element comes from createElement — source HTML is never parsed,
// so task output cannot inject markup, handlers, or styles (the page CSP
// forbids all three anyway). Supported subset: #/##/### headings, **bold**,
// *em* / _em_, `code`, fenced ``` blocks, - and 1. lists (one nesting
// level), > quotes, --- rules, and [labels](https://links).

// Inline patterns, ordered so the earliest match in the text wins. The
// emphasis rules borrow CommonMark's guards (no space hugging the markers,
// word boundaries for underscores) so "task_id_here" and "3 * 4 * 5" stay
// literal. Lookbehind keeps the expressions readable; every target browser
// for the Prompt API supports it.
const INLINE_PATTERNS = [
  // `code` — raw content, nothing inside is parsed further.
  { regex: /`([^`\n]+)`/, kind: "code" },
  // **bold** — the run may contain single asterisks ("**a *b* c**"), the
  // lazy match just stops at the first closing pair.
  { regex: /\*\*(?!\s)(.+?)(?<!\s)\*\*/, kind: "strong", recurse: true },
  // *em*
  { regex: /\*(?!\s)([^*\n]+?)(?<!\s)\*/, kind: "em", recurse: true },
  // _em_ — never inside a longer word (snake_case identifiers stay intact).
  { regex: /(?<![A-Za-z0-9_])_(?!\s)([^_\n]+?)(?<!\s)_(?![A-Za-z0-9_])/, kind: "em", recurse: true },
  // [label](http(s)://url) — schemes are allowlisted so nothing executable
  // or non-web can become a link.
  { regex: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, kind: "link" },
];

/** Parse one line of inline markdown into flat tokens. Exported for tests. */
export function parseInline(source) {
  const tokens = [];
  let rest = String(source ?? "");
  while (rest) {
    let best = null;
    for (const pattern of INLINE_PATTERNS) {
      const match = pattern.regex.exec(rest);
      if (match && (best === null || match.index < best.match.index)) {
        best = { pattern, match };
      }
    }
    if (!best) {
      tokens.push({ kind: "text", text: rest });
      return tokens;
    }
    if (best.match.index > 0) {
      tokens.push({ kind: "text", text: rest.slice(0, best.match.index) });
    }
    const { pattern, match } = best;
    if (pattern.recurse) {
      for (const token of parseInline(match[1])) tokens.push(nest(token, pattern.kind));
    } else {
      // code and link leaves carry their raw captures.
      tokens.push(pattern.kind === "link"
        ? { kind: "link", text: match[1], href: match[2] }
        : { kind: pattern.kind, text: match[1] });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return tokens;
}

// Nested emphasis flattens into per-run flags ("**a *b* c**" renders as one
// bold run with a bold-italic inner span): narrator output rarely nests, and
// flags keep the renderer free of element-depth bookkeeping.
function nest(token, kind) {
  return token.kind === "text" ? { ...token, [kind]: true } : token;
}

const FENCE_OPEN = /^```(\S*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const RULE = /^(-{3,}|\*{3,})\s*$/;
const QUOTE = /^>\s?(.*)$/;
// One nesting level: two or more leading spaces make a child item.
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Parse markdown into a block tree. Exported for tests. */
export function parseBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  const paragraphLines = [];
  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push({ type: "paragraph", lines: paragraphLines.splice(0) });
  };

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flushParagraph();
      const code = [];
      index += 1;
      while (index < lines.length && !FENCE_CLOSE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      // Consume the closing fence when present (EOF is fine too).
      index += 1;
      blocks.push({ type: "code", language: fence[1] || null, lines: code });
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const quoted = [];
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index]);
        if (!next) break;
        quoted.push(next[1]);
        index += 1;
      }
      blocks.push({ type: "quote", lines: quoted });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph();
      const { block, nextIndex } = parseList(lines, index);
      blocks.push(block);
      index = nextIndex;
      continue;
    }

    paragraphLines.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

// Collects a run of list lines into one block. Two indent columns are
// recognized: top level and one nested level (deeper indents flatten into
// the nearest parent).
function parseList(lines, start) {
  const root = { ordered: /^\d/.test(LIST_ITEM.exec(lines[start])[2]), items: [] };
  const stack = [{ depth: 0, items: root.items }];
  let index = start;

  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match) break;
    const depth = match[1].length >= 2 ? 1 : 0;
    const item = { text: match[3].trim(), items: [] };
    // An indented first line (no parent yet) folds into the root level.
    if (!stack[depth]) stack[depth] = { depth, items: root.items };
    // Popping back to a shallower level discards deeper state.
    stack.length = depth + 1;
    stack[depth].items.push(item);
    stack[depth + 1] = { depth, items: item.items };
    index += 1;
  }
  return { block: { type: "list", ...root }, nextIndex: index };
}

function buildInline(parent, tokens, doc) {
  for (const token of tokens) {
    if (token.kind === "text") {
      appendTextRun(parent, token, doc);
    } else if (token.kind === "code") {
      const code = doc.createElement("code");
      code.textContent = token.text;
      parent.append(code);
    } else if (token.kind === "link") {
      const anchor = doc.createElement("a");
      anchor.setAttribute("href", token.href);
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
      anchor.textContent = token.text;
      parent.append(anchor);
    }
  }
}

// A text run lands in text nodes; its emphasis flags wrap those nodes in
// <strong>/<em>. Line breaks inside the run become <br>, matching how chat
// and log text is authored.
function appendTextRun(parent, token, doc) {
  let target = parent;
  if (token.strong) {
    target = doc.createElement("strong");
    parent.append(target);
  }
  if (token.em) {
    const em = doc.createElement("em");
    target.append(em);
    target = em;
  }
  const parts = token.text.split("\n");
  parts.forEach((part, position) => {
    if (position > 0) target.append(doc.createElement("br"));
    if (part) target.append(doc.createTextNode(part));
  });
}

// #/##/### map to h4/h5/h6 — the entry's own title already owns h3.
const HEADING_TAGS = { 1: "h4", 2: "h5", 3: "h6" };

function buildBlock(parent, block, doc) {
  if (block.type === "heading") {
    const heading = doc.createElement(HEADING_TAGS[block.level] ?? "h6");
    buildInline(heading, parseInline(block.text), doc);
    parent.append(heading);
  } else if (block.type === "paragraph") {
    const paragraph = doc.createElement("p");
    buildInline(paragraph, parseInline(block.lines.join("\n")), doc);
    parent.append(paragraph);
  } else if (block.type === "code") {
    const pre = doc.createElement("pre");
    if (block.language) pre.dataset.language = block.language;
    pre.textContent = block.lines.join("\n");
    parent.append(pre);
  } else if (block.type === "quote") {
    const quote = doc.createElement("blockquote");
    buildInline(quote, parseInline(block.lines.join("\n")), doc);
    parent.append(quote);
  } else if (block.type === "rule") {
    parent.append(doc.createElement("hr"));
  } else if (block.type === "list") {
    const list = doc.createElement(block.ordered ? "ol" : "ul");
    appendListItems(list, block.items, doc);
    parent.append(list);
  }
}

function appendListItems(list, items, doc) {
  for (const item of items) {
    const li = doc.createElement("li");
    buildInline(li, parseInline(item.text), doc);
    if (item.items.length) {
      const nested = doc.createElement("ul");
      appendListItems(nested, item.items, doc);
      li.append(nested);
    }
    list.append(li);
  }
}

/**
 * Render markdown text into a detached element. The optional `doc` (defaults
 * to the global document) exists so tests can supply a stub — the builder
 * itself only needs createElement, createTextNode, and append.
 */
export function renderMarkdown(source, doc = globalThis.document) {
  const container = doc.createElement("div");
  container.className = "task-md";
  for (const block of parseBlocks(source)) buildBlock(container, block, doc);
  return container;
}
