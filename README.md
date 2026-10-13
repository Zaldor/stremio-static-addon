# Stremio static add-on starter

A small, data-driven Stremio add-on that can be hosted on GitHub Pages. It publishes fixed JSON catalog and stream routes; it does not scrape websites, resolve third-party players, or run server code.

## Edit the catalog

Change `src/addon.json`. Each catalog has a Stremio content `type`, unique `id`, display `name`, and `items`. Each movie item needs an `id`, `type`, and `name`; optionally add poster/metadata fields and one or more direct HTTPS `streams` that you are authorized to distribute. This starter currently supports movie catalogs.

Update the manifest `id` to a unique reverse-domain identifier before publishing a fork. The example item is Big Buck Bunny, an open movie from the Blender Foundation; replace it with your own authorized media and poster URLs.

## Build and verify locally

Requires Node.js 20 or newer; there are no runtime dependencies.

```sh
npm run check
npm run build
```

The generated add-on is in `dist/`. Its main routes look like this:

```text
/manifest.json
/catalog/movie/open-movie-sample.json
/stream/movie/tt1254207.json
```

## Publish on GitHub Pages

1. Push this project to a GitHub repository on the `main` branch. On GitHub Free, Pages requires a public repository; private Pages publishing requires an eligible paid plan.
2. In **Settings → Pages**, set the build and deployment source to **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` builds `dist/` and deploys it.
4. After the workflow succeeds, open the Pages URL shown in the workflow or repository settings. The manifest URL is that address plus `/manifest.json`.
5. Install it in Stremio using the manifest URL.

The static protocol works for fixed feeds and exact item-to-stream mappings. GitHub Pages cannot execute search handlers, scrape sites, resolve changing stream URLs, or protect secret API keys. Use a serverless function host such as Cloudflare Workers for those features.

## Data and licensing

Use only media URLs you are authorized to distribute. The add-on exposes the URLs in its JSON files, so they are public. Catalog metadata and media are hosted by their respective providers; this project does not copy them.
