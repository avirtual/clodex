# plugin-host-engine notes

## register

`opts.shipped` is the LOADER's root (`plugin-loader.js` passes
`rec.root === 'core'`), never a manifest field. Only the loader may widen a
plugin's reach to the seats that have no plugin list — a plugin that could call
itself shipped would grant itself exactly that.

## catalog

`shipped` is a BOOLEAN rather than the loader's root id. Every renderer question
off it is "does an absent seat list reach this", so exporting the root
vocabulary would put the rule `root === 'core'` in a second place to drift.
