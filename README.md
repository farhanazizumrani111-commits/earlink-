# EarLink

Live speech translator for Bluetooth earbuds. Your phone listens to the people around you and speaks the translation into your earbuds, with on-screen subtitles. Works in 70+ languages.

**Created by Farhan.**

It's an installable web app (PWA): open the link on a phone, add it to the home screen, and it runs like a normal app.

## How it works

Phone mic → Google **Gemini Live Translate** → translated speech in your earbuds.

- **Just me:** everything around you is translated into one language you pick.
- **Two-way:** one language per earbud. The left earbud hears the other side in the left language; the right earbud hears the other side in the right language. You give one earbud to a friend and talk freely — no buttons.
- Mic sensitivity (Normal / High / Max), automatic language switching, loop guard, per-language colours, cyberpunk design.

## Setup

1. Get a free Gemini API key at <https://aistudio.google.com/apikey>.
2. Open this app's link on your phone, add it to the home screen.
3. Open it, tap the ⚙ gear, paste your key.
4. Connect your earbuds and tap the button.

The API key is stored **only on your phone**, never in this code.

## Hosting (GitHub Pages)

The app is plain static files (no build step). To publish:

1. Repo **Settings → Pages**.
2. **Source:** Deploy from a branch → **main** → **/ (root)** → Save.
3. The link appears at the top of the Pages settings after a minute.

To update: replace the files and push to `main`; Pages redeploys automatically. No build, no credits.

## Files

| File | Purpose |
|---|---|
| `index.html` | The screen and all styling |
| `app.js` | Mic capture, translation connection, playback, settings |
| `capture-worklet.js` | Converts the mic to 16 kHz audio |
| `manifest.json`, `sw.js` | Make it installable + work offline |
| `fonts/` | Bundled fonts (Chakra Petch, Share Tech Mono) |
| `icon*` | App icons |

Model: `gemini-3.5-live-translate-preview`.
