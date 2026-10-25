# People's Jury ⚖️

**Two sides. You decide.** A free web app for friendly, everyday disagreements:

1. One person starts a case (types or records their side) and gets a private link.
2. The other person opens the link and adds their side.
3. The case goes public with a fair, neutral AI summary of both sides.
4. Anyone votes **1** or **2**. When time is up, the jury's verdict is in, and there's a shareable verdict card.

For fun, not a legal ruling. First names only. No real crimes or legal matters.

## How it works (no servers, no sign-ups)
- Static site on GitHub Pages; installable as an app (PWA).
- Cases and votes are signed events (kind 30078, app data) on free public Nostr relays. No account or key needed; each device gets its own signing key automatically.
- One vote per device: device key (kept in localStorage, a cookie and IndexedDB) plus a browser fingerprint and a short hash of the network. The two people in a case can't vote on it.
- AI summaries and verdict lines use the free Pollinations text API.
- Demo mode (everything stays on one device): add `?demo=1` to the URL. Test namespace: `?ns=test`.
