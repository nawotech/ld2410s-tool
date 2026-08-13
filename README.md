# LD2410S Studio

A cross-platform visualiser and configurator for the HLK-LD2410S mmWave presence sensor,
replacing the Windows-only `HLK-LD2410S_TOOL.exe`. Runs in any Chromium browser via the
Web Serial API — no install, no driver, no Wine.

## Running

```sh
./serve.sh          # http://localhost:8000
```

Open the URL and press **Connect**, then pick the sensor's serial port.

Web Serial requires a *secure context*, so opening `index.html` as a `file://` URL will not
work — it must be served over `localhost` (or HTTPS). Chrome, Edge, Opera and Arc support
Web Serial; Firefox and Safari do not.

## What it shows

- **Presence, distance, and update rate**, live.
- **Per-gate energy against the trigger and hold thresholds**, on one shared dB axis.
  Drag any threshold point to edit it, then press **Write**. This is the view the vendor
  tool makes hardest to read, and it is the one that actually explains false triggers.
- **Distance timeline** over the last 60 s with an occupancy strip.
- **CSV export** of recorded frames, including all 16 raw gate energies.

## Files

| File | Purpose |
|---|---|
| `ld2410s.js` | Protocol codec and transport. No dependencies, no DOM — reusable in Node. |
| `index.html` | UI, charts, and controls. |
| `serve.sh` | Static server on localhost. |

## Protocol notes

Implemented from *HLK-LD2410S serial communication protocol V1.00* and verified against
hardware running firmware **V1.1.1**. Port is 115200 8N1, all fields little-endian.

Two framings share the wire:

```
command   FD FC FB FA | len(2) | word(2) | payload | 04 03 02 01
data      F4 F3 F2 F1 | len(2) | type(1) | payload | F8 F7 F6 F5
minimal   6E | state(1) | distance(2) | 62
```

`state` is 0/1 = unoccupied, 2/3 = occupied. Distance is in cm. ACK frames set bit 8 of the
command word (`0x0071` → `0x0171`), followed by a 2-byte status where 0 means success.
Every configuration command must be bracketed by enable-config (`0x00FF`) and end-config
(`0x00FE`).

By default the module emits only the minimal frame. Sending output-mode `0x007A` with value
`01 00` switches it to the standard frame, which adds the 16 per-gate energies.

### The energy scale is dB — this is undocumented

The standard frame carries 16 × `uint32` gate energies with raw values spanning roughly
0–130000, while the trigger and hold thresholds are stored as small integers around 20–50.
They look incommensurable, and the spec never relates them. They are the same quantity: the
thresholds are in decibels.

```
energy_dB = 10 * log10(raw)
```

Measured on an idle room, per-gate `10·log10(raw)` lands within about 1 dB of each gate's
factory trigger threshold:

| gate | raw median | 10·log₁₀(raw) | factory trigger |
|---:|---:|---:|---:|
| 1 | 13666 | 41.4 | 42 |
| 3 | 2303 | 33.6 | 34 |
| 4 | 1406 | 31.5 | 32 |
| 7 | 1222 | 30.9 | 31 |

This is what lets energy and thresholds share one axis, and it matches the vendor tool's
own `EnergyWaveWnd_ValueDisplayMax="100"` in `appConfig.xml`.

### Common parameters

Read/written as (2-byte word + 4-byte value) pairs. The response order mirrors the request
order, so the codec asks for a fixed list and unpacks positionally.

| Parameter | Word | Range | Notes |
|---|---|---|---|
| Status report frequency | `0x02` | 0.5–8 Hz | transported as Hz × 10 |
| Max distance gate | `0x05` | 1–16 | |
| Unmanned delay | `0x06` | 10–120 s | |
| Min distance gate | `0x0A` | 0–16 | |
| Response speed | `0x0B` | 5 = normal, 10 = fast | |
| Distance report frequency | `0x0C` | 0.5–8 Hz | transported as Hz × 10 |

One gate is 0.7 m, so the 16 gates span 11.2 m and the factory max gate of 12 gives the
advertised 8.4 m.

### Firmware version reply is longer than documented

The spec describes the `0x0000` reply as 2-byte major + minor + patch. Firmware V1.1.1
actually returns **10** bytes after the ACK: 4 leading bytes (observed `00 80 00 00`) and
then the three version `uint16`s. The codec skips the leading 4.

### Drain the port while writing

If you send commands without continuously reading, the USB-serial driver buffer overflows
and the stream corrupts — during testing this produced 16 KB of garbage in which the module
appeared to re-emit its enable-config ACK every 18 bytes. The browser read loop drains
continuously, so this only bites hand-written scripts.

## Not implemented

- Firmware update (`ICLM_Upgrade.dll`), which uses a separate bootloader protocol.
- Writing the serial number (`0x0010`), read-only here to avoid bricking identity.
