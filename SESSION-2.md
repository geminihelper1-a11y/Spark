# Spark — Session 2

Implemented for NETHRION:

- `sp role <role name> @user @user...` bulk role assignment.
- Role lookup is tolerant of capitalization, emoji/bracket styling, spacing, and minor misspellings. Ambiguous matches are refused instead of guessed.
- `sp rolelist <role>` lists members holding a role, paged in readable chunks.
- `sp report @user <reason>` sends a private report to `🚨-【-reports-】` and stores a small internal case record.
- Automated security incidents now also report to `🚨-【-reports-】`, not `admin-reports`.
- Security is intentionally conservative: common Minecraft/game/platform wording and normal YouTube, Instagram, GIF/clip and image links are not blocked. Only clear invite/deceptive/executable-link signals, strong abusive language matches, or mass-mention abuse are auto-blocked.
- `sp smp-set <java-ip[:port]> [bedrock-ip] [bedrock-port]` configures the SMP source per server.
- Existing `mcStatus` panel data is migrated automatically to the new SMP configuration.
- Live SMP panel uses mcstatus.io and shows Java/Bedrock state, player count, player names when exposed by the server, addresses, and version. It refreshes every 60 seconds.
- `sp server` shows a live Discord activity snapshot (members, online, VC, active text channels, active voice channels, and daily message activity).
- `sp health` remains available for a management-only health snapshot.
- DiscordSRV link-message handling can store/display an exact Minecraft username when the Discord-side link event contains both the member mention and username. `sp link @user MinecraftIGN` is included as a safe manual fallback.
- Activity is kept in memory during normal chat and flushed periodically rather than writing `data.json` on every message.
- Dependency cleanup: removed deprecated `minecraft-server-util`; status checks now use mcstatus.io. Updated discord.js to 14.27.x.
