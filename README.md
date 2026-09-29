# Jev Classifier for Obsidian

Press the **Jev button** in Obsidian's left ribbon to fill the current note's
properties. A single guide note defines each property, its allowed values, and
what those values mean. Settings also includes a large **Classify entire vault**
button for your initial setup.

## Install

1. Download `jev-classifier-0.2.0.zip` from the
   [latest release](https://github.com/ItsBen321/obsidian-jev-classifier/releases/latest)
   and extract it into your vault's `.obsidian/plugins/`
   directory. The result should be `.obsidian/plugins/jev-classifier/main.js`,
   with `manifest.json` and `styles.css` beside it.
2. Restart Obsidian. In **Settings → Community plugins**, enable **Jev Classifier**.
   Community plugins must be enabled in Obsidian.
3. Open **Settings → Jev Classifier** and enter your TypeSafe/Jev API key.
4. Click **Create starter guide**, then edit that note to describe your own
   properties and classifications. Alternatively, choose an existing guide note.
5. Open a note and press the **Jev** ribbon icon. You can also use the command
   palette's **Jev Classifier: Classify current note** or the note's context menu.

If you build from source, the ready-to-copy plugin folder is at `dist/jev-classifier/`.
There is no server to run and no SDK or build tool to install in your vault.
This plugin is installed manually; it is not yet listed in Obsidian's community
plugin directory. A TypeSafe/Jev account with API credits is required.

## Your guide note

Use exactly one fenced `yaml` block containing `properties:`. Prose around the
block is for your own reference; it is not sent as classification instructions.
Property and option descriptions inside the block are the instructions.

```yaml
properties:
  note-type:
    description: The main purpose of this note.
    mode: single
    options:
      idea: A proposed concept or feature to explore.
      reference: Facts or instructions kept for later use.
  topics:
    description: Subjects discussed in meaningful detail, excluding passing mentions.
    mode: multiple
    options:
      programming: Writing, debugging, or maintaining software.
      design: Designing products, interfaces, or creative work.
  tags:
    description: Labels useful for finding the note later.
    mode: multiple
    threshold: 0.8
    options:
      actionable: Has a concrete unfinished task or next step.
      evergreen: Explains a reusable principle or concept.
```

An example result in a note's Obsidian properties:

```yaml
note-type: idea
topics:
  - programming
  - design
tags:
  - actionable
```

- **single** chooses at most one option and writes text. It always includes a
  no-match outcome. Up to 254 user-defined options are supported per single property.
- **multiple** tests every option independently and writes a list. Several values
  can match. This is the default mode if you omit it.
- **tags** is Obsidian's built-in tag property and must use `multiple`. Write tags
  without `#`; nested tags such as `work/project` are supported.
- **threshold** defaults to `0.8` and accepts values from `0.5` to `1`. For single
  properties it checks Choice confidence; for multiple properties it checks the
  label's yes probability. These are different measures. Tune them using your notes.
- Every property and option needs a description. Values come exclusively from
  your guide; Jev does not invent new tags.
- This version fills text and list properties from predefined choices. It does
  not generate summaries, dates, numbers, or arbitrary new property values.

Jev evaluates all property questions together for each note, following TypeSafe's
[Choice](https://docs.typesafe.ai/primitives/choice) and
[Noul](https://docs.typesafe.ai/primitives/noul) guidance and
[HTTP API](https://docs.typesafe.ai/api).

## Existing values

The default **Add and keep existing values** mode keeps filled single properties
and merges list values without exact duplicates. **Replace matching properties**
replaces the values of properties where Jev finds a match. In both modes, no match
leaves the existing property unchanged. Other properties and the note body are
preserved. YAML formatting may change when properties are updated; comments are
retained by the YAML parser where possible.

Malformed frontmatter, incompatible existing list values in Add mode, or malformed
Jev responses result in an error without applying any of that note's classifications.
If you edit or rename a note while Jev is evaluating it, its result is discarded.

## Classify the entire vault

After setting up your guide, use **Classify entire vault** in plugin settings:

1. Review the eligible note count and selected write mode.
2. Press **Start classification**.
3. Watch the active notes, retry status, and progress summary. Individual failures
   are listed at the end.
4. Use **Retry failed / unfinished** to process those notes again without repeating
   notes that completed successfully. This button also works after pressing Stop.

The plugin processes **four notes in parallel** by default. Change **Notes in
parallel** in settings to any value from 1 to 16. Each worker takes another note
as soon as its current note finishes, and each result is saved separately. The
plugin skips the guide, excluded
folders or files, and notes with no body text. Optional exclusions accept one
vault-relative folder or file path per line, such as `Templates` or `Private.md`.
They also apply to individual-note classification.

**Stop classification**, closing the progress window, or disabling the plugin
stops the run. Completed updates remain saved. An already-sent request may still
finish on TypeSafe's servers and use credits, but its cancelled result is ignored.

Connection failures, 60-second request timeouts, HTTP 408/425/429, and server
errors receive **up to three retries** (four attempts total), with increasing
delays and a small random offset. Rate-limit and overload responses pause new
attempts across all workers. A server's `Retry-After` header is respected, even
if it asks for a pause longer than 30 seconds; Stop remains available while waiting.
Higher concurrency may cause more rate limits, so start with the default.

After exhausting retries, that note is recorded as failed and the other notes
continue. Invalid or oversized notes are left for later without pointless
retries. Only API-key/access errors (401/403) and missing credits (402) stop the
whole run and cancel other workers. The failure list shows the reason and the
notes you can retry. Obsidian cannot abort an already-sent network request, so
timed-out attempts may still finish and use credits; their late answers are ignored.

The run captures its guide, settings, and file list when the preview opens.
Close and reopen the preview after editing those settings. Each note's contents
are read just before its request. **Retry failed / unfinished** uses that same
captured guide and settings and resets the progress counter to the remaining
subset. The retry list lasts while the progress window stays open. Closing it or
restarting Obsidian discards that list; starting a fresh vault run evaluates all
eligible notes again, which uses API credits even for notes whose properties do
not change. There is no plugin-specific vault-wide undo; normal
Obsidian file recovery and your own backups remain available if configured.

## Data and credentials

Classification sends the note **title**, **Markdown body**, and **property/option
definitions** directly to `https://api.typesafe.ai/v1/systemone`, using `jev-latest`.
Frontmatter is omitted to avoid feeding previous labels back into the decision.
Attachments and linked notes are not expanded or sent. Notes are never silently
truncated: requests exceeding Jev's limits fail with a notice.

The API key is stored in plain text in this plugin's `data.json`, like many local
Obsidian plugins. Syncing or backing up the plugin folder may copy the key. The
plugin does not log keys or note bodies, and has no telemetry or other backend.
No request is made merely by enabling the plugin or opening its settings.

## Build and test

Use Node.js 22 or later:

```sh
npm ci
npm test
npm run build
```

The build creates `main.js` and `dist/jev-classifier/`. `npm run dev` rebuilds on
changes. Obsidian is an external runtime dependency and is not bundled.

Automated tests cover guide validation, Jev request/response handling, property
merging, content preservation, cancellation, retries, parallel workers, selective
retry controls, vault progress, and the
bundled plugin against a simulated Obsidian API. Actual classification quality
and the Obsidian UI still need a live check with your API key and notes.

### Manual smoke check in Obsidian

- Enable the plugin; verify the Jev ribbon icon and settings page appear.
- Create the starter guide and classify a note with a clear programming idea.
- Confirm list properties and tags appear, and existing body text remains intact.
- Edit a note during classification; its response should not overwrite your edit.
- Run the vault button on a small test vault, stop it, and inspect its summary.
- Try an invalid API key; a vault run should stop after the first rejected request.

Installation layout follows the official
[Obsidian plugin template](https://github.com/obsidianmd/obsidian-sample-plugin).

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses; see
[third-party notices](THIRD-PARTY-NOTICES.txt).
