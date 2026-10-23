# RescueRoute — city access and field photos

A responsive RescueRoute city access map with Firebase Authentication and a secure field photo upload page in project `waicy-9666a`.

## Features

- Seoul city map with separate main road, motorcycle road, and footpath overlays.
- Vehicle mode filters, city search, map controls, and a user-initiated current-location option.
- Email/password registration, login, password reset, and a signed-in account view.
- Photo uploads with captions, previews, size/type validation, and a private admin gallery.
- Firebase Storage holds uploaded photos across devices and sessions. Storage rules allow signed-in users to add images, while only the verified admin email can read or delete them.

## Run locally

Run `python3 -m http.server 4173 --directory dist` from this folder, then visit `http://localhost:4173`. Serve over HTTP locally or HTTPS in production; do not open the HTML as a `file://` URL.

There is no build step. `dist/firebase-client.js` imports Firebase's modular Web SDK v12.19.0 from the official CDN. `dist/firebase-config.js` contains the public configuration retrieved from the existing Firebase Web App.

## Authentication, photos, and credentials

Firebase Authentication manages accounts and sessions. Passwords are sent directly to Firebase over HTTPS; this site never saves or logs them. Session tokens are managed by the Firebase SDK according to the user's persistence choice. Firebase Storage stores uploaded photo files and their caption/uploader metadata.

`storage.rules` is the server-side access boundary. Replace `ADMIN_EMAIL_PLACEHOLDER` with the designated Firebase account email before deployment and deploy the rules to project `waicy-9666a`. The browser-side `dist/photo-config.js` must use the same email for the admin interface; it only controls the display, while Firebase Storage rules enforce access. Uploads remain paused until both are configured.

The supplied Admin SDK service-account file remains outside this repository and the deployed static assets. It was used locally to inspect/configure the project. It is not required at runtime and must never be put in `dist`, committed, or sent to visitors. `.gitignore` excludes common service-account filenames.

The public Firebase web configuration/API key identifies the project; it is not the Admin SDK credential. Future application data/API endpoints must independently verify Firebase ID tokens or enforce Firebase Security Rules. Hiding the login UI is not an authorization boundary.

The public Site allows anyone with its link to create an account or sign in. Photo archive access remains restricted by Firebase Storage rules.

## Documentation

- [Firebase email/password authentication](https://firebase.google.com/docs/auth/web/password-auth)
- [Managing users and password reset](https://firebase.google.com/docs/auth/web/manage-users)
- [Session persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- [Web API keys](https://firebase.google.com/docs/projects/api-keys)
