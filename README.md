# AI/ML Club - Agent37

**Academic Year:** 2026-2027 Fall Semester  
**Project Duration:** September 2026 - December 2026

## Project Description

A Minecraft Harness for AI agents to learn new skills and imitate player examples

**Key Objectives:**
- AI can understand its position, control bot inputs, open inventory, and change perspectives in <250 ms. 
- Observers can view and takeover the bot's control for imitation learning. 
- AI can generate repeatable skills and improve them over time. 
- Optional: ML pipeline for autonomous optimization

## Lead Contact Information

**Project Lead:** Ben Pham  
📧 Email: ben.pham@sjsu.edu  
💼 LinkedIn: https://www.linkedin.com/in/benpham3206/
📱 Phone: (408) 461-7971  
🏢 Office Hours: Monday/Wednesday: 10 AM - 2 PM, Saturday: 12 - 4 PM. Discord: bingbenbong

## Contributors

*For detailed member information including LinkedIn profiles and Discord handles, see [docs/members.csv](docs/members.csv)*

| Name | Role | Email | GitHub |
|------|------|-------|--------|
| Ben Pham | Project Lead | ben.pham@sjsu.edu | [@benpham3206](https://github.com/benpham3206/) |
| Vikram Arunkumar | Member | vikram.arunkumar@sjsu.edu | [@VikramArunkumar](https://github.com/VikramArunkumar/)  |
| Thinh Nguyen | Member | thinh.nguyen02@sjsu.edu | [@mthinhngn](https://github.com/mthinhngn/) |
| Joshua Yi | Member | joshua.yi01@sjsu.edu | [@joshuajyi](https://github.com/joshuajyi/) |
| Roman Stetsenko | Member | roman.stetsenko@sjsu.edu | [@RomanS545](https://github.com/RomanS545/) |

## Project Kanban Board

**🔗 Public Board:** [Project Agent37](https://github.com/users/benpham3206/projects/2)

## Repository Structure

```
Agent37/
├── README.md
├── .gitignore
├── LICENSE
├── bridge/                     # Core Agent-37 bridge: server.js, arbiter.js, public/ control UI
├── contracts/policy.json       # Shared policy feature contract (used by bridge tests)
├── tools/bridge/               # Launcher, status/inventory/armor HUD, team proxy, start/stop-team.ps1
├── docs/
│   ├── members.csv             # Team member details with LinkedIn & Discord
│   ├── info.json               # Project metadata for website automation
│   ├── thumbnail.webp          # Project thumbnail image
│   └── pitch_slides.pdf        # Project presentation slides
```

## Quick Start Guide

### What you need

- **Node.js (LTS)**, which runs the bots.
- **Git**, to download the code.
- **Java 21**, only if you run your own Minecraft server.

You don't need a Minecraft account to run or control a bot. You only need one to join the server yourself as a player.

### Local Install (solo)

Use this to work on your own laptop with your own server.

1. **Download the code.** This copies the repo to a folder called `Agent37`:
   ```bash
   git clone https://github.com/benpham3206/Agent37.git
   cd Agent37
   ```

2. **Install the bridge's Node packages:**
   ```bash
   cd bridge && npm install && cd ..
   ```

3. **Install the tools' Node packages:**
   ```bash
   cd tools/bridge && npm install && cd ../..
   ```

4. **(Optional) Settings.** Copy `tools/bridge/bridge.env.example` to `bridge.env` and `share-viewer.env.example` to `share-viewer.env`, then fill in your own values. Never commit `.env` files. If `A37_BRIDGE_SERVER` is unset, the launcher uses the in-repo `bridge/server.js`.

5. **Get a Minecraft server.** Make a new folder for it, then download the official 1.21.1 server jar from Mojang into that folder: [minecraft_server.1.21.1.jar](https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar). Rename it to `minecraft_server.1.21.1.jar` if your browser saves it as `server.jar`. The minecraft.net page only offers the newest version, which won't work with our bots.

6. **Run it once.** In that folder, run:
   ```
   java -Xmx4G -Xms4G -jar minecraft_server.1.21.1.jar nogui
   ```
   It stops right away and creates `eula.txt`. That's expected. `-Xmx4G -Xms4G` gives the server 4 GB of memory; use `2G` if your computer has 8 GB or less.

7. **Accept the license.** Open `eula.txt` and change `eula=false` to **`eula=true`**.

8. **Turn on offline mode.** Open `server.properties` and set **`online-mode=false`**. Offline mode lets bots join without a Minecraft account, so only share the address with people you trust.

9. **Start the server again** with the same command, and wait until it prints **Done**.

10. **Start the bots.** On Windows, run `tools/bridge/start-team.ps1` (one bot per entry in `team.json`, plus the team proxy on `127.0.0.1:8800`). Stop them with `stop-team.ps1`. To run one bot: `cd tools/bridge && node run-agent37-bridge.mjs`. Each bot's control page and HUD (inventory, armor, chat) stay on localhost.

### Multiplayer Install (shared dev server)

One person hosts the server and everyone else joins it. Do the local install first.

playit.gg gives your server a public address without changing your router. Offline mode means anyone with that address can join under any name, so keep it private.

### Host:

#### Host the shared server

1. **Set up the server.** Follow steps 5–9 of the local install.
2. **Get playit.** Download the playit agent from [playit.gg/download](https://playit.gg/download) and run it.
3. **Claim it.** The agent opens a link. Sign in and claim the agent.
4. **Add a tunnel.** In the playit dashboard, add a tunnel: **Minecraft Java**, local port `25565`.
5. **Copy the address** it gives you (something like `something.joinmc.link`).
6. **Share it only with teammates** in the team chat.

**Turn on the whitelist** so only your team can join. In the server console, run:
```
whitelist on
whitelist add <name>
```

Only tunnel the Minecraft server. Keep the bot control page and viewer off the tunnel.

The server is only up while your computer and the playit agent are on.

### Players:

#### Join the shared server

1. **Get the address** from the host.
2. **Give your bot its own name** and ask the host to whitelist it. Two bots with the same name can't be on the server at once.
3. **Connect your bot** to that address.

If the host's computer is off, use your local server.

## Recording

Recording starts automatically when a bot first spawns. The bridge samples its observations and actions every 50 ms (nominally 20 rows per second; load can delay timers). Use the control page's Pause, Resume, and Stop buttons to manage recording. Respawning preserves a manual pause or stop. Disconnecting or closing the runtime stops recording and flushes the encounter file.

During normal browser play, each row pairs the latest teacher input with the selected action. Mouse-look deltas are saved before they are consumed and cleared, so recordings retain the turn without applying it again on the next tick. Closing the control page releases controls; recording continues while the bot stays connected.

With the team launcher, JSONL files are saved under `tools/bridge/bridge-data/<bot>/devserver-test/encounters/` by default. Set `A37_DATA_DIR` in your bridge environment configuration to override the data root.

## Something wrong?

| Problem | Try this |
| --- | --- |
| Can't connect to the shared server | Check the address. Ask the host if the server and playit are running. |
| "You are not whitelisted on this server" | Ask the host to run `whitelist add <name>`. |
| "Failed to verify username" | The server needs `online-mode=false` in `server.properties`. Restart it after changing. |
| Bot name already taken | Someone else's bot has that name. Pick another one. |
| Wrong version or protocol error | The server must be **1.21.1**. |
| `java` not found | Install **Java 21**, then open a new terminal. |
| Local server won't start | Set `eula=true` in `eula.txt`. |

## Technology Stack

- **Programming Language:** JavaScript
- **Libraries:** Mineflayer, prismarine-viewer, ONNX Runtime (optional)
- **Development:** Node.js, npm, playit.gg, VS Code
- **Version Control:** Git & GitHub

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- SJSU AI/ML Club

---

**Last Updated:** Oct 13, 2026  
**Next Review:** [Date]

---

*This README follows the AI/ML Club standard template. For questions about the template or suggestions for improvements, contact the club leadership team.*
