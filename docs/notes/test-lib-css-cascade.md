# docs/notes/test-lib-css-cascade.md

## winningDeclaration

Resolves which CSS rule wins a property, so a source-shape pin can assert what
the BROWSER does rather than that a rule is present in the file. Two rules that
shipped in the t961 chrome layer were present, correct and outranked — doing
nothing at all: `.dialog-head h3 { margin: 0 }` at (0,1,1) under `#dialog h3` at
(1,0,1), and `#dialog label.agent-check input { height: auto }` under a later
`#dialog input`. A substring pin on either read green.

## matchesChain

Supports descendant combinators, ids, classes, `[attr="value"]` and tag names.
A selector carrying `:`, `>`, `+` or `~` is SKIPPED, which is safe in one
direction only: the skipped rule could have been the winner, so a skip yields a
false pass, never a false red. Callers therefore assert on the returned
`selector` as well as its value — a resolver that stopped seeing the real winner
reports a different one by name.

## specificity

Weights ids 10000, classes/attributes 100, tags 1, and `winningDeclaration`
breaks ties by source position. Longhands are not expanded: `margin` and
`margin-bottom` resolve independently, and a caller that cares about the gap
below a title must ask for both — `#args-dialog h3 { margin-bottom: 8px }` is a
longhand that a weaker `margin` shorthand cannot override.
