# HUD Lyrics

Synced lyrics for the song the car plays (Apple Music or Spotify over CarPlay), one line at a time, meant for
the head-up display. iDrive 7 · package `amn_hudlyrics` · version 0.1.0 (step 1).

## Step 1 (this version)

The centre screen shows the song, its artist, the time in it, what LRCLIB has for it, and the lyric line
playing. Nothing is drawn on the HUD or the cluster yet. The HUD comes in step 2.

## What it uses

- **Car:** reads the track from BMW's MediaPlayer, CarPlayManager, HmiMediaState and DynamicMediaPlayer
  interfaces. It subscribes and reads only; it never writes a value or calls a method.
- **Internet:** one host, `lrclib.net`, through the Store's uplink. `net/http.js` refuses any other host.
- **Log:** the track's title, artist and timing, and the lyrics lookup's result. No other value from the car.
- **No** accounts, album art, analytics or crash-report uploads.

## Settings

- **Lines shown:** One line (default) or two lines, the next one dim.
- **Lyrics timing:** moves the lyrics up to 3 s earlier or later.
- **Colours.**

## Credits

Built from [arefahmad/idrive7-apps](https://github.com/arefahmad/idrive7-apps)' Car Lyrics (MIT): `car/nowplaying.js`,
`net/http.js` and the clock in `main.js`. `stage/lyrics.js` is from nickgcode's G's Music (MIT, `LICENSE`). See
the repository's NOTICE.
