# Stremio Memory Catalog

A Cloudflare Worker add-on that turns pages on your own website into Stremio video catalogs. Add a page URL, choose CSS selectors for its video cards and fields, preview the extraction, then install the generated manifest URL in Stremio.

Each configured page becomes a catalog, such as **Holidays** or **Parties**. Catalog refreshes fetch the page again, so changes to the page's content appear without changing the add-on configuration. The configuration is carried in the install URL; adding or changing a source creates a new install URL that should be installed in Stremio.

## Import and export setup JSON

The setup page can import a configuration by pasting JSON or choosing a `.json` file. Download the starter `stremio-memory-config-template.json` from the JSON section, then replace its example URLs and CSS selectors with those from your site. It can also export the current setup to the text box or download it as `stremio-memory-config.json`. The version 1 JSON includes every configured page, selector, HTML attribute, detail-page stream option, and additional Stremio metadata field. Loading a file replaces the pages currently shown in the form; after loading, create a new Stremio install link to use that configuration.

Imported pages must use public HTTPS URLs and the configuration supports up to 12 pages and all 13 additional Stremio metadata fields per page. The JSON file contains source URLs and selectors, so keep it private if that information should not be shared.

## What it extracts

- Required: page URL, repeated video-item selector, title selector, and playable video URL selector.
- Optional: description, poster, detail-page link, and additional Stremio metadata such as date, runtime, genres, cast, director, language, awards, or rating.
- Video URLs can be selected on the list page or on each linked detail page.

The page and media must be publicly reachable over HTTPS. A selector must identify a direct URL that Stremio can play; a page containing an embedded player is not necessarily a playable stream. The generated manifest URL contains the source URLs and selectors, so treat it as private if those details should not be shared. This version does not sign in to websites or handle protected pages.

## Local development

Requires Node.js 20 or newer.

```sh
npm install
npm run check
npm run dev
```

Open `http://localhost:8787/` to configure sources. Use **Test this page** before creating the Stremio install link.

## Deploy to Cloudflare Workers

1. Create a Cloudflare API token with **Workers Admin** permission for the first deployment (the workflow creates the Worker), plus **Account Settings Read** if Wrangler requests it. Add it to this GitHub repository as `CLOUDFLARE_API_TOKEN`. After the Worker exists, the token can be narrowed to **Workers Editor** for future deploys.
2. Add the Cloudflare account ID as repository secret `CLOUDFLARE_ACCOUNT_ID`.
3. Push to `main`. `.github/workflows/cloudflare-worker.yml` installs dependencies, runs checks, and deploys the Worker with Wrangler. The Wrangler configuration attaches the custom domain `https://stremio.juzemaru.com`.
4. Open the custom domain, configure your pages, then install the generated manifest URL. Cloudflare creates the Worker custom-domain DNS and certificate during an authenticated deployment; the hostname must be available for the Worker.

The Worker and configurator are served together. GitHub Pages is no longer used for the running add-on because it cannot fetch and parse your site pages at request time.

## Privacy and limits

The configurator stores a draft in your browser's local storage, not on the server. The final config is encoded in the Stremio install URL. Anyone with that URL can read the configured catalogs, so do not put private pages or video URLs in a shared configuration. The scraper accepts only public HTTPS hostnames, limits source HTML to 1.5 MB, follows a limited number of safe redirects, and reads at most 100 video cards per page.
