// build.mjs — turns posts/*.md into the blog at site/blog/. Zero dependencies.
// Run: node build.mjs   (Cloudflare Pages runs this on every push)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const POSTS = path.join(ROOT, "posts");
const OUT = path.join(ROOT, "site", "blog");
const SITE = "https://omhinge.cloud";

// ---------- tiny markdown ----------
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = s => esc(s).replace(/"/g, "&quot;");
const slugify = s => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function inline(src) {
  const codes = [];
  let s = src.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
    const ext = /^https?:/.test(href) && !href.startsWith(SITE);
    return `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ""}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}

function markdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = []; const toc = [];
  let i = 0;
  const isBlockStart = l => /^(#{1,6}\s|```|>\s?|[-*]\s|\d+\.\s|---\s*$|\|)/.test(l) || /^!\[/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^```(\w*)\s*(.*)$/))) {
      const lang = m[1], title = m[2]; const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(`<figure class="code">${title || lang ? `<figcaption>${esc(title || lang)}</figcaption>` : ""}<pre><code${lang ? ` class="lang-${lang}"` : ""}>${esc(buf.join("\n"))}</code></pre></figure>`);
      continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      const lvl = m[1].length, text = inline(m[2]), id = slugify(m[2]);
      if (lvl === 2) toc.push({ id, text: m[2] });
      out.push(`<h${lvl} id="${id}">${text}</h${lvl}>`); i++; continue;
    }
    if (/^---\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if ((m = l.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/))) {
      out.push(`<figure class="fig"><img src="${m[2]}" alt="${attr(m[1])}" loading="lazy">${m[1] ? `<figcaption>${inline(m[1])}</figcaption>` : ""}</figure>`); i++; continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${markdown(buf.join("\n")).html}</blockquote>`); continue;
    }
    if (/^[-*]\s/.test(l) || /^\d+\.\s/.test(l)) {
      const ordered = /^\d+\.\s/.test(l); const re = ordered ? /^\d+\.\s+/ : /^[-*]\s+/; const items = [];
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, "")); else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join("")}</${tag}>`); continue;
    }
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.replace(/^\||\|\s*$/g, "").split("|").map(c => c.trim());
      const head = cells(rows[0]); const body = rows.slice(2).map(cells);
      out.push(`<div class="tbl"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const buf = []; while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return { html: out.join("\n"), toc };
}

function frontMatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/); if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, "");
    data[kv[1]] = v;
  }
  return { data, body: raw.slice(m[0].length) };
}

// ---------- templates ----------
const HEAD = (title, desc, url, image) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${attr(desc)}">
<meta name="theme-color" content="#060907">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(desc)}">
${image ? `<meta property="og:image" content="${SITE}${image}">\n<meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`}
<link rel="alternate" type="application/rss+xml" title="Om Hinge · blog" href="${SITE}/blog/feed.xml">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23060907'/%3E%3Cpath d='M3 4l4 4-4 4' stroke='%235cf28a' stroke-width='2' fill='none'/%3E%3Crect x='8' y='11' width='5' height='2' fill='%235cf28a'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Sans:wght@400;600;700&family=VT323&display=swap">
<link rel="stylesheet" href="/blog/blog.css">
</head>
<body>
<div class="scan" aria-hidden="true"></div>
<header class="top"><a href="/" class="home">om@omniscient</a><span class="d">:</span><a href="/blog/">~/blog</a><span class="d">$</span><nav><a href="/">home</a><a href="/blog/">blog</a><a href="/blog/feed.xml">rss</a><a href="/Om_Hinge_Resume.pdf" download>resume</a></nav></header>
<main class="wrap">`;
const FOOT = `</main>
<footer class="foot wrap"><span>© ${new Date().getFullYear()} Om Hinge</span><span><a href="https://github.com/Aisu2635" target="_blank" rel="noopener">github</a> · <a href="https://www.linkedin.com/in/om-hinge2635" target="_blank" rel="noopener">linkedin</a> · <a href="/blog/feed.xml">rss</a></span></footer>
</body>
</html>
`;

const fmtDate = d => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const readMins = t => Math.max(1, Math.round(t.split(/\s+/).length / 220));

// ---------- build ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, "blog.css"), path.join(OUT, "blog.css"));

const posts = fs.readdirSync(POSTS).filter(f => f.endsWith(".md") && !f.startsWith("_")).map(f => {
  const { data, body } = frontMatter(fs.readFileSync(path.join(POSTS, f), "utf8"));
  if (data.draft === "true") return null;
  const slug = data.slug || f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
  const { html, toc } = markdown(body);
  return { ...data, slug, html, toc, tags: data.tags || [], mins: readMins(body), url: `/blog/${slug}/` };
}).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));

for (const p of posts) {
  const dir = path.join(OUT, p.slug); fs.mkdirSync(dir, { recursive: true });
  const idx = posts.indexOf(p), newer = posts[idx - 1], older = posts[idx + 1];
  fs.writeFileSync(path.join(dir, "index.html"), HEAD(`${p.title} · Om Hinge`, p.summary, SITE + p.url, p.cover) + `
