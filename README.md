# omhinge.cloud

Personal portfolio of **Om Hinge**, DevOps engineer. A single static page with an interactive terminal, a live network mesh background, a network troubleshooting game and a couple of off-the-clock toys.

**Live:** https://omhinge.cloud

## Stack

| Layer | Choice |
| --- | --- |
| Site | Plain HTML, CSS and JS in `site/`. No build step, no framework. |
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
site/
  index.html     the portfolio
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
| Build command | *(leave empty)* |
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
