# omhinge.cloud

Personal portfolio of **Om Hinge**, DevOps engineer. A single static page with an interactive terminal, a live network mesh background, a network troubleshooting game and a couple of off-the-clock toys.

**Live:** https://omhinge.cloud

## Stack

| Layer | Choice |
| --- | --- |
| Site | Plain HTML, CSS and JS in `site/`. No framework. |
| Blog | Markdown in `posts/`, turned into pages by `build.mjs` (zero dependencies) |
| Hosting | Cloudflare Pages (global edge, free TLS) |
| DNS | Cloudflare |
| CI/CD | Cloudflare Pages Git integration (auto-deploy on push, preview per PR) |
| Monitoring | GitHub Actions uptime check after every push and every 6 hours |
| Security | CSP, HSTS and friends via `site/_headers` |

```
git push main ──► Cloudflare Pages ──► global edge ──► omhinge.cloud
pull request  ──► Cloudflare Pages ──► preview URL (<hash>.omhinge.pages.dev)
every 6h      ──► GitHub Actions uptime check ──► fails loudly if the site or its headers are gone
```

## Repo layout

```
posts/           blog posts (Markdown)
build.mjs        blog builder
blog.css         blog styles
site/
  index.html     the portfolio
  assets/blog/   post covers and infographics
  404.html       custom not-found page (Pages serves it automatically)
  _headers       security + cache headers
  robots.txt
  sitemap.xml
.github/workflows/uptime.yml
```

## First-time setup

### 1. Connect the repo to Cloudflare Pages
Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick this repo, then:

| Setting | Value |
| --- | --- |
| Project name | `omhinge` |
| Production branch | `main` |
| Framework preset | None |
| Build command | `node build.mjs` |
| Build output directory | `site` |

Save and deploy. The site is live at `omhinge.pages.dev`.

### 2. Move DNS from GoDaddy to Cloudflare
A root domain on Pages needs its DNS on Cloudflare. The domain stays registered at GoDaddy.

1. Cloudflare dashboard → **Add a domain** → `omhinge.cloud` → Free plan. Note the two nameservers it gives you.
2. GoDaddy → **My Products** → `omhinge.cloud` → **DNS** → **Nameservers** → **Change** → *I'll use my own nameservers* → paste both Cloudflare nameservers → save. (If DNSSEC is on at GoDaddy, turn it off first.)
3. Wait for Cloudflare to email that the domain is active. Usually minutes, sometimes a few hours.

### 3. Attach the domain
**Workers & Pages** → `omhinge` → **Custom domains** → add `omhinge.cloud`, then `www.omhinge.cloud`. Cloudflare creates the DNS records and the certificate.

Optional: **Rules** → **Redirect Rules** → template *Redirect from WWW to root*.

## Blog

Posts are Markdown files in `posts/`. On every push Cloudflare runs `node build.mjs`, which generates `site/blog/` (post pages, the `ls -lt` index, `posts.json` for the homepage, an RSS feed) and refreshes `site/sitemap.xml`. `site/blog/` is generated, so it's git-ignored.

**Cloudflare Pages settings:** build command `node build.mjs`, output directory `site`.

### Writing a post

1. Create `posts/YYYY-MM-DD-short-slug.md`:
   ```markdown
   ---
   title: The title people will see
   date: 2026-10-06
   summary: One sentence for the blog index, link previews and RSS.
   tags: [kubernetes, azure]
   cover: /assets/blog/short-slug/cover.png
   linkedin: https://www.linkedin.com/posts/...   # optional
   ---

   Your post in Markdown. `## Headings` build the contents box.
   ![Caption shown under the image](/assets/blog/short-slug/diagram.png)
   ```
2. Put images in `site/assets/blog/short-slug/`. Covers are 1200×630, infographics 1600×2000.
3. Preview locally (optional): `node build.mjs` then open `site/blog/index.html`, or `npx wrangler pages dev site`.
4. `git add -A && git commit -m "post: short-slug" && git push`

Add `draft: true` to the front matter to keep a post out of the build. Supported Markdown: headings, paragraphs, bold/italic, links, images, inline code, fenced code (```` ```yaml optional caption ````), lists, quotes, tables, `---`.

## Local preview

```bash
npx wrangler pages dev site
```

or just open `site/index.html` in a browser.

## Editing content

Everything lives in `site/index.html`:

- links and email: the `CFG` object at the top of the main script
- skills: the `SKILLS` array
- GitHub project cards: the `PROJECTS` array
- experience: the `<section id="experience">` block

## Easter eggs

There's at least one command the shell's `help` won't show you.
