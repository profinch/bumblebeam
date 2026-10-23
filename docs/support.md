# Support: tickets in /dash, from mail and from a form on the site

Status (2026-10-23): **design, nothing built yet.** Three parts, built in this order: (1) a mail client for
`support@bumblebeam.org` inside the operator's dashboard, (2) tickets on top of it, linked to miners, (3) a support
form on pool.bumblebeam.org that opens tickets directly. Telegram (@BumbleBeam_bot) tells the operator about new
tickets and replies.

## Why in /dash and not a helpdesk

A pool's support questions are about a miner: "my payout did not arrive", "my rig shows 0 H/s", "which port".
The answer is in the pool's own data - balance, payments, connections, shares, workers - which `/dash` already
shows through `/api/admin/miners/:id`. A ticket that opens next to the miner's card saves the lookup on every
question. Off-the-shelf helpdesks (FreeScout, Zammad) cannot do that, add a second login and a second stack
(PHP / Elasticsearch) to patch.

Mail stays in mailcow (mail.ultp.org): the support service is a mail client of the mailbox, like SOGo. Nothing is
lost if the service is down, and SOGo still shows everything.

## Architecture

```
mail ──► mailcow ─IMAP IDLE─► support ──► postgres (schema support)
form ──► pool-web /support ─POST /api/support/form─┘   │
/dash  ──── /api/support/* (Bearer admin token) ───────┤
support ─SMTP 587─► mailcow ──► customer               │
support ─HTTPS─► api.telegram.org (@BumbleBeam_bot) ◄──┘
```

- **A service of its own**, container `support` in `compose-bumblebeam.yaml`, not code in `bumblebeam-pool`.
  Parsing mail and attachments must never restart or slow the stratum or the app (`docs/pool-split.md`: releases
  should not touch the miners). Node, like `explorer-api`, but with dependencies, pinned: `imapflow` (IMAP + IDLE),
  `mailparser` (MIME), `nodemailer` (SMTP), `pg`, `sanitize-html`. Writing MIME and IMAP by hand is not worth it.
- **Routing:** the host nginx (host network) sends `pool.bumblebeam.org/api/support/` to the service on
  `127.0.0.1:8092` (a longer prefix than its `/api/` → pool-app `127.0.0.1:8080`, so it wins); pool-web serves the `/support` page; `/dash` gets a Support tab. Same origin, so the CSP of
  `/dash` (`connect-src 'self'`) needs no change.
- **Auth:** the same operator token as `/api/admin/*` (`Authorization: Bearer`, constant-time compare), read from
  the same secret. One operator for now; per-operator accounts and assignment come only if a second person answers.
- **Database:** the pool's Postgres, schema `support`, role `support` with full rights on that schema and
  `SELECT` on `public.miners` only. The pool never reads the support schema.

## 1. Mail client

- Mailbox `support@bumblebeam.org` in mailcow, IMAP/SMTP with an **app password** (mailcow app passwords, so the
  mailbox password itself is not in the service). Secrets in `/data/bumblebeam/secrets/support.env`.
- **In:** IMAP IDLE on INBOX (plus a full resync every 10 min and at start). Each new message is parsed, stored,
  then moved to the IMAP folder `Tickets` (created by the service). Import is idempotent: unique on `Message-ID`
  (or a hash of the raw message when it has none), so a crash between the insert and the move only repeats a no-op.
- **Out:** SMTP submission `mail.ultp.org:587` STARTTLS as support@. Replies carry `In-Reply-To` / `References`
  of the thread and `[BB-<id>]` in the subject; a copy is appended to `Sent` over IMAP so SOGo shows it too.
  Every mail goes through mailcow, so it is DKIM-signed `d=bumblebeam.org` (see DNS below).
- **Not imported:** DMARC aggregate reports, bounces (`MAILER-DAEMON`, `multipart/report`), auto-replies
  (`Auto-Submitted: auto-*`, `Precedence: bulk|list|auto_reply`) - they go to the folder `Ignored`, no ticket, no
  notification. No auto-reply of ours to them either (mail loops).
- **Attachments:** stored on disk in `/data/bumblebeam/support/files/<sha256>`, metadata in the DB; up to
  mailcow's 100 MB per message. The dash downloads them through the API with `Content-Disposition: attachment`,
  never inline.
