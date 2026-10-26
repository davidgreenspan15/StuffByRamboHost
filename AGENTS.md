# Website project guidance

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

For shared workspace rules, read `~/Coding/AGENTS.md` and `~/Coding/CLAUDE.md`. For company facts, business accounts and cross-product payment decisions, start at `/Users/ramigreenspan/Documents/Stuff By Rambo LLC/README.md` before asking Rami to repeat them.

Commerce work exists in the local working tree under `supabase/`, `edge/`, `gesture-flow/`, `license/`, and `docs/commerce/`. The static-site description below covers the original portfolio. For commerce implementation and launch status, read `docs/commerce/LAUNCH_GATES.md`, `API_CONTRACT.md`, and `PRODUCTION_OPERATIONS_RUNBOOK.md`; do not infer readiness from the original no-build description.

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

A push containing the staged commerce, legal, Gesture Flow or license pages can publish them publicly. Treat that as a release decision and follow the commerce launch gates as well as Rami's explicit commit/push authorization.

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
