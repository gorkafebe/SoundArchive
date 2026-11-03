# Design

Design material for Sound Archive's interface.

- [UI_RESEARCH_AND_BRIEF.md](UI_RESEARCH_AND_BRIEF.md): research on existing
  sound maps, map and listening patterns, recording and permissions, and
  accessibility, plus the design brief. Done on 2026-11-02.
- [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md): what the first
  interface (phase 3 foundations, 2026-11-03) implements, which rules of the
  brief it keeps, and what changes when the design arrives.

The visual design is made with the owner in Claude Design: a design system
(colours, type, spacing, components) and a canvas with the screens. Until it
is ready, the web app uses **provisional tokens** in
`web/src/styles/tokens.css` (calm and natural: warm background, grey-green
text, one moss accent). When the design is done, this folder will also hold
the exported design tokens, screenshots, the component list and a link to the
canvas, and `tokens.css` is replaced (see IMPLEMENTATION_NOTES.md, section 3).
