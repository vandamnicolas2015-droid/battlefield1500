# Battlefield 1500

A browser-based battlefield game with bow-and-arrow combat, offline bot matches,
local duels across three maps, a separate walkable open public lobby, private
room codes, and chat.

## Run locally

Install Node.js 18 or newer, then run:

```sh
npm install
npm start
```

Open `http://localhost:8080` in Chrome. Online multiplayer works between devices
only when they can reach the same server. On one Wi-Fi network, open the server
computer's local network address (for example `http://192.168.1.20:8080`) on
the other device and allow inbound connections to port 8080 in the computer's
firewall. Choose **Public Lobby** to join the shared walkable lobby without a
room code. It allows up to 64 simultaneous players.

## Publish for internet play

This project includes a WebSocket server; a static website host alone cannot run
its multiplayer rooms or chat. One deployment option is Render:

1. Put this project in a GitHub repository.
2. In Render, create a **Blueprint** from that repository. The included
   `render.yaml` supplies the Node service configuration.
3. Deploy, then share the generated HTTPS URL. WebSocket connections use secure
   `wss://` automatically on HTTPS.

All players must open the same deployed URL. The public lobby is open to anyone
with that URL; private rooms use a five-character room code. The free hosting
tier may sleep while idle, so the first connection after an idle period can
take a little while.

## Accounts and online wins

Accounts use a username and password. Passwords are stored as salted scrypt
hashes, not as readable text. The game remembers a signed-in account on that
browser for 30 days. Usernames cannot be changed and there is no password
recovery email, so players should keep their password private and remember it.
Private online battles require an account; guest players may still enter the
public lobby. Decisive private online battle wins are saved to the leaderboard.
Draws, bot matches, local duels, and public-lobby time do not count as wins.

The Render web service needs a persistent PostgreSQL database to save accounts
and wins. To keep hosting costs at zero, this setup can use a free Neon database:

1. Create a free PostgreSQL project at [Neon](https://neon.tech/).
2. Copy its pooled connection string from the Neon dashboard. Treat it as a
   password; do not post or commit it.
3. In Render, open the `battlefield-1500` service, choose **Environment**, and
   add `DATABASE_URL` with that connection string as the value.
4. Save the environment change and redeploy. The game creates its account and
   session tables automatically at startup.

The Render Blueprint marks `DATABASE_URL` as a secret that must be supplied
outside the repository. Without it, the game still runs, but account creation,
sign-in, the leaderboard, and ranked private battles are unavailable.

## Appear in Google Search

The page title, search description, social sharing tags, and `robots.txt` are
configured. A public deployment is still required before Google can visit it.
After deploying, add the site in Google Search Console, verify ownership, and
request indexing for the exact deployed URL. Search indexing and ranking are
controlled by Google and are not immediate or guaranteed. A custom domain
containing `battlefield-1500` can make the address easier to share, but it does
not guarantee a particular search position.
