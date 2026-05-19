# pi-hashline

A Pi extension that makes file reading, editing, large-file navigation, and shell output more efficient for AI agents.

## Install

```bash
pi install npm:pi-hashline
```

Restart Pi after installation so the replacement tools are registered.

## Requirements

- Pi with extension support
- No required system packages

`rtk` is optional. Without it, `pi-hashline` still provides anchored reads, anchored search, anchored edits, file maps, symbol reads, symbol replacement, hashline write output, and built-in bash output compaction.

## What it does

`pi-hashline` replaces Pi's default `read`, `grep`, `edit`, `write`, `ls`, `find`, and `bash` tools and adds `outline` and `ast_search` navigation tools for agent workflows:

- Safer file edits using anchored read output
- Anchored search results for editing matches without extra reads, with `.gitignore`, include/exclude globs, asymmetric context, and count-only mode
- Deterministic `ls` and `.gitignore`-aware `find` for file exploration without shell noise
- Syntax-aware `ast_search` for TypeScript, TSX/JSX, JavaScript, HTML, and CSS structural patterns
- Write output with fresh anchors for immediate follow-up edits
- Compact maps, symbol reads, and an `outline` tool for navigating large files without loading full contents
- Symbol replacement for supported mapped files, with syntax-regression warnings for JS/TS edits
- Built-in bash output compaction to reduce context usage
- Optional command rewriting through `rtk`
- Built-in prompt guidance so agents know how to use the tools correctly

## File maps

When reading large files, `pi-hashline` can add a compact outline of the file so agents can jump directly to relevant sections instead of scanning the entire file. Agents can also read or replace mapped symbols by name.

Supported languages include TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, C/C++, Java, Kotlin, Swift, Shell, Clojure/EDN, SQL, JSON, Markdown, YAML, TOML, and CSV. File maps are cached in memory and persisted under the user cache directory for faster repeated reads.

## Bash output compaction

Large shell output is compacted before it enters the AI context only when it crosses the normal Pi context-risk threshold: more than 50 KB or more than 2,000 lines. When `rtk` is installed, existing RTK filters such as `rtk log` and `rtk pipe` are tried first and accepted only when important markers are preserved. Otherwise `pi-hashline` falls back to its built-in signal-preserving compactor.

To bypass compaction for a single command:

```bash
PI_HASHLINE_BASH_FULL=1 your-command
```

When compaction is applied, the original full output is saved to a temporary file and its path is included in the tool metadata.

To inspect real comparison data locally:

```bash
bun run compare:bash
```

The generated reference report is in `docs/bash-compaction-comparison.md`.

## Optional RTK support

If [`rtk`](https://github.com/rtk-ai/rtk) is installed, `pi-hashline` can rewrite shell commands before execution.

### macOS

```bash
brew install rtk
rtk --version
rtk gain
```

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
rtk --version
rtk gain
```

### Windows

Native Windows can use `rtk.exe` from the RTK releases page if it is on `PATH`. For best compatibility with shell rewriting, use WSL and follow the Linux instructions inside WSL.

Verify after installation:

```powershell
rtk --version
rtk gain
```

## RTK commands in Pi

```text
/rtk enable
/rtk disable
/rtk status
```

If `rtk` is not installed, normal shell execution is used and bash output compaction still works.
