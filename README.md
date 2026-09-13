# AzuraCast Dashboard

A lightweight, framework-free web dashboard for [AzuraCast](https://www.azuracast.com/).

The dashboard provides:

- Station selection and playback
- Compact and full views
- Current song, artist, artwork, progress, and next track
- Song history
- Song requests
- Real-time now-playing updates using AzuraCast's SSE feed
- Accurate per-track elapsed time for live streams
- Browser Media Session integration for compatible devices and vehicle head units

## Requirements

- An existing AzuraCast installation
- Public now-playing data enabled for the stations you want to display
- A web server capable of serving static HTML, CSS, and JavaScript

No Node.js, build system, framework, or database is required.

## Configuration

The repository does not contain a real deployment configuration.

Copy the example configuration:

```sh
cp config.js.example config.js
```

Then edit `config.js`:

```js
const DASHBOARD_CONFIG = {
    azuracastUrl: "https://radio.example.com",
    siteTitle: "My Radio Network"
};
```

If the dashboard is served from the same origin as AzuraCast, `azuracastUrl` can be empty:

```js
azuracastUrl: ""
```

This makes the dashboard use relative API paths such as `/api/nowplaying`.

`config.js` is intentionally ignored by Git. Do not put API keys, passwords, tokens, or other secrets in it.

## Deployment

Serve the repository directory as a normal static website. Make sure `config.js` exists alongside `index.html`, `app.js`, and `style.css`.

When the dashboard loads, it discovers the stations exposed by AzuraCast's public now-playing API. There is no station list to maintain in the dashboard configuration.

## CORS

When the dashboard and AzuraCast are hosted on different origins, the AzuraCast installation must allow the dashboard origin to access the required API endpoints.

Same-origin deployment is generally the simplest option because it avoids cross-origin API and SSE configuration.

## Security

This dashboard is a client-side application. It does not provide authentication for AzuraCast.

Do not add private credentials or authenticated AzuraCast API keys to the repository or to `config.js`.

The dashboard is intended to consume AzuraCast's public now-playing and station-facing endpoints. Access to the underlying AzuraCast installation should be secured independently.

## License

License to be selected.
