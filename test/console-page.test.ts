import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONSOLE_INLINE_SCRIPT_HASHES,
  consoleContentSecurityPolicy,
} from "../src/adapters/inbound/http/server.js";

// Regression coverage for the 2026-09-22 live incident: the console is served
// behind a path-stripping reverse proxy (tailscale serve /voice -> gateway /),
// and the document URL may carry no trailing slash. A static relative asset
// reference then resolves against the site root, escapes the proxy mount, and
// the app never boots — no client, no supervisor, no reconnect button. These
// tests pin the console page to mount-aware asset resolution instead.
const page = readFileSync(
  fileURLToPath(new URL("../clients/browser/index.html", import.meta.url)),
  "utf8",
);

function inlineScript(type: string): string {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = page.match(new RegExp(`<script${type ? ` type="${escaped}"` : ""}>([\\s\\S]*?)</script>`, "i"));
  if (!match) throw new Error(`index.html has no inline <script${type ? ` type="${type}"` : ""}> block.`);
  return match[1];
}

describe("console page asset mounting", () => {
  it("keeps voice.js and voice.css referenced only through the mount-aware bootstraps", () => {
    // Static, mount-relative references are exactly what breaks under a
    // stripping proxy when the document URL has no trailing slash.
    expect(page).not.toMatch(/<script[^>]*src=["']voice\.js["']/i);
    expect(page).not.toMatch(/<link[^>]*href=["']voice\.css["']/i);
  });

  it("resolves the stylesheet against the document's mount path", () => {
    const script = inlineScript("");
    expect(script).toContain("location.pathname");

    const cases: Array<[pathname: string, expected: string]> = [
      ["/", "/voice.css"],
      ["/voice", "/voice/voice.css"],
      ["/voice/", "/voice/voice.css"],
      ["/deep/mount", "/deep/mount/voice.css"],
    ];
    for (const [pathname, expected] of cases) {
      const appended: Array<{ rel: string; href: string }> = [];
      const document = {
        createElement: () => ({ rel: "", href: "" }),
        head: { appendChild: (element: { rel: string; href: string }) => appended.push(element) },
      };
      new Function("location", "document", script)({ pathname }, document);
      expect(appended, `pathname ${pathname}`).toEqual([{ rel: "stylesheet", href: expected }]);
    }
  });

  it("loads the voice.js module through the same mount rule", () => {
    const script = inlineScript("module");
    expect(script).toContain("location.pathname");
    expect(script).toMatch(/import\(mount \+ "\/voice\.js"\)/);
    // Same trailing-slash normalization as voice.js itself.
    expect(script).toContain('path.endsWith("/") ? path.slice(0, -1) : path');
  });

  it("admits exactly the page's inline scripts in the served CSP", () => {
    // The bootstraps are inline under a script-src CSP, so the server must
    // allowlist them by hash — and the allowlist must not drift from the file.
    const inlineHashes = [...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, attributes]) => !/\ssrc=/.test(attributes))
      .map(([, , body]) => `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`)
      .sort();
    expect(inlineHashes.length).toBeGreaterThan(0);
    expect([...CONSOLE_INLINE_SCRIPT_HASHES].sort()).toEqual(inlineHashes);
    const policy = consoleContentSecurityPolicy();
    // Hash sources are only honored when single-quoted in the policy.
    for (const hash of inlineHashes) expect(policy).toContain(`'${hash}'`);
    expect(policy).toContain("script-src 'self'");
  });
});
