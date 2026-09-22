import { describe, expect, it } from "vitest";
// Browser-only module intentionally ships as plain ESM JavaScript.
// @ts-expect-error No declaration file is emitted for browser assets.
import { parseBlocks, parseInline, renderMarkdown } from "../clients/browser/markdown.js";

// --- minimal DOM stub: the builder only needs createElement,
// --- createTextNode, append, and setAttribute.
class FakeText {
  data: string;
  constructor(data: string) {
    this.data = data;
  }
}
class FakeElement {
  tagName: string;
  className = "";
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: Array<FakeElement | FakeText> = [];
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  append(...nodes: Array<FakeElement | FakeText>) {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  // Like the real DOM: assigning textContent replaces children with one text
  // node, and reading it concatenates descendant text.
  get textContent(): string {
    return this.children
      .map((child) => (child instanceof FakeText ? child.data : child.textContent))
      .join("");
  }
  set textContent(data: string) {
    this.children = data === "" ? [] : [new FakeText(data)];
  }
}
const fakeDoc = {
  createElement: (tag: string) => new FakeElement(tag),
  createTextNode: (text: string) => new FakeText(text),
};

/** Compact tree outline: div.task-md(p(#hello),code(#x)) */
function outline(node: FakeElement | FakeText): string {
  if (node instanceof FakeText) return `#${JSON.stringify(node.data)}`;
  const self = `${node.tagName}${node.className ? `.${node.className}` : ""}`;
  if (!node.children.length) return self;
  return `${self}(${node.children.map(outline).join(",")})`;
}

describe("parseInline", () => {
  it("passes plain text through untouched", () => {
    expect(parseInline("task_id_here ran 3 * 4 times")).toEqual([
      { kind: "text", text: "task_id_here ran 3 * 4 times" },
    ]);
  });

  it("parses bold, emphasis, code, and links in one pass", () => {
    const tokens = parseInline("**Done** — ran `git status`, see [log](https://example.test/a)");
    expect(tokens).toEqual([
      { kind: "text", text: "Done", strong: true },
      { kind: "text", text: " — ran " },
      { kind: "code", text: "git status" },
      { kind: "text", text: ", see " },
      { kind: "link", text: "log", href: "https://example.test/a" },
    ]);
  });

  it("keeps underscores inside identifiers literal and parses real emphasis", () => {
    expect(parseInline("_real_ emphasis")).toEqual([
      { kind: "text", text: "real", em: true },
      { kind: "text", text: " emphasis" },
    ]);
    expect(parseInline("snake_case_name stays flat")).toEqual([
      { kind: "text", text: "snake_case_name stays flat" },
    ]);
  });

  it("flattens nested emphasis into per-run flags", () => {
    const tokens = parseInline("**bold and *tight* text**");
    expect(tokens).toEqual([
      { kind: "text", text: "bold and ", strong: true },
      { kind: "text", text: "tight", strong: true, em: true },
      { kind: "text", text: " text", strong: true },
    ]);
  });

  it("leaves markup-looking text as literal when guards fail", () => {
    expect(parseInline("a * b * c")).toEqual([{ kind: "text", text: "a * b * c" }]);
    expect(parseInline("stray ` backtick")).toEqual([{ kind: "text", text: "stray ` backtick" }]);
  });
});

describe("parseBlocks", () => {
  it("parses headings, rules, and paragraphs", () => {
    const blocks = parseBlocks("# Title\n\nText line one\nline two\n\n---\n\n### Deep");
    expect(blocks).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", lines: ["Text line one", "line two"] },
      { type: "rule" },
      { type: "heading", level: 3, text: "Deep" },
    ]);
  });

  it("collects fenced code without inline parsing, even unterminated", () => {
    const blocks = parseBlocks("before\n\n```bash\ngit status **raw**\n```\n\nafter");
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["before"] },
      { type: "code", language: "bash", lines: ["git status **raw**"] },
      { type: "paragraph", lines: ["after"] },
    ]);
    expect(parseBlocks("```js\nnever closed")[0]).toEqual({
      type: "code",
      language: "js",
      lines: ["never closed"],
    });
  });

  it("groups quotes and nested lists", () => {
    const blocks = parseBlocks("> quoted **line**\n> second\n\n- one\n- two\n  - nested\n- three\n\n1. first\n2. second");
    expect(blocks).toEqual([
      { type: "quote", lines: ["quoted **line**", "second"] },
      {
        type: "list",
        ordered: false,
        items: [
          { text: "one", items: [] },
          { text: "two", items: [{ text: "nested", items: [] }] },
          { text: "three", items: [] },
        ],
      },
      {
        type: "list",
        ordered: true,
        items: [
          { text: "first", items: [] },
          { text: "second", items: [] },
        ],
      },
    ]);
  });
});

describe("renderMarkdown", () => {
  it("builds DOM nodes only — source text never becomes markup", () => {
    const host = renderMarkdown("**Hi** <img src=x onerror=alert(1)> `code`", fakeDoc as never);
    expect(outline(host as FakeElement)).toBe(
      'div.task-md(p(strong(#"Hi"),#" <img src=x onerror=alert(1)> ",code(#"code")))',
    );
  });

  it("maps #/##/### onto h4/h5/h6 and renders fenced code with its language", () => {
    const host = renderMarkdown("## Facts\n\n```python\nprint(1)\n```", fakeDoc as never) as FakeElement;
    expect(outline(host.children[0] as FakeElement)).toBe("h5(#\"Facts\")");
    const pre = host.children[1] as FakeElement;
    expect(pre.tagName).toBe("pre");
    expect(pre.dataset.language).toBe("python");
    expect(pre.textContent).toBe("print(1)");
  });

  it("renders safe links and drops nothing else into attributes", () => {
    const host = renderMarkdown("see [docs](https://example.test/x)", fakeDoc as never) as FakeElement;
    const anchor = (host.children[0] as FakeElement).children[1] as FakeElement;
    expect(anchor.tagName).toBe("a");
    expect(anchor.attrs).toEqual({
      href: "https://example.test/x",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(outline(anchor)).toBe('a(#"docs")');
  });

  it("turns hard line breaks in paragraphs into br elements", () => {
    const host = renderMarkdown("one\ntwo", fakeDoc as never) as FakeElement;
    expect(outline(host.children[0] as FakeElement)).toBe('p(#"one",br,#"two")');
  });
});
