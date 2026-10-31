# RescueRoute — city access and field photos

A responsive RescueRoute city map with road-access overlays, Firebase Authentication, and a photo upload page.

## Features

- Seoul city map with main road, motorcycle road, and footpath overlays, travel-mode filters, place search, and current location.
- Email/password registration, login, password reset, and signed-in account view through Firebase Authentication.
- Photo submission with captions, previews, file validation, and an admin gallery.
- OpenAI vision analysis runs automatically when a photo is uploaded. The admin gallery keeps the original photo and displays the findings beneath it, with a retry action if analysis is temporarily unavailable.
- Photos are stored in IndexedDB in the current browser, so they remain available after reloads on this device. They do not sync to other devices and can be cleared if browser site data is removed.

## Run locally

Run `python3 server.py` from this folder, then visit `http://localhost:4173`. The server hosts `dist/` and provides the authenticated `/api/analyze` endpoint. Serve over HTTP locally or HTTPS in production; do not open the HTML as a `file://` URL.

The server reads `OPENAI_API_KEY` from the environment. For this workspace it also accepts the existing `GPT_API_KEY=...` entry in the parent `logncode.txt` file. The key stays server-side and is never sent to the browser. Uploaded images are sent to OpenAI for analysis; the returned findings are saved alongside each photo in IndexedDB. The analysis endpoint validates the Firebase sign-in token and limits each account to 30 analyses per hour. Firebase's modular Web SDK and map tiles are loaded from their online providers. `dist/firebase-config.js` contains the public configuration for the existing Firebase Web App.

The map uses the standard `https://tile.openstreetmap.org/{z}/{x}/{y}.png` endpoint. It shows visible OpenStreetMap contributor attribution and sends a valid origin referrer. Leaflet requests tiles for the visible map area and the browser handles caching according to the tile server's response headers. The app does not prefetch or save tiles for offline use. Serve the site over HTTP or HTTPS; opening the HTML as a `file://` URL does not provide a usable web referrer.

## Authentication, photos, and credentials

Firebase Authentication manages accounts and sessions. Passwords are sent directly to Firebase over HTTPS; this site never saves or logs them. Photo files and their captions/uploader metadata are stored locally in browser IndexedDB. The gallery UI is limited to `bychang408@gmail.com`, but this local-only arrangement is not a secure shared archive: browser data is tied to the device and website origin, and anyone with access to that browser profile can inspect its local data.

The Firebase Admin SDK service-account file is not needed at runtime and must never be put in `dist`, committed, or sent to visitors. `.gitignore` excludes common service-account filenames. The public Firebase web configuration/API key identifies the project; it is not the Admin SDK credential.

The public site allows anyone with its link to create an account or sign in. The map uses illustrative road overlays; confirm local road access before travel.

## Documentation

- [Firebase email/password authentication](https://firebase.google.com/docs/auth/web/password-auth)
- [Managing users and password reset](https://firebase.google.com/docs/auth/web/manage-users)
- [Session persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- [Web API keys](https://firebase.google.com/docs/projects/api-keys)
