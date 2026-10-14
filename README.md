# JuzeReel

A Stremio add-on hosted on Cloudflare that turns pages on your own website into personal video catalogs. Add a page URL, use **Analyze & learn** to review inferred selectors, test the extraction, then install the generated manifest URL in Stremio.

Each configured page becomes a catalog, such as **Holidays** or **Parties**. Catalog refreshes fetch the page again, so changes to the page's content appear without changing the add-on configuration. The configuration is carried in the install URL; adding or changing a source creates a new install URL that should be installed in Stremio.

## Import and export setup JSON

The setup page can import a configuration by pasting JSON or choosing a `.json` file. Download the starter `stremio-memory-config-template.json` from the JSON section, then replace its example URLs and CSS selectors with those from your site. It can also export the current setup to the text box or download it as `stremio-memory-config.json`. The version 1 JSON includes every configured page, selector, HTML attribute, detail-page stream option, and additional Stremio metadata field. Loading a file replaces the pages currently shown in the form; after loading, create a new Stremio install link to use that configuration.

Imported pages must use public HTTPS URLs and the configuration supports up to 12 pages and all 13 additional Stremio metadata fields per page. The JSON file contains source URLs and selectors, so keep it private if that information should not be shared.

## What it extracts

- Required: page URL, repeated video-item selector, title selector, and playable video URL selector.
- Optional: description, poster, detail-page link, and additional Stremio metadata such as date, runtime, genres, cast, director, language, awards, or rating.
- Video URLs can be selected on the list page or on each linked detail page.

## Analyze & learn

The analyzer looks for repeated sibling structures, proposes selectors for the item, title, poster, description, and detail link, then checks those fields across up to five samples. For detail-page sources, it can inspect up to two same-site links and look for video/source elements, common video data attributes, media-file links, and video URLs in JSON-LD or other structured JSON. During playback the add-on also uses the configured selector first, then tries those common media patterns as a fallback.

Select **Render JavaScript page** when the website adds its cards after the initial HTML arrives. Cloudflare Browser Run loads the page in a headless browser to capture rendered markup and can render up to two same-origin detail pages for media discovery, so one analysis can render up to three pages. The Worker throttles rapid repeat requests where possible, and Cloudflare account usage limits still apply. Static mode does not execute page scripts; rendered mode lets the browser execute them to display the page. Neither mode signs into sites or bypasses access controls. Review each suggested pattern and choose **Apply this pattern** before testing or installing it; suggestions never replace your selectors automatically.

The page and media must be publicly reachable over HTTPS. A selector must identify a direct URL that Stremio can play; a page containing an embedded player is not necessarily a playable stream. Source pages up to 8 MB are supported. The generated manifest URL contains the source URLs and selectors, so treat it as private if those details should not be shared. This version does not sign in to websites or handle protected pages.

### Optional Gemini Flash assist

Open **Optional Gemini Flash selector helper**, enter your own Gemini API key, and choose **Gemini assist** on a source. The key is held in the current tab, sent to the JuzeReel Worker for that request, and forwarded to Google's Gemini API; JuzeReel does not save it or add it to the configuration, JSON export, or Stremio install URL. Clear the field or close the tab to remove it from the page.

Before the request, JuzeReel removes page text, scripts, styles, and comments; replaces class and ID values with aliases; and replaces URL values with opaque placeholders. Gemini receives the remaining HTML structure and attribute names, not the page URL or original hosts, paths, text, classes, IDs, or media URLs. The Worker maps the suggested aliases back and checks the selectors against the original page. The real values are read locally for the preview. Gemini assistance is optional; the regular **Analyze & learn** path works without a key.

## Test and configure in Stremio

Use **Test & preview output** on each page before installing. It shows the first five catalog metadata objects in Stremio's `metas` response, checks direct stream URLs, and tries the configured selector on up to three detail pages. Expand **View raw Stremio output JSON** to copy the exact catalog and stream response shapes for troubleshooting.

Installed manifests advertise `behaviorHints.configurable`, so Stremio shows a **Configure** action for the add-on. It opens the hosted editor at that install URL's `/configure` route and loads the setup carried by that URL. Saving changed sources produces a new install link; install that link in Stremio to use the updated setup.

## Local development

Requires Node.js 20 or newer.

```sh
npm install
npm run check
npm run dev
```

Open `http://localhost:8787/` to configure sources. Use **Analyze & learn** to get selector suggestions, then use **Test & preview output** before creating the Stremio install link. Cloudflare Browser Run Quick Actions require remote mode during local development; run `npx wrangler dev --remote` to test rendered-page analysis locally.

## Deploy to Cloudflare Workers

1. Create a Cloudflare API token with **Workers Admin** permission for the first deployment (the workflow creates the Worker), plus **Account Settings Read** if Wrangler requests it. Add it to this GitHub repository as `CLOUDFLARE_API_TOKEN`. After the Worker exists, the token can be narrowed to **Workers Editor** for future deploys.
2. Add the Cloudflare account ID as repository secret `CLOUDFLARE_ACCOUNT_ID`.
3. Push to `main`. `.github/workflows/cloudflare-worker.yml` installs dependencies, runs checks, and deploys the Worker with Wrangler. The Wrangler configuration attaches the custom domain `https://stremio.juzemaru.com`.
4. Open the custom domain, configure your pages, then install the generated manifest URL. Cloudflare creates the Worker custom-domain DNS and certificate during an authenticated deployment; the hostname must be available for the Worker.

The Worker and configurator are served together. GitHub Pages is no longer used for the running add-on because it cannot fetch and parse your site pages at request time.

## Privacy and limits

The configurator stores a draft in your browser's local storage, not on the server. The final config is encoded in the Stremio install URL. Anyone with that URL can read the configured catalogs, so do not put private pages or video URLs in a shared configuration. The scraper accepts only public HTTPS hostnames, limits source HTML to 8 MB, follows a limited number of safe redirects, and reads at most 100 video cards per page.

The Gemini key is excluded from browser local storage and configuration exports. Gemini analysis sends only the redacted structural sketch described above; the source URL and original page content stay in the local Worker analysis path. Google still processes the redacted request under the account and API terms associated with the key.
