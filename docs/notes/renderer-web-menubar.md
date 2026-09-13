# renderer/web/menubar.js

## pluginsTopMenu

The single source of "is the top-level Plugins menu showing?". The bar (which
inserts and removes that menu) and the `File > Plugins…` fallback row both read
it, so they cannot disagree and show both routes or neither. The fallback exists
because the top-level menu is absent by its null rule at zero plugins — the state
a fresh install is in — and there the Manage Plugins dialog's "Open Plugins
Folder" button is the only way to install a first plugin.

## buildMenus

Window mirrors `app-menus.js`'s split of managed sandbox boxes out of the peer
list: a box's peer id IS its box id (`sandbox.js` registerPeer), so registry ids
∩ peer ids marks them, and Peers keeps only genuine remotes. A box gets a peer
status row once first started and keeps it until deleted, so a never-started seed
box appears nowhere but the panel. `Manage Clodex Sandboxes…` is always-on for
that case, mirroring the always-on `Manage Peered Clodexes…` above it.
