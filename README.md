# Taste — publish-grade imagery from one plain-language prompt

**Taste** is a skill for AI coding agents — Qoder, Claude Code, Codex, Cursor. You describe the shot you want in one ordinary sentence; you get an image that already clears the bar a brand would publish at, and the same bar holds across a whole batch instead of only in the lucky first frame.

Built by [Sure · AI](https://www.sureflow-ai.com) — *Stay On Brand*.

---

## The problem this solves

A general model can make a pretty picture. What it cannot do reliably is make **twenty** pictures that look like they came from the same shoot, on the same brand, at a quality you can ship without a retouch pass. The gap is not the model — it is that nobody told the model what "good" means for your category.

Taste closes that gap with a curated brand-visual knowledge base sitting behind the generation step: **29 documented style branches across 7 product categories** — apparel, beauty & personal care, footwear & bags, sports & outdoor, food & beverage, café, home & furniture — each branch written up as an executable visual standard (composition, light, material rendering, lens and camera distance, colour discipline, what must never appear in frame). Every prompt you send is resolved against that standard, so the output lands at a Pinterest-grade level of polish from the first pass rather than after three rounds of "make it look expensive".

## What you actually type

Nothing close to a prompt-engineering template.

```
a linen sofa in a wabi-sabi living room, morning light from the left, 3:4
```

That is a complete instruction. Colour, material, light, composition and aspect can all be stated the way you would say them to a photographer; the skill turns them into the specification the generation step needs.

## Install

1. Put this folder into your agent's skills directory.
   - Qoder: `~/.qoder-cn/skills/`
   - Claude Code / Codex / Cursor: anywhere the agent can read `SKILL.md`, `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/`
2. Copy `config/config.example.json` to `config/config.json`.
3. Say **"install this for me"**. The agent runs its own zero-cost self-check, tells you the one thing missing if there is anything missing, and writes your key into the config for you.

Requires Node.js. No Python, no local model, no GPU.

## Usage

| Intent | Command |
| --- | --- |
| Verify the install (free) | `node scripts/aesthetic-generate.js --check` |
| One image | `node scripts/aesthetic-generate.js --prompt "…"` |
| A whole batch, one prompt per line | `node scripts/aesthetic-generate.js --prompt-file batch.txt` |
| Pick the model and the aspect ratio | `node scripts/aesthetic-generate.js --prompt "…" --model nano-banana-2 --range 16:9` |
| A workbench card that stopped opening | `node scripts/aesthetic-generate.js --links 9237` — free, no new task |

**On batches.** One line is one task. A line that fails does not stop the run: you get `M done / K not done` with the failing line numbers, and you re-run only those. Only three conditions abort a batch — an invalid key, no credits, no connection — and each is stated in one plain sentence. A list holds up to 50 prompts; past that the script stops and asks you to split rather than silently overrunning.

**Where the images go.** Into your own preview workbench under your own account, not scattered across your disk. Each line reports its task number as it completes; that number is all you need later if a card needs refreshing.

**Where the list comes from.** A txt you typed, or one column copied out of a spreadsheet — Feishu, Excel, anything. Either way it becomes a one-line-per-prompt txt before it runs. This package never reads your spreadsheet account and never asks for its permissions.

## Showcase

<table>
  <tr>
    <td><img src="assets/showcase-01.jpg" width="330"></td>
    <td><img src="assets/showcase-02.jpg" width="330"></td>
    <td><img src="assets/showcase-03.jpg" width="330"></td>
  </tr>
  <tr>
    <td><img src="assets/showcase-04.jpg" width="250"></td>
    <td><img src="assets/showcase-05.jpg" width="330"></td>
    <td><img src="assets/showcase-06.jpg" width="250"></td>
  </tr>
</table>

Representative output at default settings.

## Account, cost, and what is not in this repository

- **Bring your own `api_key`**, issued to your Sure account at [sureflow-ai.com](https://www.sureflow-ai.com). You paste it to your agent once; it writes it into the local config itself and never repeats it back into the conversation, not even a masked fragment.
- **No credential of any kind is committed here.** The service endpoint that ships in `config/config.example.json` and the generation script validates the key server-side, so a public URL is not an open door — an invalid key is rejected before any task is created.
- **Billed per image; a run that fails is not billed.** Before a batch starts, the count is stated out loud, so nothing is spent without you saying go.

## Not in this version

Reference images are not accepted. The create call drops them server-side, so the interface says so instead of pretending: if you want "the same feel as this picture", describe the feel — colour, material, light, composition, camera distance.

## About Sure · AI

Sure turns working production lines into skills you install into your own AI assistant: images, video, resizing, and the content tooling around them. Per-image pricing, failed runs not billed, output kept inside your own account.

**[www.sureflow-ai.com](https://www.sureflow-ai.com)**
