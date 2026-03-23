# Docs Upload Portal

A React website where you can upload markdown files, auto-group them into sections, and browse them as a learning portal.

## Features

- Upload multiple .md files.
- Upload a whole folder and keep structure (top-level folder becomes section).
- Pull markdown docs directly from a public GitHub repository.
- Auto sidebar generation by section.
- Markdown rendering with GFM support (tables, checkboxes, strikethrough).
- Local persistence in browser storage.
- Export and import full library as JSON for reuse.

## Run locally

1. Create .env from .env.example and set Supabase values.

2. Install dependencies:

```bash
npm install
```

3. Start dev server:

```bash
npm run dev
```

4. Build for production:

```bash
npm run build
```

## Supabase GitHub login setup

1. Create a Supabase project.
2. In Auth -> Providers, enable GitHub.
3. In GitHub Developer Settings, create an OAuth App.
4. Put GitHub client ID and secret in Supabase provider config.
5. Add your app URL (for local dev: http://localhost:5173) as redirect URL.
6. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.

After that, users can click Login with GitHub and use Fork + Sync without manual PAT.


## Naming conventions for cleaner sections

- Folder upload: top-level folder name is used as section title.
- Single file upload: files go to General unless filename includes section prefix.
- Optional pattern for file names: Section__Topic.md
	- Example: Core_Concepts__Tokens_Context_Temperature.md

## Pull from GitHub

1. Paste a GitHub repository URL or owner/repo in the input.
2. Click Pull from GitHub.
3. The app scans the default branch and imports markdown files.

Notes:

- Current flow supports public repositories.
- For performance and API safety, imports are capped to the first 120 markdown files found.
- Top-level folders in the repository become sections in the sidebar.

## Fork + Sync (GitHub account workflow)

This is useful when you want users to always work from their own fork.

1. Login with GitHub in the app.
2. Enter source repository URL.
3. Click Fork + Sync to My Account.
4. App creates/uses fork in your account and imports docs from your fork.

Security note:

- OAuth is handled by Supabase (no custom backend needed).
- A provider token may be cached in browser session storage so fork/sync can call GitHub APIs after login.

## Reuse flow

1. Upload your markdown files.
2. Click Export library to download docs-library.json.
3. On another machine or browser, click Import library and select that file.
