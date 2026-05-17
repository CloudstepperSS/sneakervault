# SneakerVault

A mobile-first sneaker inventory app. Photograph a shoe, Claude AI identifies it, all details are filled in automatically.

---

## Files

```
sneaker-vault/
├── index.html      ← Main HTML (single page app)
├── style.css       ← All styles
├── app.js          ← All JavaScript logic
├── schema.sql      ← Supabase database schema
└── README.md       ← This file
```

---

## Setup — Step by step

### 1. Supabase (database + photo storage)

1. Go to https://supabase.com and create a free project
2. In the SQL Editor, paste and run the entire contents of `schema.sql`
3. Go to **Storage** → **New bucket** → name it `sneaker-photos` → set it to **Public**
4. Note your **Project URL** and **anon public key** from Settings → API

### 2. Anthropic API key

1. Go to https://console.anthropic.com and create an API key
2. Note: this key will be in the client-side JS — for a private personal app this is fine.
   For a shared app, route the API call through a small backend/edge function instead.

### 3. Configure the app

Open `app.js` and replace the three placeholders at the top:

```js
const SUPABASE_URL      = 'YOUR_SUPABASE_URL';       // e.g. https://xxxx.supabase.co
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';  // starts with eyJ...
const ANTHROPIC_KEY     = 'YOUR_ANTHROPIC_API_KEY';  // starts with sk-ant-...
```

### 4. Deploy to GitHub Pages

```bash
# Create a new GitHub repo (e.g. sneaker-vault)
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/sneaker-vault.git
git push -u origin main

# Then in GitHub: Settings → Pages → Source: Deploy from branch → main → / (root)
```

Your app will be live at: `https://YOUR_USERNAME.github.io/sneaker-vault`

---

## How to use

1. **Sign up / sign in** with your email
2. Tap **+ Add sneaker** — your camera opens
3. **Photograph the shoe** (or pick from gallery)
4. Claude AI **identifies** the shoe and fills in brand, model, colorway, type, release price and resell value
5. **Review the details**, add your EU size and year purchased, then tap **Save**
6. Your shoe appears in the **grid** with your photo
7. Tap any shoe to see the **detail sheet** with full info and ROI
8. Tap **Stats** in the tab bar for collection analytics

---

## Features

- Camera-first AI identification via Claude Vision
- EU sizes and € prices
- Search, filter by brand/type, sort by multiple criteria
- Collection stats: total cost, resell value, ROI, brand breakdown
- Photos stored in Supabase Storage
- Fully offline-capable once loaded (PWA-ready)
- Works on iPhone and Android browsers

---

## Notes

- The AI identification works best with a clear, well-lit photo of the full shoe
- Release and resell prices are estimates — always verify on StockX/GOAT
- Data is private per user account via Supabase row-level security
