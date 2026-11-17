# 📚 Bookshelf Scanner → Libib Importer

A simple web app that lets you **photograph your bookshelf**, identifies the books using AI vision, looks up ISBNs, and exports a **Libib-compatible CSV** you can import directly into your library.

## How It Works

1. **Snap a photo** of your bookshelf (or upload an existing image)
2. **GPT-4o Vision** reads the book spines and identifies titles & authors
3. **Open Library** lookup enriches each book with ISBN-13, ISBN-10, cover art, publish year, and page count
4. **Review & edit** the results, then download a CSV
5. **Import the CSV** into Libib at [libib.com/importing](https://www.libib.com/importing)

## Setup

### Prerequisites

- **Node.js** 18+ installed
- An **OpenAI API key** with access to GPT-4o ([get one here](https://platform.openai.com/api-keys))

### Install & Run

```bash
cd bookshelf-scanner

# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env and paste in your OpenAI API key

# 3. Start the server
npm start
```

Open **http://localhost:3000** in your browser (works great on mobile too!).

## Importing into Libib

1. In the app, scan your bookshelf and download the CSV
2. Go to [libib.com](https://www.libib.com) → your library → **Import**
3. Choose **CSV Upload** and select the downloaded file
4. Map the columns (the CSV already matches Libib's expected format)
5. Click Import — done!

## Tips for Best Results

- **Good lighting** makes a huge difference for spine readability
- **Photograph straight-on** to minimize distortion
- Take **multiple photos** of different shelf sections rather than one wide shot
- Thick or colorful spines are recognized more reliably than thin paperbacks
- You can always **manually add** books the AI missed

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend   | Node.js + Express |
| AI Vision | OpenAI GPT-4o |
| Book Data | Open Library Search API |
| Frontend  | Vanilla HTML/CSS/JS |
| Export    | Libib-compatible CSV |

## Browser Extension (Dev Plugin)

A Manifest V3 Chrome extension lives in `browser-extension/`. It gives you quick access to the scanner from any Chrome tab without opening the full web app — handy during development.

### Load the extension in Chrome

```bash
# 1. Generate the icons (one-time, needs the server deps installed)
npm install
node browser-extension/generate-icons.js

# 2. Start the dev server so the extension has something to talk to
npm run dev
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `browser-extension/` folder
4. Click the extension icon in the toolbar — the popup opens

### Configure the server URL

By default the extension points to `http://localhost:3000`. To change it:

- Right-click the extension icon → **Options**, or
- Click the ⚙️ icon inside the popup

Enter your Vercel deployment URL to use the extension against production.

### Extension files

```
browser-extension/
  manifest.json          # Chrome Manifest V3
  popup.html / .js / .css  # Extension popup UI
  options.html / .js     # Settings page (server URL)
  generate-icons.js      # One-time icon generator (uses Sharp)
  icons/                 # Generated PNG icons (16, 48, 128 px)
```

## Cost

Each photo scan uses one GPT-4o vision request. At current pricing that's roughly **$0.01–0.04 per photo** depending on resolution.
