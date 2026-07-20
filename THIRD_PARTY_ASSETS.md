# Third-party brand assets

The files and remote assets below are trademarks of their respective owners. They are **not** licensed under UniJam's Apache-2.0 license. Do not recolor, crop, animate, combine, trace, or use them as UniJam decoration.

## Spotify

- Source: [Spotify Design & Branding Guidelines](https://developer.spotify.com/documentation/design)
- Official package: `https://developer-assets.spotifycdn.com/images/guidelines/design/2024-spotify-full-logo.zip`
- Retrieved: 2026-07-15
- Package SHA-256: `b3d28ef2474a46b88aeb67c1449b522046003233a3df59e8e63582830101270f`
- Included variants:
  - `public/brand/spotify/Full_Logo_Black_RGB.svg` — SHA-256 `895e187fe85d90228f4972ece378e9e9a8e6fb995ca59f8037ba1f37727bb611`
  - `public/brand/spotify/Full_Logo_White_RGB.svg` — SHA-256 `20ee3e587eb0891cccc595e617620a1943f1554e7291218e9158d3522457a3a9`
- Permitted UniJam contexts: isolated connection panel, Spotify-derived recording attribution that links to Spotify, native handoff link, and published Spotify playlist link.
- UI rules: use the full logo at no less than 70 CSS pixels wide; use black on light backgrounds and white on dark backgrounds; preserve the Spotify logo exclusion zone of half the icon height; never pair it decoratively with another provider mark. `ProviderBrand` reserves 14 CSS pixels around the standard 96-pixel logo, 10 pixels around the 70-pixel compact logo, and 18 pixels around the 126-pixel isolated connection logo. It fails closed unless linked artwork points to an HTTPS `open.spotify.com` track or playlist.

## Apple Music

- Source: [Apple Music Identity Guidelines](https://marketing.services.apple/apple-music-identity-guidelines)
- Official artwork URL: `https://marketing.services.apple/mdsa/assets/storage/blobs/images/6408fd8630506600073b0d7e/en-us-large@1x.png` (Apple's final asset URL; avoids a redirect that fails in some browsers)
- Retrieved and verified: 2026-07-15
- SHA-256: `09fec5baab2e9e90e570ef2b6913d88f3d2bdd26bd523172c5d3f4fdfdbddc1c`
- Variant: English “Listen on Apple Music” badge, 222×65 RGBA PNG.
- Permitted UniJam contexts: links to resolved Apple Music content and published Apple Music playlists only. Connection selectors use neutral UniJam artwork and the full text “Apple Music.”
- UI rules: the badge is loaded directly from Apple's official host so it remains unmodified; minimum digital height is 30 pixels; use only one badge in a communication and preserve its built-in border and clear space of at least one-tenth of the rendered badge height. `ProviderBrand` renders it at 33 CSS pixels or larger, reserves additional wrapper clear space, and fails closed unless the link points to HTTPS US Apple Music content on `music.apple.com`.
- Official in-app icon URL: `https://marketing.services.apple/mdsa/assets/storage/blobs/images/640a26dd7251da00075dc811/en-us-large@1x.png` (Apple's final asset URL; avoids a redirect that fails in some browsers)
- Retrieved and verified: 2026-07-17; SHA-256: `03a8d981587b5df151693858b035e2d53641882eb3192dd9b8ec78a6392169c3`; color icon, 112×112 RGBA PNG.
- Permitted UniJam context: the isolated Apple Music connection screen only, as an unmodified link to the US Apple Music page. Apple's guidelines expressly permit the supplied icon for an in-app Apple Music link where a badge does not fit. It is never displayed on the neutral multi-service chooser or beside Spotify branding.

## Compliance ownership

`ProviderBrand` in `app/components/product.tsx` is the only component authorized to render provider artwork. Its type surface restricts provider, artwork variant, background, purpose, and link requirements. Generic “either service” or “both services” states must use neutral UniJam symbols and text.
