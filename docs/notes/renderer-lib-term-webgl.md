## loadWebglIfEnabled
The WebGL addon must be loaded after `terminal.open()`; loading it on an unopened terminal throws.
`onContextLoss` disposes the addon, and xterm then falls back to the DOM renderer on its own.