<article class="post">
  <div class="cmd"><span class="p">om@omniscient:~/blog$</span> cat ${p.slug}.md</div>
  <h1>${inline(p.title)}</h1>
  <div class="meta"><time datetime="${p.date}">${fmtDate(p.date)}</time><span>${p.mins} min read</span>${p.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join("")}</div>
  ${p.cover ? `<img class="cover" src="${p.cover}" alt="${attr(p.title)}" width="1200" height="630">` : ""}
  ${p.toc.length > 2 ? `<details class="toc"><summary>contents</summary><ol>${p.toc.map(t => `<li><a href="#${t.id}">${inline(t.text)}</a></li>`).join("")}</ol></details>` : ""}
  <div class="prose">
${p.html}
  </div>
  ${p.linkedin ? `<p class="orig">Originally posted on <a href="${p.linkedin}" target="_blank" rel="noopener">LinkedIn</a>. This version is expanded.</p>` : ""}
  <nav class="pager">${newer ? `<a href="${newer.url}">← newer: ${esc(newer.title)}</a>` : "<span></span>"}${older ? `<a href="${older.url}">older: ${esc(older.title)} →</a>` : ""}</nav>
  <p class="back"><a href="/blog/">cd ~/blog</a></p>
</article>` + FOOT);
}

// index
fs.writeFileSync(path.join(OUT, "index.html"), HEAD("Blog · Om Hinge", "Notes from the network layer: Kubernetes, Azure, ingress, CI/CD and the bugs in between.", SITE + "/blog/") + `
<section class="list">
  <div class="cmd"><span class="p">om@omniscient:~/blog$</span> ls -lt</div>
  <h1>Notes from the <em>network</em> layer</h1>
  <p class="lede">Things I've built, broken and fixed: Kubernetes, Azure networking, ingress, CI/CD. Mostly the parts that took longer than they should have.</p>
  <ol class="posts">
${posts.map(p => `    <li><a href="${p.url}">
      <span class="perm">-rw-r--r--  om  ${String(p.mins).padStart(2)}m  <time datetime="${p.date}">${fmtDate(p.date)}</time></span>
      <span class="t">${inline(p.title)}</span>
      <span class="s">${esc(p.summary || "")}</span>
      <span class="tags">${p.tags.map(t => `#${esc(t)}`).join(" ")}</span>
    </a></li>`).join("\n")}
  </ol>
  <p class="d small">total ${posts.length} · subscribe via <a href="/blog/feed.xml">rss</a></p>
</section>` + FOOT);

// json for the homepage
fs.writeFileSync(path.join(OUT, "posts.json"), JSON.stringify(posts.map(({ title, date, summary, tags, url, mins }) => ({ title, date, summary, tags, url, mins })), null, 2));

// rss
const rfc = d => new Date(d + "T06:00:00Z").toUTCString();
fs.writeFileSync(path.join(OUT, "feed.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Om Hinge · blog</title>
  <link>${SITE}/blog/</link>
  <atom:link href="${SITE}/blog/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Notes from the network layer: Kubernetes, Azure, ingress, CI/CD.</description>
  <language>en</language>
${posts.map(p => `  <item>
    <title>${esc(p.title)}</title>
    <link>${SITE}${p.url}</link>
    <guid>${SITE}${p.url}</guid>
    <pubDate>${rfc(p.date)}</pubDate>
    <description>${esc(p.summary || "")}</description>
  </item>`).join("\n")}
</channel>
</rss>
`);

// sitemap
fs.writeFileSync(path.join(ROOT, "site", "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc></url>
  <url><loc>${SITE}/blog/</loc></url>
${posts.map(p => `  <url><loc>${SITE}${p.url}</loc><lastmod>${p.date}</lastmod></url>`).join("\n")}
</urlset>
`);

console.log(`built ${posts.length} post(s) → site/blog/`);
