export const STARTER_GUIDE = `# Jev classification guide

Edit the descriptions and options below to fit your vault. The property names
become Obsidian properties. A single property chooses one value; multiple
properties can receive several values. Use tags for Obsidian's built-in tags.

Only this YAML block defines the rules sent to Jev. Put all instructions that
affect matching in the property or option descriptions. Quote option names such
as "yes", "no", or numbers so they stay readable as text.

\`\`\`yaml
properties:
  note-type:
    description: The main purpose and format of this note.
    mode: single
    threshold: 0.8
    options:
      idea: A proposed concept, possibility, or feature to explore.
      reference: Factual information, explanations, or instructions kept for later use.
      meeting: Notes about a meeting, discussion, attendees, or decisions made together.
      journal: A personal account of experiences, feelings, or reflections.
  topics:
    description: Subjects meaningfully discussed in the note, excluding passing mentions.
    mode: multiple
    threshold: 0.8
    options:
      programming: Writing, understanding, debugging, or maintaining software.
      design: Designing products, interfaces, interactions, or creative work.
      learning: Study methods, practicing skills, courses, or learning plans.
  tags:
    description: Additional labels useful for finding this note later.
    mode: multiple
    threshold: 0.8
    options:
      actionable: Contains a concrete task, next step, or commitment that still needs action.
      evergreen: Explains a reusable concept or principle that remains useful over time.
\`\`\`

## Matching thresholds

The threshold defaults to 0.8. For single properties it checks Jev's choice
confidence; for multiple properties it checks each label's yes probability.
These are starting values: try a few representative notes and adjust the
descriptions and thresholds to suit your material.

No match leaves the existing property unchanged. In the default Add mode,
existing single values are kept and list values are merged without duplicates.
Replace mode replaces a property's values only when Jev finds a match.
`;
