import { marked } from "marked";

const ALLOWED_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  td: new Set(["align"]),
  th: new Set(["align"]),
};

const SAFE_HREF = /^(https?:|mailto:|#|\/)[^\s]*$/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href || href.toLowerCase().startsWith("javascript:") || href.toLowerCase().startsWith("data:"))
    return null;
  return SAFE_HREF.test(href) ? href : null;
}

function parseAttrs(raw: string, tag: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return "";
  const out: string[] = [];
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase();
    if (name.startsWith("on") || name === "style" || name === "srcdoc") continue;
    if (!allowed.has(name)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name === "href") {
      const href = safeHref(value);
      if (!href) continue;
      out.push(`href="${escapeHtml(href)}"`);
      continue;
    }
    out.push(`${name}="${escapeHtml(value)}"`);
  }
  return out.length ? ` ${out.join(" ")}` : "";
}

/** Restrictive HTML allowlist. Drops event handlers, scripts, and unsafe URLs. */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|<!--[\s\S]*?-->/g, (full, tag: string, attrs: string) => {
    if (full.startsWith("<!--")) return "";
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    if (full.startsWith("</")) return `</${name}>`;
    const selfClosing = /\/\s*$/.test(attrs) || name === "br" || name === "hr";
    return `<${name}${parseAttrs(attrs, name)}${selfClosing ? " />" : ">"}`;
  });
}

export function renderSafeMarkdown(
  source: string,
  opts: { breaks?: boolean } = {},
): string {
  const raw = marked.parse(source || "", {
    async: false,
    gfm: true,
    breaks: !!opts.breaks,
  }) as string;
  return sanitizeHtml(raw);
}
