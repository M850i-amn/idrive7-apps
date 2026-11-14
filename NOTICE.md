# Notice

This repository builds on, and keeps the licences of:

- **arefahmad/idrive7-apps** (MIT, `LICENSE.arefahmad`): Car Lyrics' track reader, network client and clock.
- **nickgcode/idrive7-apps** (MIT, `kit/LICENSE.nickgcode`, `apps/amn_hudlyrics/LICENSE`): the MGU App Kit as
  used here, and the LRCLIB lyrics client. The HUD drawing layer (step 2) will come from G's Music.
- **cauliflowermossgrape/idrive7-apps** (MIT, `kit/LICENSE.idrive7-apps`): the MGU App Kit.
- **robertnisipeanu** (mgu-store, cluster-render): the Store and the cluster/HUD renderer, used as installed.

Changes to the kit: the encrypted crash-log uploader (`remotelog.js`, `ringlog.js`, `x25519.js`) is removed,
and `kit/runtime/mgu.js` no longer loads it.

No BMW code or SDK is in this repository. `oap-sdk/` and `dist/` are never committed.
