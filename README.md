# Asana to Plaky Migrator

Moves your Asana projects to [Plaky](https://plaky.com): projects become boards, sections become groups and tasks become items,
with their fields, people, comments and files.

## Steps

1. Install [Bun](https://bun.com/docs/installation) 1.3.14 or newer. Open a terminal (on macOS the Terminal app, on Windows
   PowerShell) and run:
   - macOS, Linux: `curl -fsSL https://bun.com/install | bash`
   - Windows: `powershell -c "irm bun.sh/install.ps1|iex"`
2. Create an Asana personal access token: in the [Asana developer console](https://app.asana.com/0/my-apps), **Create new
   token**. Asana shows the token once, so copy it and keep it until the move is finished.
3. Create a Plaky API key: in Plaky, your profile picture → **Preferences → Advanced → Manage API keys → Generate API key**.
   Keep it with the token. The boards go into a Plaky space on a Pro plan or trial.
4. Open a terminal in this folder: type `cd` and a space, drag this folder into the terminal window, and press Enter. Then start
   the app:
   - macOS, Linux: `~/.bun/bin/bun run launch`
   - Windows, in a new PowerShell window: `bun run launch`

   The first start takes about two minutes, then the app opens in your browser. Keep the terminal open while you work.
5. Follow the page: **Connect**, **Set up boards**, **Move**, **Finish**.
6. At the end, save the report and the task archive (open `archive/index.html` in it).

To continue after you stop, do step 4 again, choose your migration under **Continue a migration**, and enter the two keys again.

Automations, formulas, portfolios and reactions do not move. Files over 100 MB do not move, because Plaky does not take them:
the task archive names each one, so you can save it from Asana yourself.

## License

[MIT](LICENSE)
