# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Static portfolio/landing page site for Rami's projects, hosted on GitHub Pages at **stuffbyrambo.com**. Built with vanilla HTML and Tailwind CSS (CDN) — no build step, no package manager, no dependencies.

## Development

There is no build process. To run locally, use any static HTTP server:

```bash
# From project root
python3 -m http.server 8080
# or
npx http-server
```

Deployment is automatic via GitHub Pages when changes are pushed to `main`.

## Architecture

The entire site is a single `index.html` file using Tailwind CSS loaded from CDN. There is no JavaScript framework, no bundler, and no configuration files beyond `.gitignore` and `CNAME`.

**Key sections in index.html:**
- Navigation bar
- Apps section (Gesture Flow — macOS utility)
- Web Projects section (Fantasy Dashboard, Red Tees placeholder, Reserved placeholder)
- Footer with social links

**Design system:**
- Primary accent: Electric Cyan (`#00e5ff`)
- Dark backgrounds: Deep space blue (`#0b1121`, `#151e32`)
- Glassmorphism cards with blur/transparency effects
- Glow effects via text-shadow and box-shadow

## Hosting

- **Domain**: stuffbyrambo.com (configured via `CNAME` file)
- **Platform**: GitHub Pages, auto-deploys from `main` branch
- **Repo**: github.com/davidgreenspan15/StuffByRamboHost
