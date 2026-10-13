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

### Prerequisites
- Python 3.10 or higher
- Git
- PyTorch
- ONNX

### Local Install (solo)

Use this to work on your own laptop with your own server.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/benpham3206/Agent37.git
   cd Agent37
   ```

2. **Create virtual environment:**
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Install Node packages:**
   ```bash
   npm install
   ```

5. **Run a local Minecraft 1.21.1 server** in offline mode, then start your bot pointed at `localhost:25565`.

### Multiplayer Install (shared dev server)

Use this to join the team server hosted on Ben's PC. Do the local install first.

1. **Install Tailscale** from [tailscale.com/download](https://tailscale.com/download) and sign in.
2. **Accept Ben's share invite** for the server machine.
3. **Get the server address** from Ben (port `25565`).
4. **Point your bot at that address** and give it your own name so it doesn't clash with other bots.

The server is only up while Ben's PC is on. If it's down, use your local server.

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
