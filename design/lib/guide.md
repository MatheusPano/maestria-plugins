# Design canvas guide (read once per session)

You draw screens and components as HTML boards. The plugin renders each board with the
project's own Tailwind, in light and dark, and shows it on a canvas beside this session.

## Folder layout (the canvas folder returned by design_open)
- `design.json`: project repo, dark-mode switch, brand css. Adjust it only if renders look wrong.
- `canvas.json`: board index (x, y, w, h, order). Create boards with `design_board`, never by hand.
- `boards/<name>.html`: one board per file. Plain HTML, no scripts, no `<html>`/`<body>` wrapper.
- `components/<Name>.html`: reusable pieces (PascalCase file name).

## Workflow
1. `design_board { name, w }` registers the board and returns the `.html` path.
2. Write or edit that file with Write/Edit. The plugin re-renders on save and the canvas updates.
3. Call `design_render` and LOOK at both the light and dark images. Fix what is wrong and render
   again. Do not tell the user it is done before you checked both themes.
4. `design_focus` points the user's canvas at a board; `design_list` shows boards and components.

## Rules for boards
- Use only the project's Tailwind classes and its color families (listed below by design_open).
  No arbitrary hex colors, no inline styles for color, no invented class names.
- Dark mode: use the project's `dark:` variants or its theme variables; the plugin toggles the
  switch declared in design.json. Check that text stays readable in both.
- Widths: desktop 1440, mobile 390 (tablet 768). Omit `h` to let the height follow the content.
- Copy inside boards is PT-BR. Never put notes, labels or explanations inside a board; explain in
  the chat instead.
- Use realistic content (names, amounts, dates), not lorem ipsum.

## Components
Create `components/Toast.html`, use it as `<x-toast text="Salvo" tone="success"></x-toast>`
(tag = `x-` + kebab-case file name; self-closing `<x-toast />` works too).
- `{{ text }}` is the param, HTML-escaped; `{{{ html }}}` is raw.
- `<slot></slot>` receives the children written between the tags.
- Components can use other components. Editing one re-renders every board that uses it.
- Errors (missing component, unclosed tag, cycle) show up as a board error in design_render.

## Reading results
design_render returns one line per board (size, ms, error or "cortada" when the page is taller
than the image limit) plus the images. A board with an error keeps its previous image on the canvas.
