# Notice

This repository builds on, and keeps the licences of:

- **arefahmad/idrive7-apps** (MIT, `LICENSE.arefahmad`): Car Lyrics' track reader, network client and clock.
- **nickgcode/idrive7-apps** (MIT, `kit/LICENSE.nickgcode`, `apps/amn_hudlyrics/LICENSE`): the MGU App Kit as
  used here, the LRCLIB lyrics client, and the HUD layer (`apps/amn_hudlyrics/hud/`, from G's Music 0.8.0), changed
  for a one-line mode and the HUD's measured visible window.
- **cauliflowermossgrape/idrive7-apps** (MIT, `kit/LICENSE.idrive7-apps`): the MGU App Kit.
- **robertnisipeanu** (mgu-store, cluster-render): the Store and the cluster/HUD renderer, used as installed.

- **Inter** (SIL Open Font License 1.1, `apps/amn_hudlyrics/data/fonts/LICENSE-Inter.txt`): the centre screen's type.

Changes to the kit: the encrypted crash-log uploader (`remotelog.js`, `ringlog.js`, `x25519.js`) is removed,
and `kit/runtime/mgu.js` no longer loads it. The unused `gif_drop.js` (phone-to-car GIFs through ntfy.sh) is removed.

No BMW code or SDK is in this repository. `oap-sdk/` and `dist/` are never committed.
