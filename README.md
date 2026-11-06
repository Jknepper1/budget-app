# Budget

A simple shared monthly budget for two phones. Log purchases and paychecks from a
home-screen app, set a budget per category, and see how each month compares to
your income. Your data lives in a Google Sheet you own.

- **The app** is the `docs/` folder, hosted free on GitHub Pages. It holds no data.
- **The backend** is `apps-script/Code.gs`, which runs inside your Google Sheet.
- **Your data** stays in that Sheet, in four tabs: Purchases, Income, Budgets, and Bills.

The app's code is public, but your data, passcode, and web app address are not in
this repository. Each phone stores them only on that phone.

## Setup

### 1. Create the backend (about 5 minutes, on a computer)

1. Go to [sheets.new](https://sheets.new) and name the new Sheet "Budget".
2. Choose **Extensions > Apps Script**.
3. Delete the sample code, then paste in all of `apps-script/Code.gs`.
4. On the `const PASSCODE = 'CHANGE-ME';` line, replace `CHANGE-ME` with your own
   passcode. Use something long, since it protects your budget data.
5. Click **Save**. In the function menu at the top, choose `setup`, then click **Run**.
6. Approve Google's prompts. Google warns that the app isn't verified because it's
   your own script. Choose **Advanced**, then **Go to (project name)**, then **Allow**.
   When it finishes, the Sheet has its four tabs.
7. Click **Deploy > New deployment**. Click the gear icon and choose **Web app**.
   - **Execute as:** Me
   - **Who has access:** Anyone
8. Click **Deploy**, then copy the **Web app URL**. It ends in `/exec`.

To check it, open that URL in a browser. You should see text that includes `"ok":true`.

"Anyone" means the address can be reached without a Google sign-in, which is what
lets the app connect. Nothing can be read or changed without your passcode.

### 2. Set up each phone

Send yourself and your partner the web app URL and the passcode. Then, on each phone:

1. Open **https://jknepper1.github.io/budget-app/**.
2. Add it to the home screen. Do this before connecting, because some phones keep the
   home-screen app's storage separate from the browser's.
   - **iPhone (Safari):** Share button > **Add to Home Screen**
   - **Android (Chrome):** Menu > **Add to Home screen** or **Install app**
3. Open the app from the new icon.
4. Paste the web app URL, then enter the passcode and your name.

## Good to know

- **No signal:** Purchases save on the phone and sync the next time the app is open
  with a connection.
- **Editing the Sheet:** You can edit the Sheet directly, and new rows you type there
  show up in the app. Leave the header row and the ID column as they are.
- **Fixed bills:** Each bill is recorded once a month on its day. Deleting one of those
  purchases skips that month only.
- **New months:** Budgets copy from the previous month, and spending starts from zero.

## Changing the passcode or updating the script

Changes to `Code.gs` don't take effect until you publish a new version:

1. Edit the script and save.
2. Click **Deploy > Manage deployments**, then the pencil icon.
3. Under **Version**, choose **New version**, then click **Deploy**.

The web app URL stays the same. If you changed the passcode, update it on each phone
in the app's Settings.

## Development

Requires Node. There's nothing to install.

```bash
npm test
```

```bash
npm run dev
```

`npm test` runs the real `Code.gs` against a fake spreadsheet. `npm run dev` serves the
app at http://localhost:8787 with the same fake backend. Connect using the address
`http://localhost:8787/mock/exec` and the passcode `demo-passcode`.