- **HTML mail is untrusted input on the page that holds the operator token.** The dash shows `text/plain` by
  default; HTML is sanitized on the server (no scripts, styles, forms, remote images) and shown on demand in a
  sandboxed iframe (`sandbox` without `allow-scripts`, `srcdoc`). The `/dash` CSP (`script-src 'self'`) is the
  second line.

## 2. Tickets

```sql
CREATE TABLE support.tickets (
  id BIGSERIAL PRIMARY KEY,                -- shown as BB-<id>
  status TEXT NOT NULL DEFAULT 'new',      -- new | open | waiting | closed
  source TEXT NOT NULL,                    -- mail | form
  subject TEXT NOT NULL,
  category TEXT,                           -- payout | connection | account | other (form; mail: null)
  requester_email TEXT NOT NULL, requester_name TEXT,
  miner_id BIGINT,                         -- public.miners.id, auto or by hand
  miner_link TEXT,                         -- auto | manual
  created BIGINT NOT NULL, updated BIGINT NOT NULL,
  last_customer BIGINT, last_operator BIGINT);
CREATE TABLE support.messages (
  id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL REFERENCES support.tickets,
  kind TEXT NOT NULL,                      -- in | out | note (internal, never mailed)
  message_id TEXT UNIQUE, in_reply_to TEXT, refs TEXT,
  from_addr TEXT, to_addr TEXT, subject TEXT,
  text TEXT, html_clean TEXT, created BIGINT NOT NULL);
CREATE TABLE support.files (
  id BIGSERIAL PRIMARY KEY, message_id BIGINT NOT NULL REFERENCES support.messages,
  name TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, sha256 TEXT NOT NULL);
```

- **Threading** of an incoming mail, first match wins: `[BB-<id>]` in the subject → `In-Reply-To` / `References`
  pointing at a stored `message_id` → otherwise a new ticket. (Not by sender + subject: two questions from one
  person would merge.)
- **Statuses:** a new ticket is `new`; the operator's first reply makes it `waiting` (on the customer); a customer
  reply makes it `open` again, also from `closed`; the operator closes by hand. Optional later: `waiting` with no
  answer for 14 days closes itself.
- **Link to a miner:** the text and subject are scanned for Beam addresses (the stratum login form
  `address[.worker]`; exact match against `miners.address`, so a random hex string links nothing). One match →
  `miner_link = auto`; several → the dash offers them; the operator can link or unlink by hand (`manual` wins over
  later auto). The ticket view shows the miner's card from the existing `/api/admin/miners/:id` (balance, paid,
  workers, connections, last share) - the dash calls the pool API itself, the support service does not proxy it.
- **Dash tab Support:** list with status filter, search (subject, email, address), counts per status; ticket view
  with the thread, reply box, internal note, status buttons, miner card, attachments. Keyboard: `j/k`, `r` reply.
  Later: canned replies (payout schedule, ports, NiceHash settings), stored in the DB.
- **API** (`/api/support/*`, all with the operator token except `form`):
  `GET tickets?status=&q=&limit=`, `GET tickets/:id`, `POST tickets/:id/reply {text}`,
  `POST tickets/:id/note {text}`, `POST tickets/:id/status {status}`, `POST tickets/:id/miner {miner_id|null}`,
  `GET files/:id`, `POST form` (public).

## 3. Form on the site

- Page `/support` on pool.bumblebeam.org (pool-web, same look as the pool pages), linked from the footer and from
  a miner's page (`/miners/<address>` → the form with the address filled in).
- Fields: email (required), wallet address (optional, checked against `miners` - an unknown address is kept, the
  ticket just stays unlinked), category, subject, message (≤ 5000 characters). No attachments in the form (mail
  them as a reply).
- **Spam:** Cloudflare Turnstile (the site is behind Cloudflare already; free, no tracking cookies) verified on the
  server, a honeypot field, nginx rate limit per IP (e.g. 3/hour). The form's CSP needs
  `challenges.cloudflare.com` in `script-src` / `frame-src` on `/support` only, not on `/dash`.
