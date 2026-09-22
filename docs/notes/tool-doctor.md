# tool-doctor.js

## TOOL_SPECS

`muse` is a bash launcher (`https://api.meta.ai/muse-launcher.sh`, launcher_version 3), not the binary: on first run it downloads the real binary beside itself as `<dir>/muse-bin-<ver>` plus `.muse-version`, `.muse-release-info.json` and `.muse-update-checked-at`, so the install dir is the dir of the resolved launcher and must stay writable by the running user (else `MUSE_NO_AUTO_UPDATE=1`). The Linux x86 binary is ~300 MB, sha256-checked by the launcher; channel `muse-stable` is public, so the download needs no auth. `MUSE_LAUNCHER_INSTALL=1` fetches without starting a session; `MUSE_LOGIN=0` disables the device-login fallback (images and the deploy script set it, the desktop remedy does not, so the visible install session may sign in). Credentials live at `$XDG_CONFIG_HOME/muse/auth.json` (default `~/.config/muse/`), not `~/.muse` — that is the path the sandbox and peer box persist.
