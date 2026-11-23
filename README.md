# mend — one patch tool for every AI edit format

`mend` is a command-line tool that applies the edits AI models write, in all four
formats they write them in, to a tree of text files — every file or none. It was
built for the [hidden-spec-cli bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fynix39/hidden-spec-cli/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fynix39/hidden-spec-cli/reward.svg)

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-` (the default) to read the patch from stdin.
Node 22 and its standard library only — no dependencies, no network.

Options:

- `--format=<unified|search_replace|v4a|json>` — force a format instead of
  detecting it from the patch text.
- `--check` — report what would change, and write nothing.
- `--strict` — match lines exactly only (tier 0, no whitespace forgiveness).
- `--help` — print usage.

## The four formats

- **Unified diff** — `diff --git` / `---` / `+++` sections with `@@` hunks.
  Hunks are matched by content, not by their (often wrong) line numbers: the
  nearest occurrence to the stated position wins, and a running drift keeps
  later hunks in step as earlier ones change the file's length. Create,
  delete and move are supported, including `new file mode` /
  `deleted file mode` / `rename from` / `rename to` headers, and
  `\ No newline at end of file` is honoured.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`.
  The path comes from the nearest non-blank, non-fence line above the block,
  or the block inherits the previous block's path. A block whose old lines
  occur more than once is ambiguous and fails.
- **V4A patches** — `*** Begin Patch` / `*** End Patch` framing with
  `*** Add File`, `*** Delete File` and `*** Update File` sections, `*** Move
  to:` renames, `@@` chunks with anchors and a moving cursor, and
  `*** End of File` anchoring.
- **JSON edits** — `str_replace`, `insert`, `create` and `delete` tool calls,
  as one JSON object, an array, or one object per line.

## Matching

An edit's old lines are matched at the first tier that has an occurrence:

0. **Exact** — byte for byte.
1. **Trailing whitespace** — trailing spaces and tabs ignored.
2. **Leading and trailing whitespace** — the line's indentation may drift too.
   At tier 2 the new lines are re-indented: the old block's leading whitespace
   is replaced by the matched lines' leading whitespace (blank lines are
   written as they are).

Files keep their own line breaks (LF or CRLF) and their own trailing
whitespace; a file without a final line break stays that way unless an edit
changes its last line.

## Output and exit codes

- `0` — every edit applied. One line per changed file (`A`, `M`, `D`, or
  `R old -> new`, sorted by path), then `ok: N file(s)`.
- `1` — one or more edits failed (`missing`, `exists`, `unsafe`, `no-match`,
  `ambiguous`). Every failing edit is reported, then `failed: F of N edits`.
  Nothing is written.
- `2` — usage, format, or parse error (`error: usage`, `error: format`,
  `error: parse <line>`). Nothing is written.

## Layout

- `main.ts` — the CLI.
- `runner.ts` — the trial runner, kept exactly as the kit ships it.
- `LICENSE` — MIT.

## Testing

The kit's 100 practice checks pass 100/100, and 148 additional hand-written
checks cover the specification sentences the practice set does not show —
parse-error line numbers, every exit-1 code, tier-2 re-indentation edge
cases, CRLF and no-final-line-break handling, empty-old insertion at the
boundaries, V4A anchors and cursor movement, End-of-File chunks, move
output ordering, `--check`, `--strict`, usage errors and format forcing.

Built with make.fun — https://make.fun/r/jvcw07av
