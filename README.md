# microsoft-presenter-plus

Node.js library for consuming button events from the Microsoft Presenter+ in other programs.

The current scope is intentionally a robust Linux integration via `hidraw`. Browsers and non-Linux operating systems are not supported at this time.

## Installation

```bash
npm install microsoft-presenter-plus
```

## Requirements

- Linux
- Node.js 20 or newer
- Access to `/dev/hidraw*`
- Ideally `udevadm` for more reliable device discovery

Depending on the system, the calling process may need additional permissions to access the HID device. Without those permissions, discovery or opening the device will fail.

## Linux Setup

### Bluetooth Pairing (CLI)

- Put the Microsoft Presenter+ into pairing mode before scanning.
- Then use `bluetoothctl` to pair it from the terminal:

```bash
bluetoothctl
power on
agent on
default-agent
scan on
```

- Look for a device named `Microsoft Presenter+` and note its MAC address.
- Once found, pair, trust, and connect it:

```bash
pair <MAC>
trust <MAC>
connect <MAC>
```

- `trust <MAC>` is required if you want the device to reconnect automatically later.

### Verify Input Devices

- After pairing, check which input nodes were created:

```bash
ls /dev/input/event*
ls /dev/hidraw*
```

- The presenter usually appears as multiple devices.
- This library needs the `hidraw` device for full functionality.

### Grant Access to hidraw Devices

- On most systems, `/dev/hidraw*` is only readable by `root` or a privileged group.
- This library needs read access to those devices.
- Add your user to the `input` group:

```bash
sudo usermod -aG input <username>
```

- Log out and back in after changing group membership.

### udev Rule for Persistent Permissions

- Device permissions often reset after reboot or after the presenter reconnects.
- Add a `udev` rule so matching Presenter+ `hidraw` devices keep the right group and mode.
- Create `/etc/udev/rules.d/99-microsoft-presenter-plus.rules`:

```bash
sudo nano /etc/udev/rules.d/99-microsoft-presenter-plus.rules
```

- Paste this rule:

```udev
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", KERNELS=="0005:045E:0851.*", GROUP="input", MODE="0660"
```

- Reload rules and apply them:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

- Reconnect the presenter after applying the rule.

### Verify Permissions

- Inspect the device nodes:

```bash
ls -l /dev/hidraw*
```

- Expected result:
- the group should be `input`
- the permissions should include group `rw`

### Troubleshooting

- The device path, such as `/dev/hidraw2`, may change between reboots.
- Make sure the correct user is in the `input` group.
- Make sure the Bluetooth connection is active.
- Use `udevadm info -a -n /dev/hidrawX` to inspect attributes when debugging rule matching.

## Quick Start

```ts
import { MicrosoftPresenter } from "microsoft-presenter-plus";

const presenter = await MicrosoftPresenter.connect();

presenter.on("button", (event) => {
  console.log(event.button, event.action, event.timestamp);
});

presenter.on("error", (error) => {
  console.error("Presenter error:", error);
});

process.on("SIGINT", async () => {
  await presenter.stop();
  process.exit(0);
});
```

## Alternative Usage

If your application wants to control discovery explicitly:

```ts
import { discoverPresenter, openPresenter } from "microsoft-presenter-plus";

const device = await discoverPresenter({ debug: true });
const presenter = await openPresenter(device.devicePath);

presenter.on("button", (event) => {
  if (event.button === "mic" && event.action === "press") {
    console.log("Mic pressed");
  }
});
```

If multiple presenters are possible:

```ts
import { listPresenters } from "microsoft-presenter-plus";

const devices = await listPresenters();
console.log(devices);
```

## Example Programs

The repository includes a few small example programs that can be started through npm:

```bash
npm run example:list
npm run example:log
npm run example:open-by-path -- /dev/hidrawX
```

- `example:list` prints all matching Presenter+ devices
- `example:log` auto-discovers one device and logs button events
- `example:open-by-path` opens a specific hidraw device path

## API

### `MicrosoftPresenter.connect(options?)`

Automatically finds a matching device, or uses `options.devicePath`, and starts the reader immediately.

Options:

- `devicePath?: string`
- `debug?: boolean`
- `reportLength?: number`

### `discoverPresenter(options?)`

Returns exactly one detected device. If none or more than one matching device is found, it throws `PresenterDiscoveryError`.

### `listPresenters(options?)`

Returns all matching Presenter+ devices.

### `openPresenter(devicePath, options?)`

Opens a known device directly and starts the reader.

### Events

`button`:

```ts
type PresenterButton = "mic" | "left" | "right" | "light" | "teams";
type PresenterAction = "press" | "release";

interface PresenterEvent {
  button: PresenterButton;
  action: PresenterAction;
  raw: Buffer;
  timestamp: number;
}
```

`error`:

Emitted if the device can no longer be read after startup.

## Platform Limits

This library currently depends on Linux-specific mechanisms:

- scanning `/dev/hidraw*`
- reading `/sys/class/hidraw`
- optionally calling `udevadm info`

Because of that, the library throws `PresenterUnsupportedPlatformError` early on non-Linux systems.
