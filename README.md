# RescueRoute

RescueRoute is a Manila city access map with Firebase sign-in, a street node and edge editor, shortest-path routing, AI-assisted street graph creation, community photo reports, and authenticated photo analysis.

## Stack

- Next.js App Router with Node.js route handlers for the backend.
- The existing responsive map interface, served as a static frontend from `public/legacy` while its UI is migrated into Next.js components.
- Leaflet and OpenStreetMap tiles.
- Firebase Authentication and Cloud Firestore for the shared Manila node-and-edge graph. Existing `connectors` records are still read while they migrate to `edges`.
- A* routing uses edge geometry and geographic distance, respecting the selected travel mode.
- Signed-in users can outline a small map area; a Node.js route handler fetches OpenStreetMap roads and asks the server-side OpenAI model to identify connected intersections before adding nodes and edges.
- Browser IndexedDB for field photos and their analysis results.
- OpenAI Responses API for photo analysis, called only from the Node.js backend.

## Run locally

Use Node.js 20.9 or newer. Install dependencies with `pnpm install`, then start Next.js with `pnpm dev` and open `http://localhost:3000`.

Copy `.env.example` to `.env.local` and fill in the values to configure photo analysis and Firebase. Keep `.env.local` out of source control. Firebase web settings are served to the browser at runtime from `/api/firebase-config`; Firebase web API keys and project identifiers are public configuration, while `OPENAI_API_KEY` stays on the server. The shared map uses Firestore document `cityMaps/manila`. `.firebaserc` links this project to `waicy-9666a`; `firebase.json` deploys the merged Firestore rules for both the existing per-user route graph and the shared Manila map. All signed-in app users can edit the shared map. Firestore rules deployments replace the project's full ruleset, so preserve both rule blocks when making future changes.

Deploy rules with `pnpm dlx firebase-tools deploy --only firestore:rules --project waicy-9666a` from an authenticated Firebase CLI session.

`GET /api/health` reports whether photo analysis and Firebase configuration are present. `POST /api/analyze` checks the Firebase ID token, accepts JPEG, PNG, and WebP images up to 10 MB, and limits each user to 30 analysis requests per hour per running Node.js process.

The map uses illustrative road overlays. Confirm local access restrictions before travel. OpenStreetMap tiles are requested only for the visible map area and are shown with contributor attribution.
