# console-tab

Notes for `renderer/console-tab.js`. Facts the code cannot state; everything
provable by a test lives in `test/console-truth.test.js` instead.

## `contentSig` / `repaintGrown`

A backgrounded call's record is re-served on every poll and GROWS as its
`.output` file is appended to, so identity dedupe alone paints it once with
whatever existed at the first poll and never updates -- a long job goes blind
after ~1.2s. The dedupe that causes this is deliberate: it is what stops a
re-served timestamp group from double-painting, so the repaint is keyed on a
content signature and the identity set is left alone. Dropping the key from
`lastKeys` instead reopens the double-paint hole.

`st.blocks` and `bodyEl`'s children are appended and trimmed together in
`appendNew`, which is what lets `repaintGrown` use one index for both.

## `tick`

Sequenced, not `Promise.all`. `pullLive` filters against the settled set that
`pull` populates; run concurrently, the filter can read that set before the
record settling a call lands in it, and the call then draws in both lanes for
one tick -- its finished block and its live preview at once.
