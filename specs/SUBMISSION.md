# ETHGlobal Mumbai: submission and judging rules

Source: ETHGlobal Mumbai "Key Information" page, pasted on Nov 5, 2026. Prize-specific rules are in [TRACKS.md](TRACKS.md).

## Deadline and how to submit

- **Deadline: Sat Nov 7, 2026, 09:00 IST.** Late submissions are not accepted.
- Submit from the **Hacker Dashboard**. The form asks for the title, description and repo link.
- **Partner prizes:** on the last step of the form, pick up to **3 partners**. A partner with several tracks counts as **one** pick, and you're eligible for all of its tracks. Partners judge only from what you select there.
  - For DeRPC: EF is one pick (Anon-RPC and CROPS together), and ENS would be the second if the stretch ships.
- For each partner prize, you must explain how you used or integrated their tools, give feedback, and add comments.

## Two ways to submit

1. **Finalist and partner prizes.** You present to judges in a finalist judging session.
2. **Partner prizes only.** Partners judge from the submission materials.

Presenting at partner booths is optional either way. It's for feedback and networking, not judging.

Strategy note from the Grok chat (based on other ETHGlobal events, not checked for Mumbai): partners judge separately from the finals, and much of the prize money goes to projects that never reach the finals. So deep partner integrations can be worth more than chasing a finals slot.

## Rules

- **Start fresh (Classic "From Scratch" track).** All project work must begin after the hackathon starts. Prior project-specific code, designs or assets are not allowed, except public libraries and starter kits. Projects built before the event can still take part, but they can't win partner prizes or be finalists.
- **Version control.** Submissions with large single commits or a missing history may be disqualified, so commit as you go.
- **Libraries and boilerplates** are allowed, but say which ones you used.
- **Include everything.** The GitHub repo (plus Figma files or similar, if any) must show the work was done during the hackathon. Say clearly what's new and what's reused.

## AI tools

AI tools (ChatGPT, Claude Code, Copilot, Cursor, etc.) are allowed under these conditions:

- **Attribution.** Document where and how AI was used, down to **which parts of the code, which files and which assets** were generated or assisted by AI.
- **Involvement.** AI should assist, not build the whole project. Projects built entirely by AI, without meaningful work from the team, may lose partner-prize and finalist eligibility.
- **Spec-driven development** (OpenSpec, Kiro, spec-kit, etc.) is allowed. If you use it, put **all spec files, prompts and planning artifacts** in the repo. Judges want to see how you directed the AI, not only its output.
  - For DeRPC: `specs/` (including the verbatim AI conversations in `specs/prompts/`) and `AI_USAGE.md` hold these and stay in the repo.

## Finalist judging

- Check in at the judging table. Your session details appear on the Hacker Dashboard after you submit.
- **7 minutes per team: a 4-minute demo, then 3 minutes of Q&A.**
- Common questions:
  - What inspired your project?
  - What tools did you use, and why?
  - What challenges did you solve, and how?
- DeRPC-specific questions to prepare (draft answers):
  - **What inspired it?** The idea path in CONTEXT.md §8, from an RPC directory to "make verification the product".
  - **Why not Helios, Pocket or Lava?** Helios checks answers but doesn't hide who's asking. Pocket and Lava are paid, token-based networks with no query privacy. DeRPC is a free, open-source client that hides the asker and proves the answer.
  - **What if Anon-RPC goes down?** DeRPC fails closed. Reads return an error; RPC and consensus requests never fall back to direct connections. That's demo step 3.

### Finalist judging criteria

| Criterion | What judges ask | DeRPC's answer |
|---|---|---|
| Technicality | How complex is the problem, and how sophisticated is the solution? | Host-side light-client and EIP-1186 verification around a sandboxed, untrusted anonymity worker, plus pinned bootstrap verification and local pool failover |
| Originality | Is it a new idea, or a creative fix for an existing problem? | Anon-RPC hides who asks; DeRPC also proves the answer. The EF lists this as an open idea. |
| Practicality | How complete is it? Could its users use it today? | A drop-in provider for wallets, with Kohaku as the first target |
| Usability (UI/UX/DX) | Is it intuitive and easy to use? | One provider swap; verified or rejected status shown on every read |
| WOW factor | Does it leave a lasting impression? | Live demo: a lying node gets caught and blocked, then the network is killed and DeRPC refuses to leak |

Partner prize winners are announced at the closing ceremony.

## Demo video

Optional, but strongly encouraged. It is featured on the ETHGlobal Showcase.

**Hard limits (the upload fails or you'll be asked to re-submit):**
- [ ] **Between 2 and 4 minutes.** Uploads are rejected automatically otherwise. EF CROPS caps it at **3 minutes**, so aim for 2:00–3:00.
- [ ] **At least 720p.**
- [ ] **Not sped up** to fit the limit.
- [ ] **No music with on-screen text** in place of talking.
- [ ] **Not recorded on a mobile phone.**
- [ ] **No text-to-speech or AI voiceover.**

**Tips:**
- Speak clearly and don't rush.
- Avoid background noise and echo. Use a good mic or a quiet room.
- Keep the intro under 20 seconds.
- Show the project working, and edit out waiting time (for example, tor-js's ~20s startup).
- Use slides for key points, with no more than 4 bullets per slide.

## Past winners, for inspiration

Iris (social on Lens), Splits (route funds to a set of addresses), Ollie Verse (NFT trading card game), Cadbury (censorship-resistant meetings), Umbra (stealth payments), Sunset Supreme (Google Sheets plugin for MultiBaas), DeFi777 (DeFi from any wallet via wrapper tokens), Oya Market (decentralized e-commerce).
