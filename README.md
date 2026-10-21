# Spending Tracker

A simple app for your phone and laptop that reads your bank's transaction alert emails in Gmail and shows a total for each day and each week, in AED or USD.

## Privacy
- It only searches Gmail for emails **from the bank addresses you list** (`from:(...)` query).
- For each email it asks Gmail only for the **message body and received time**, not the subject, the sender or other headers.
- It keeps only **amount, currency and date/time**. The email text is thrown away straight after reading.
- There's no server. Data is stored in your browser on each device (localStorage). The Google sign-in token is held in memory only.
- Note: the Google permission is `gmail.readonly`, because Gmail has no permission limited to certain senders. The sender limit is enforced by this app's code (`app.js`, `sync()`).

## One-time Google setup (about 10 minutes)
1. Go to https://console.cloud.google.com, then **create a new project** (e.g. "Spending Tracker").
2. **APIs & Services → Library**: search for "Gmail API" and click **Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type: **External**. App name: Spending Tracker. Use your email for the contact fields.
   - Scopes / Data access: add `https://www.googleapis.com/auth/gmail.readonly`.
   - **Audience / Test users**: add your Gmail address. Leave the app in **Testing**. Only you can sign in, and it doesn't need Google's review.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**
   - Authorized JavaScript origins: `http://localhost:8000` and (later) `https://<your-github-username>.github.io`
5. Copy the **Client ID** into `config.js` (`GOOGLE_CLIENT_ID`).
6. Put your bank's sender address(es) in `config.js` (`DEFAULT_SENDERS`) or in the app's **Settings**.

When you first sign in, Google will warn that the app is "unverified". That's expected for your own test app: click **Continue**.

## Run on your laptop
```sh
cd ~/spending-tracker
python3 -m http.server 8000
```
Open http://localhost:8000, then tap **Sync**.

## Put it on your phone (GitHub Pages, free)
1. Create a new GitHub repository (e.g. `spending-tracker`) and upload these files.
2. Repo **Settings → Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Open `https://<username>.github.io/spending-tracker/` on your phone.
4. Add it to the home screen: **iPhone**: Share → Add to Home Screen. **Android**: ⋮ → Install app / Add to Home screen.

The Client ID is not a secret, so it's fine for it to be in a public repo. Only your test-user Gmail can sign in.

## Using it
- **Sync**: fetches new bank emails since your last sync. The first sync looks back 90 days. Emails are never counted twice.
- **Currency**: shows totals for AED or USD only. The two are never added together.
- Weeks run **Monday to Sunday**.
- Phone and laptop each sync on their own from Gmail.
- If an email shows "skipped (no amount found)", the parser in `app.js` (`parseAmount` / `parseDate`) needs adjusting for your bank's wording.
- Note: every amount in the bank emails is counted as spending. If your bank also sends alerts for money coming in, the parser needs a rule to skip those.