- The ticket is created at once (`source = form`, linked to the miner when the address is known), and the customer
  gets a confirmation from support@ with `[BB-<id>]` in the subject, so their answers thread into the ticket.
  The confirmation is short and plain text (anyone can type someone else's email: no content from the form is
  echoed beyond the subject, so it is useless as a spam relay).

## Telegram (@BumbleBeam_bot)

- Variables: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` already exist in `/data/docker/.env` (used by
  `certs-renew.sh` and `nginx-reload.sh`, still empty). Support uses its own `SUPPORT_TELEGRAM_CHAT_ID`, falling
  back to `TELEGRAM_CHAT_ID`, so support can go to a different chat than the cert alerts later.
- Chat id: send `/start` to @BumbleBeam_bot from the operator's account (or add the bot to a group), then
  `curl -s https://api.telegram.org/bot<token>/getUpdates` → `message.chat.id`. The token never goes into git.
- **Events:** new ticket; a customer reply on a ticket; optionally a reminder when a ticket is `new` / `open` with no
  operator reply for 24 h. Not on: operator replies, notes, ignored mail.
- **Message:** plain text, no customer HTML:
  ```
  🆕 BB-42 · payout · form
  ivan@example.com · miner 1a2b…9f0e (3 workers, 41 MH/s, balance 12.3 BEAM)
  Payout not received since Monday
  <first 300 characters of the text>
  https://pool.bumblebeam.org/dash#support/42
  ```
  Customer replies start with `↩️`. Sending is fire-and-forget with a retry; a Telegram outage never blocks import.
- Later, if wanted: answer from Telegram (reply to the bot's message → a reply on the ticket), which needs the
  bot's webhook and an allow-list of operator user ids.

## DNS for bumblebeam.org mail

| Record | State |
|---|---|
| MX | `mail.ultp.org` |
| SPF | `v=spf1 include:ultp.org ~all` → `ultp.org` `a mx` → 135.181.170.61 (mail.ultp.org, PTR matches) |
| DKIM | `dkim._domainkey`, RSA 2048, same key as in mailcow; outgoing mail is signed `d=bumblebeam.org` |
| DMARC | **missing** - add before the form sends confirmations |

```
_dmarc.bumblebeam.org  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@bumblebeam.org; adkim=r; aspf=r"
```

`dmarc@` is an alias, **not** support@ (aggregate reports would become tickets; the importer skips them anyway).
Every mail of the support service and of the form leaves through mailcow, so it passes DKIM aligned with the From
domain. After 2-4 weeks of clean reports: `p=quarantine`, then `p=reject`, and SPF `-all`.

## Deploy

1. mailcow: mailbox `support@bumblebeam.org` + app password (IMAP, SMTP); alias `dmarc@bumblebeam.org`.
2. DNS: `_dmarc` as above. Cloudflare: Turnstile site for pool.bumblebeam.org; a WAF skip for `POST /api/support/form`
   if Browser Integrity Check blocks it.
3. `/data/bumblebeam/secrets/support.env`: IMAP/SMTP user + app password, Turnstile secret, DB password of role
   `support`; `/data/docker/.env`: `TELEGRAM_BOT_TOKEN`, `SUPPORT_TELEGRAM_CHAT_ID`.
4. Postgres: role `support`, schema `support` (migrations run by the service at start, like the pool's `db.rs`).
5. `compose-bumblebeam.yaml`: service `support` (`127.0.0.1:8092:8080`, `/data/bumblebeam/support` for files),
   host nginx `location /api/support/` in `containers/nginx/conf/bumblebeam.conf`, pool-web `/support` page, `/dash` Support tab.

## Phases

| Phase | What | Done when |
|---|---|---|
| 1 | service, IMAP import, tables, reply over SMTP, Support tab (list, thread, reply), Telegram on new mail | a mail to support@ shows in /dash and in Telegram, the reply threads in the customer's client |
| 2 | statuses, notes, miner autolink + card, search, ignore rules | a mail with a known address opens next to that miner |
| 3 | `/support` form, Turnstile, confirmation mail, link from miner pages | a form ticket gets a BB-id mail, the answer to it threads in |
| later | canned replies, 24 h reminder, reply from Telegram, per-operator accounts | as needed |
