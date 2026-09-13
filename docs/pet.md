# Alfred Codex Pet

Alfred is a custom Codex pet packaged at `/Users/pablo/.codex/pets/alfred`.

The pet uses the official 8 column by 9 row Codex atlas contract:

| Row | State | Frames |
| --- | --- | ---: |
| 0 | idle | 6 |
| 1 | running-right | 8 |
| 2 | running-left | 8 |
| 3 | waving | 4 |
| 4 | jumping | 5 |
| 5 | failed | 8 |
| 6 | waiting | 6 |
| 7 | running | 6 |
| 8 | review | 6 |

Design notes:

- Compact pixel-art elderly gentleman butler.
- Silver side-parted hair, narrow gray mustache, warm eyebrows.
- Black tailcoat and waistcoat, white shirt, bow tie, gloves, polished shoes.
- Small silver tray with porcelain teacup.
- No Batman marks, text, scene, shadows, or detached effects.

Generated QA artifacts are kept in `assets/pet/`:

- `pet.json`
- `spritesheet.webp`
- `contact-sheet.png`
- `idle-preview.gif`

The source run used the hatch-pet deterministic pipeline at `/private/tmp/alfred-pet-run`.
Validation passed with exact `1536x1872` WebP output, no atlas errors, and zero transparent RGB residue pixels.
