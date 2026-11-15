# idrive7-apps

Apps for BMW head units with **iDrive 7** (MGU), installed from the car through
[robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store).

| App | What it does |
|---|---|
| [HUD Lyrics](apps/amn_hudlyrics/README.md) | Synced lyrics for the song playing over CarPlay, one line at a time in the head-up display (experimental, off until switched on), and a Now Playing page on the centre screen. |

## Install

1. In the Store: **Settings > Add source**, type `M850i-amn/idrive7-apps`, pick **Branch main**.
2. Pick **HUD Lyrics** and tap **Install**. The head unit builds it from this repository.
3. Restart the head unit once (Store **Settings > Restart head unit**).

Needs root access, mgu-store, the Store's **Cluster renderer** tool for the HUD, and internet through the Store's uplink for the lyrics.

## Safety

Read-only toward the car: it subscribes to and reads signals, and never writes, codes, clears or controls
anything. One internet host: `lrclib.net`. No accounts, analytics or crash-report uploads.

## Credits

See [NOTICE.md](NOTICE.md). Built on arefahmad, nickgcode, cauliflowermossgrape and robertnisipeanu's work (MIT).

Unofficial. Not made, endorsed or supported by BMW. Use at your own risk.
