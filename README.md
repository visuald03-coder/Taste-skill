# Taste — same model, one plain sentence, publish-grade output

**Taste** is a skill for AI coding agents — Qoder, Claude Code, Codex, Cursor. One ordinary sentence in, one image out that already clears the bar a brand would publish at — and the same bar holds across a whole batch, not just in the lucky first frame.

Built by [Sure · AI](https://www.sureflow-ai.com) — *Stay On Brand*.

---

## Why the output looks different

Taste is not hiding a better model behind the interface. Ask for `nano-banana-pro` and that is exactly what runs — the same model you can call anywhere. **What differs is what the model is told before it draws.**

| | The bare model | Taste |
| --- | --- | --- |
| What you have to write | Several hundred words of styling instructions — composition, light, material, lens, mood, negatives — and it still misses | One sentence: *"a linen sofa in a wabi-sabi living room, morning light from the left, 3:4"* |
| Where "good" comes from | Whatever the model absorbed; it redefines it every shot | A curated brand-visual knowledge base: **29 documented style branches across 7 product categories** — apparel, beauty & personal care, footwear & bags, sports & outdoor, food & beverage, café, home & furniture |
| What each branch holds | — | An executable visual standard: composition, light, material rendering, lens and camera distance, colour discipline, what must never appear in frame |
| Across a batch of twenty | The first frame is fine, the rest drift | The same shoot, the same brand, twenty frames deep |
| After it returns | Usually a retouch pass, usually a rewrite pass | Usually shipped as-is |

That is the whole pitch: **a high-aesthetic result is normally something you have to describe at length and then curate. Here it is the default, and you spend one sentence to get it.**

## Install

1. Put this folder into your agent's skills directory (Qoder: `~/.qoder-cn/skills/`; Claude Code / Codex / Cursor: anywhere the agent can read `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/`).
2. Copy `config/config.example.json` to `config/config.json`.
3. Say **"install this for me"** — the agent runs its own zero-cost self-check, names the one thing missing if anything is missing, and writes your key into the config itself.

Needs Node.js. No Python, no local model, no GPU.

## Use it

| Intent | Command |
| --- | --- |
| One image | `node scripts/aesthetic-generate.js --prompt "…"` |
| A whole batch, one prompt per line | `… --prompt-file batch.txt` |
| Model and aspect ratio | `… --prompt "…" --model nano-banana-2 --range 16:9` |
| A workbench card that stopped opening (free) | `… --links 9237` |
| Verify the install (free) | `… --check` |

A batch reports `M done / K not done` with the failing line numbers and keeps going; only an invalid key, no credits, or no connection aborts it. Lists hold up to 50 lines. Your images land in **your own preview workbench** under your own account, not scattered across your disk. The list can be typed, or one column copied out of a spreadsheet — this package never reads your spreadsheet account and never asks for its permissions.

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

## Account and cost

- **Bring your own `api_key`**, issued to your Sure account at [sureflow-ai.com](https://www.sureflow-ai.com). You paste it to your agent once; it writes it into the local config and never repeats it back into the conversation, not even a masked fragment.
- **No credential of any kind is committed here.** The endpoint that ships in this repository validates the key server-side, so a public URL is not an open door — an invalid key is rejected before any task is created.
- **Billed per image; a run that fails is not billed.** The count is stated out loud before a batch starts, so nothing is spent without you saying go.

## Not in this version

Reference images are not accepted — the create call drops them server-side, so the interface says so instead of pretending. If you want "the same feel as this picture", write the feel: colour, material, light, composition, camera distance.

**[www.sureflow-ai.com](https://www.sureflow-ai.com)** · Sure turns working production lines into skills you install into your own AI assistant.
