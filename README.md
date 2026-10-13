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
├── requirements.txt
├── .gitignore
├── LICENSE
├── docs/
│   ├── members.csv             # Team member details with LinkedIn & Discord
│   ├── info.json               # Project metadata for website automation
│   ├── thumbnail.webp          # Project thumbnail image
│   └── pitch_slides.pdf        # Project presentation slides
└── [additional_folder]/
```

## Quick Start Guide

### What you need

- **Python 3.10 or newer**, for the ML code.
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

2. **Make a Python environment.** This keeps the project's Python packages separate from the rest of your computer:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install the Python packages:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Install the Node packages**, which the bots need:
   ```bash
   npm install
   ```

5. **Get a Minecraft server.** Go to [minecraft.net/download/server](https://www.minecraft.net/en-us/download/server), pick version **1.21.1**, and save `server.jar` in its own folder.

6. **Run it once.** In that folder, run:
   ```bash
   java -Xmx2G -jar server.jar nogui
   ```
   It stops right away and creates some files. That's expected.

7. **Accept the license.** Open `eula.txt` and change `eula=false` to **`eula=true`**.

8. **Turn on offline mode.** Open `server.properties` and set **`online-mode=false`**. Offline mode lets bots join without a Minecraft account, so only use it on your own machine or a private network.

9. **Start the server again** with the same command, and wait until it prints **Done**.

10. **Start your bot** (see the bot's folder) and point it at `localhost:25565`.

### Multiplayer Install (shared dev server)

One person hosts the server and everyone else joins it. Do the local install first.

Tailscale is a private network between your computers. Nothing is open to the internet.

#### Host the shared server

1. **Set up the server.** Follow steps 5–9 of the local install to get a 1.21.1 server running in offline mode.
2. **Install Tailscale** from [tailscale.com/download](https://tailscale.com/download) and sign in.
3. **Get your Tailscale address.** Run this and copy the number it prints:
   ```bash
   tailscale ip -4
   ```
4. **Let teammates in through Tailscale only.** On Windows, open **PowerShell as administrator** and run:
   ```powershell
   New-NetFirewallRule -DisplayName "Agent37 MC 25565" -Direction Inbound -Protocol TCP -LocalPort 25565 -RemoteAddress 100.64.0.0/10 -Action Allow
   ```
   This opens port 25565 to Tailscale addresses only, not the internet.
5. **Share the machine.** In the [Tailscale admin console](https://login.tailscale.com/admin/machines), go to **Machines**, pick the server machine, click **Share**, and enter each teammate's email.
6. **Send teammates your Tailscale address.** They'll use it with port `25565`.

The server is only up while your computer is on.

#### Join the shared server

1. **Install Tailscale** from [tailscale.com/download](https://tailscale.com/download) and sign in with any account.
2. **Accept the invite.** Open the share email from the host and click **Accept**.
3. **Give your bot its own name.** Two bots with the same name can't be on the server at once.
4. **Connect your bot** to the host's Tailscale address on port `25565`.

If the host's computer is off, use your local server.

## Something wrong?

| Problem | Try this |
| --- | --- |
| Can't connect to the shared server | Check that Tailscale is on and shows the host's computer. Then ask the host if the server is up. |
| "Failed to verify username" | The server needs `online-mode=false` in `server.properties`. Restart it after changing. |
| Bot name already taken | Someone else's bot has that name. Pick another one. |
| Wrong version or protocol error | The server must be **1.21.1**. |
| `java` not found | Install **Java 21**, then open a new terminal. |
| Local server won't start | Set `eula=true` in `eula.txt`. |

## Technology Stack

- **Programming Language:** JavaScript, Python
- **ML/AI Libraries:** Mineflayer, prismarine-viewer, ONNX Runtime, PyTorch
- **Development:** Node.js, npm, Tailscale, VS Code
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
