# Vertex — Firebase login & registration

A responsive HTML/CSS/JavaScript interface connected to Firebase Authentication in project `waicy-9666a`.

## Features

- Email/password registration, including a display name.
- Login and a signed-in account view.
- Firebase-managed sessions: “Remember me” uses local persistence; unchecked uses tab/session persistence.
- Logout, inline validation, loading states, safe error messages, and password visibility.
- Password reset through Firebase's hosted email action page.
- Google/GitHub controls are omitted because those providers are not enabled in this project.

## Run locally

Run `python3 -m http.server 4173 --directory dist` from this folder, then visit `http://localhost:4173`. Serve over HTTP locally or HTTPS in production; do not open the HTML as a `file://` URL.

There is no build step. `dist/firebase-client.js` imports Firebase's modular Web SDK v12.19.0 from the official CDN. `dist/firebase-config.js` contains the public configuration retrieved from the existing Firebase Web App.

## Authentication and credentials

Firebase is the managed authentication backend. Account creation, password checks, reset emails, profiles, and token refresh run through Firebase Authentication. Passwords are sent directly to Firebase over HTTPS; this site never saves or logs them. Session tokens are managed by the Firebase SDK according to the user's persistence choice.

The supplied Admin SDK service-account file remains outside this repository and the deployed static assets. It was used locally to inspect/configure the project. It is not required at runtime and must never be put in `dist`, committed, or sent to visitors. `.gitignore` excludes common service-account filenames.

The public Firebase web configuration/API key identifies the project; it is not the Admin SDK credential. Future application data/API endpoints must independently verify Firebase ID tokens or enforce Firebase Security Rules. Hiding the login UI is not an authorization boundary.

The login page is published for public access so anyone with the link can create their own Firebase account or sign in. Firebase still checks credentials before returning an authenticated session.

## Documentation

- [Firebase email/password authentication](https://firebase.google.com/docs/auth/web/password-auth)
- [Managing users and password reset](https://firebase.google.com/docs/auth/web/manage-users)
- [Session persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- [Web API keys](https://firebase.google.com/docs/projects/api-keys)
