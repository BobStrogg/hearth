# Optional: expose Hearth with Cloudflare Tunnel + Access

This puts Hearth at `https://agents.example.com` with no open ports, and Cloudflare Access handles login (free for small
teams). Replace `example.com`, the team name and emails with your own.

1. **Tunnel.** Install `cloudflared` and create a tunnel in Zero Trust, under Networks and then Tunnels. Add a public
   hostname: `agents.example.com` → `http://localhost:7682`. Set the HTTP Host header to `agents.example.com` (or add
   `localhost:7682` to the allowed origins).
2. **Access application.** Create a self-hosted app for `agents.example.com` with a policy that allows only the people
   who should use this machine (for example `Emails: you@example.com`). Copy the app's **AUD tag**.
3. **Configure Hearth** (`~/.hearth/env`), then restart it (macOS:
   `launchctl kickstart -k gui/$(id -u)/io.github.hearth`):
   ```
   HEARTH_ALLOWED_ORIGINS=https://agents.example.com,http://127.0.0.1:7682
   HEARTH_IDENTITY=cloudflare
   HEARTH_CF_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
   HEARTH_CF_AUD=<aud tag>
   HEARTH_PASSWORD=os
   ```
   Hearth verifies `Cf-Access-Jwt-Assertion` on every request and WebSocket. The email in the token becomes the session
   owner, so two people allowed by the same Access app each see only their own sessions.
4. **Several login methods.** If you let people sign in with more than one Access login method (for example the email
   one-time PIN plus GitHub or Google), each method can report a different email, and Hearth would treat them as
   different owners with separate sessions. Map the extra identities onto one canonical identity:
   ```
   HEARTH_USER_ALIASES=you@gmail.com=you@example.com,you-github@example.com=you@example.com
   ```
   or `hearth service install --user-aliases "you@gmail.com=you@example.com"`. Only add identities that the Access
   policy already allows; an alias grants exactly the canonical user's sessions. For GitHub logins the email is the
   account's primary verified email.
5. **Several machines.** Give each machine its own hostname and Access app (for example `laptop-agents` and
   `desktop-agents`), each with the policy you want, and its own `HEARTH_CF_AUD`.

Tips:
- Require a passkey or hardware key in the Access policy, because agents can run commands as you.
- Keep sessions short (for example 12h). The Hearth password unlock adds a second factor tied to the machine.
